[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Name = 'Codex + Wallpaper',

    [switch]$NoDesktop,

    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path -Parent $PSScriptRoot
$launcherScript = Join-Path $PSScriptRoot 'launch-codex-wallpaper.ps1'
$programsRoot = [Environment]::GetFolderPath('Programs')
$startMenuDir = Join-Path $programsRoot 'Codex Wallpaper Bridge'
$startMenuLink = Join-Path $startMenuDir "$Name.lnk"
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk"

if ($Uninstall) {
    foreach ($path in @($startMenuLink, $desktopLink)) {
        if ((Test-Path -LiteralPath $path) -and $PSCmdlet.ShouldProcess($path, 'Remove shortcut')) {
            Remove-Item -LiteralPath $path -Force
        }
    }
    if ((Test-Path -LiteralPath $startMenuDir) -and
        -not (Get-ChildItem -LiteralPath $startMenuDir -Force -ErrorAction SilentlyContinue) -and
        $PSCmdlet.ShouldProcess($startMenuDir, 'Remove empty Start menu folder')) {
        Remove-Item -LiteralPath $startMenuDir -Force
    }
    Write-Host 'Codex wallpaper launcher shortcuts removed.'
    exit 0
}

if (-not (Test-Path -LiteralPath $launcherScript)) {
    throw "Launcher script was not found at: $launcherScript"
}

$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
    Sort-Object Version -Descending |
    Select-Object -First 1
if (-not $package) {
    throw 'The Microsoft Store version of Codex was not found.'
}

$codexExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $codexExe)) {
    throw "Codex executable was not found at: $codexExe"
}

$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $launcherScript
$shell = New-Object -ComObject WScript.Shell

function New-CodexWallpaperShortcut {
    param([string]$Path)

    if (-not $PSCmdlet.ShouldProcess($Path, 'Create Codex wallpaper launcher shortcut')) {
        return
    }

    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $powershellExe
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $bridgeRoot
    $shortcut.IconLocation = "$codexExe,0"
    $shortcut.Description = 'Start Codex and ChatGPT Wallpaper Bridge together'
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}

New-CodexWallpaperShortcut $startMenuLink
if (-not $NoDesktop) {
    New-CodexWallpaperShortcut $desktopLink
}

Write-Host 'Codex wallpaper launcher installed:'
Write-Host "  Start menu: $startMenuLink"
if (-not $NoDesktop) {
    Write-Host "  Desktop:    $desktopLink"
}
Write-Host 'Use this shortcut instead of the normal Codex icon. No administrator rights are required.'

