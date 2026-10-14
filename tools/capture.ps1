param(
  [string]$Out = (Join-Path $PSScriptRoot '..\scratch\shot.png'),
  [string]$ProcessName = 'ChatGPT'
)
Add-Type -AssemblyName System.Drawing
$sig = @'
using System;
using System.Runtime.InteropServices;
public class U32P {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing
$p = Get-Process $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "no $ProcessName window"; exit 1 }
[U32P]::ShowWindow($p.MainWindowHandle, 9) | Out-Null  # SW_RESTORE (no focus steal)
Start-Sleep -Milliseconds 400
$r = New-Object U32P+RECT
[U32P]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Output "bad rect"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [U32P]::PrintWindow($p.MainWindowHandle, $dc, 2)  # PW_RENDERFULLCONTENT
$g.ReleaseHdc($dc)
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$bmp.Save($Out)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out ($w x $h) printwindow=$ok"
