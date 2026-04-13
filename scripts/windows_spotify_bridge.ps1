param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("status", "control")]
  [string]$Mode,

  [ValidateSet("previous", "next", "toggle")]
  [string]$Action = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Await-WinRt {
  param([Parameter(Mandatory = $true)]$AsyncOperation)

  $asyncType = $AsyncOperation.GetType()
  $resultType = $asyncType.GenericTypeArguments[0]
  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1

  $genericMethod = $asTaskMethod.MakeGenericMethod($resultType)
  $task = $genericMethod.Invoke($null, @($AsyncOperation))
  return $task.GetAwaiter().GetResult()
}

function Get-SpotifySession {
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync())
  $session = $null

  foreach ($candidate in $manager.GetSessions()) {
    if ($candidate.SourceAppUserModelId -match "Spotify") {
      $session = $candidate
      break
    }
  }

  if (-not $session) {
    $current = $manager.GetCurrentSession()
    if ($current -and $current.SourceAppUserModelId -match "Spotify") {
      $session = $current
    }
  }

  return $session
}

function Get-PlaybackState {
  param([Parameter(Mandatory = $true)]$Session)

  $status = $Session.GetPlaybackInfo().PlaybackStatus.ToString()

  switch ($status) {
    "Playing" { return "playing" }
    "Paused" { return "paused" }
    default { return "stopped" }
  }
}

$session = Get-SpotifySession

if (-not $session) {
  @{ running = $false; state = "stopped" } | ConvertTo-Json -Compress
  exit 0
}

if ($Mode -eq "status") {
  $properties = Await-WinRt ($session.TryGetMediaPropertiesAsync())
  $timeline = $session.GetTimelineProperties()
  $startMs = [int][Math]::Round($timeline.StartTime.TotalMilliseconds)
  $endMs = [int][Math]::Round($timeline.EndTime.TotalMilliseconds)
  $durationMs = [Math]::Max(0, $endMs - $startMs)

  @{
    running = $true
    state = Get-PlaybackState -Session $session
    title = [string]$properties.Title
    artist = [string]$properties.Artist
    album = [string]$properties.AlbumTitle
    durationMs = $durationMs
    positionMs = [int][Math]::Round($timeline.Position.TotalMilliseconds)
    sourceAppUserModelId = [string]$session.SourceAppUserModelId
  } | ConvertTo-Json -Compress
  exit 0
}

$success = $false

switch ($Action) {
  "previous" { $success = Await-WinRt ($session.TrySkipPreviousAsync()) }
  "next" { $success = Await-WinRt ($session.TrySkipNextAsync()) }
  "toggle" { $success = Await-WinRt ($session.TryTogglePlayPauseAsync()) }
  default { $success = $false }
}

@{
  ok = [bool]$success
  reason = if ($success) { "" } else { "command-failed" }
} | ConvertTo-Json -Compress
