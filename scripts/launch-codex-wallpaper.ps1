[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 12230,

    [switch]$SkipBridge
)

$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $HOME '.chatgpt-wallpaper'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$launcherLog = Join-Path $stateRoot 'codex-launcher.log'

function Write-LauncherLog {
    param([string]$Message)
    Add-Content -LiteralPath $launcherLog -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message)
}

function Show-LauncherError {
    param([string]$Message)
    Write-LauncherLog "ERROR: $Message"
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            "$Message`n`nLog: $launcherLog",
            'Codex + Wallpaper',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error
        ) | Out-Null
    }
    catch {
        # Logging still preserves the error when the desktop UI is unavailable.
    }
}

try {
    Write-LauncherLog 'Launcher started.'

    $mainProcesses = Get-CimInstance Win32_Process -Filter "name='ChatGPT.exe'" |
        Where-Object { $_.CommandLine -notmatch '--type=' }

    $activePort = $null
    foreach ($process in $mainProcesses) {
        if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
            $activePort = [int]$Matches[1]
            break
        }
    }

    if ($mainProcesses -and -not $activePort) {
        throw 'Codex is already running without the wallpaper connection. Fully quit it from the system tray, then open "Codex + Wallpaper" again.'
    }

    if (-not $activePort) {
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

        $occupied = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
        if ($occupied) {
            throw "Port $Port is already in use by process $($occupied.OwningProcess). Choose another port or stop that process."
        }

        Write-LauncherLog "Launching Codex $($package.Version) with DevTools on 127.0.0.1:$Port."
        Start-Process -FilePath $codexExe -ArgumentList @(
            '--remote-debugging-address=127.0.0.1',
            "--remote-debugging-port=$Port"
        ) | Out-Null
        $activePort = $Port
    }
    else {
        Write-LauncherLog "Reusing Codex with DevTools on 127.0.0.1:$activePort."
    }

    $endpoint = "http://127.0.0.1:$activePort/json/list"
    $ready = $false
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $endpoint -TimeoutSec 1
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        }
        catch {
            # Codex may still be starting.
        }
    }

    if (-not $ready) {
        throw "Codex started, but its local DevTools endpoint did not appear at $endpoint."
    }

    if (-not $SkipBridge) {
        $bridgeScript = Join-Path $bridgeRoot 'src\bridge.mjs'
        if (-not (Test-Path -LiteralPath $bridgeScript)) {
            throw "Wallpaper bridge was not found at: $bridgeScript"
        }

        $nodeExe = (Get-Command node -ErrorAction Stop).Source
        $stdoutLog = Join-Path $stateRoot 'launcher-bridge.log'
        $stderrLog = Join-Path $stateRoot 'launcher-bridge.err.log'

        Start-Process -FilePath $nodeExe `
            -ArgumentList @('src/bridge.mjs', 'start') `
            -WorkingDirectory $bridgeRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog | Out-Null
        Write-LauncherLog 'Wallpaper bridge started in the background.'
    }

    Write-LauncherLog 'Launcher finished successfully.'
}
catch {
    Show-LauncherError $_.Exception.Message
    exit 1
}

