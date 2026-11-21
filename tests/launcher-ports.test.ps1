$ErrorActionPreference = 'Stop'

# Load only the production helper declarations. Do not launch or close Codex.
$launcher = Join-Path $PSScriptRoot '..\scripts\launch-codex-wallpaper.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $launcher, [ref]$tokens, [ref]$errors
)
if ($errors.Count) { throw ($errors | Out-String) }
$helpers = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -in @('Get-CodexDevToolsEndpoint', 'Find-DevToolsPort')
}, $true)
foreach ($helper in $helpers) {
    Invoke-Expression $helper.Extent.Text
}

$script:occupied = @()
$script:responses = @{}
function Write-LauncherLog { param($Message) }
function Get-NetTCPConnection {
    param($State, $LocalPort, $ErrorAction)
    if ($LocalPort -in $script:occupied) {
        [pscustomobject]@{ OwningProcess = 999999 }
    }
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $TimeoutSec)
    $port = ([Uri]$Uri).Port
    if (-not $script:responses.ContainsKey($port)) { throw 'Simulated timeout' }
    [pscustomobject]@{ StatusCode = 200; Content = $script:responses[$port] }
}
function Assert-Equal {
    param($Actual, $Expected, [string]$Label)
    if ($Actual -ne $Expected) { throw "$Label expected '$Expected', got '$Actual'" }
}

Assert-Equal (Find-DevToolsPort 12230) 12230 'Free preferred port'
$script:occupied = @(12230)
Assert-Equal (Find-DevToolsPort 12230) 12231 'Orphaned listener fallback'
$script:responses[12230] = '<html>Another local service</html>'
Assert-Equal (Find-DevToolsPort 12230) 12231 'Invalid JSON service fallback'
$script:responses[12230] = '[{"type":"page","url":"https://example.com"}]'
Assert-Equal (Find-DevToolsPort 12230) 12231 'Non-app page fallback'
$script:responses[12230] = '[{"type":"page","url":"app://-/index.html"}]'
Assert-Equal (Find-DevToolsPort 12230) 12230 'Existing app endpoint reuse'
$script:occupied = @(65535)
$threw = $false
try { Find-DevToolsPort 65535 | Out-Null } catch { $threw = $true }
Assert-Equal $threw $true 'Exhausted range error'
Write-Output 'PASS: six launcher port and endpoint scenarios'
