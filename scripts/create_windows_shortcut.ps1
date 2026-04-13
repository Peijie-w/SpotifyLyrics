param()

$ErrorActionPreference = "Stop"

$desktopPath = [Environment]::GetFolderPath("Desktop")
$projectDir = Split-Path -Parent $PSScriptRoot
$shortcutPath = Join-Path $desktopPath "Spotify Floating Lyrics.lnk"
$targetPath = Join-Path $PSScriptRoot "launch_windows.vbs"
$electronIconPath = Join-Path $projectDir "node_modules\electron\dist\electron.exe"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $projectDir
$shortcut.WindowStyle = 7
$shortcut.Description = "Launch Spotify Floating Lyrics"

if (Test-Path $electronIconPath) {
  $shortcut.IconLocation = $electronIconPath
}

$shortcut.Save()

Write-Output "Created shortcut: $shortcutPath"
