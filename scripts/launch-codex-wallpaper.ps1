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

function Get-CodexDevToolsEndpoint {
    param([int]$Candidate)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Candidate/json/list" -TimeoutSec 1
        if ($response.StatusCode -ne 200) { return $null }
        $pages = @($response.Content | ConvertFrom-Json)
        if ($pages | Where-Object { $_.type -eq 'page' -and $_.url -like 'app://-/*' }) {
            return "http://127.0.0.1:$Candidate/json/list"
        }
    }
    catch {
        return $null
    }
    return $null
}

function Find-DevToolsPort {
    param([int]$Preferred)
    for ($candidate = $Preferred; $candidate -le [Math]::Min(65535, $Preferred + 100); $candidate++) {
        $occupied = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue
        if (-not $occupied) { return $candidate }
        if (Get-CodexDevToolsEndpoint $candidate) { return $candidate }
        Write-LauncherLog "Port $candidate is occupied without a responding Codex endpoint; trying the next port."
    }
    throw "No available local DevTools port found near $Preferred."
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

    if (-not $activePort -and (Get-CodexDevToolsEndpoint $Port)) {
        $activePort = $Port
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

        $activePort = Find-DevToolsPort $Port

        Write-LauncherLog "Launching Codex $($package.Version) with DevTools on 127.0.0.1:$activePort."
        Start-Process -FilePath $codexExe -ArgumentList @(
            '--remote-debugging-address=127.0.0.1',
            "--remote-debugging-port=$activePort"
        ) | Out-Null
    }
    else {
        Write-LauncherLog "Reusing Codex with DevTools on 127.0.0.1:$activePort."
    }

    $endpoint = "http://127.0.0.1:$activePort/json/list"
    $ready = $false
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            if (Get-CodexDevToolsEndpoint $activePort) {
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

