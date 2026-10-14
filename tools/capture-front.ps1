param(
  [string]$Out = (Join-Path $PSScriptRoot '..\scratch\shot.png'),
  [string]$ProcessName = 'ChatGPT'
)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$sig = @'
using System;
using System.Runtime.InteropServices;
public class U32F {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing, System.Windows.Forms
$p = Get-Process $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "no $ProcessName window"; exit 1 }
[U32F]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
# foreground-lock workaround: tap Alt, then set foreground
[U32F]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[U32F]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 150
[U32F]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 1200
$fg = [U32F]::GetForegroundWindow()
$r = New-Object U32F+RECT
[U32F]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$bmp.Save($Out)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out ($w x $h) foreground=$($fg -eq $p.MainWindowHandle)"
