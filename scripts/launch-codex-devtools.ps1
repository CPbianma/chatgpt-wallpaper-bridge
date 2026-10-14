[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 12230,

    [switch]$SkipBridge
)

$ErrorActionPreference = 'Stop'

Write-Warning 'This launcher enables an unauthenticated Chrome DevTools endpoint on 127.0.0.1.'
Write-Warning 'Other processes running as your Windows user may inspect or control the Codex page while it is enabled.'

$mainProcesses = Get-CimInstance Win32_Process -Filter "name='ChatGPT.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' }

if ($mainProcesses) {
    throw 'Codex is still running. Fully quit it from the system tray, confirm ChatGPT.exe is gone, and run this launcher again.'
}

$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
    Sort-Object Version -Descending |
    Select-Object -First 1

if (-not $package) {
    throw 'The OpenAI.Codex Windows package was not found.'
}

$codexExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $codexExe)) {
    throw "Codex executable was not found at: $codexExe"
}

$occupied = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($occupied) {
    throw "Port $Port is already in use by process $($occupied.OwningProcess)."
}

Write-Host "Launching Codex $($package.Version) with DevTools on 127.0.0.1:$Port ..."
Start-Process -FilePath $codexExe -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$Port"
) | Out-Null

$endpoint = "http://127.0.0.1:$Port/json/list"
$ready = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $endpoint -TimeoutSec 1
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        # Codex may still be starting.
    }
}

if (-not $ready) {
    throw "Codex started, but the DevTools endpoint did not appear at $endpoint. The installed build may ignore this Chromium flag."
}

Write-Host "DevTools endpoint is ready: $endpoint"

if ($SkipBridge) {
    return
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$bridgeScript = Join-Path $repoRoot 'src\bridge.mjs'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$dataDir = Join-Path $env:LOCALAPPDATA 'ChatGPT-Wallpaper'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

Start-Process -FilePath $nodeExe `
    -ArgumentList @($bridgeScript, 'start') `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dataDir 'devtools-launch.log') `
    -RedirectStandardError (Join-Path $dataDir 'devtools-launch.err.log') | Out-Null

Start-Sleep -Seconds 3
& $nodeExe $bridgeScript status

Write-Host ''
Write-Host 'Fully quit Codex and launch it normally to disable the DevTools endpoint.'
