param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("status", "control")]
  [string]$Mode,

  [ValidateSet("previous", "next", "toggle")]
  [string]$Action = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Await-WinRtOperation {
  param(
    [Parameter(Mandatory = $true)]$AsyncOperation,
    [Parameter(Mandatory = $true)][Type]$ResultType
  )

  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq "AsTask" -and
      $_.IsGenericMethodDefinition -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } |
    Select-Object -First 1

  if (-not $asTaskMethod) {
    throw 'Unable to locate WinRT AsTask(IAsyncOperation`1) overload.'
  }

  $task = $asTaskMethod.MakeGenericMethod(@($ResultType)).Invoke($null, @($AsyncOperation))
  return $task.GetAwaiter().GetResult()
}

function Await-WinRtBooleanOperation {
  param([Parameter(Mandatory = $true)]$AsyncOperation)

  return [bool](Await-WinRtOperation -AsyncOperation $AsyncOperation -ResultType ([bool]))
}

function Get-SpotifySession {
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await-WinRtOperation `
    -AsyncOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    -ResultType ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
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

function Get-StatusErrorType {
  param([Parameter(Mandatory = $true)][string]$Message)

  $normalizedMessage = $Message.ToLowerInvariant()

  if (
    $Message.Contains('指定的服务未安装') -or
    $normalizedMessage.Contains('service has not been started') -or
    $normalizedMessage.Contains('service cannot be started') -or
    $normalizedMessage.Contains('specified service') -or
    $normalizedMessage.Contains('service not installed')
  ) {
    return 'windows-media-service-unavailable'
  }

  return 'windows-media-session-failed'
}

function Invoke-Bridge {
  $session = Get-SpotifySession

  if (-not $session) {
    return @{ running = $false; state = "stopped" }
  }

  if ($Mode -eq "status") {
    $properties = Await-WinRtOperation `
      -AsyncOperation ($session.TryGetMediaPropertiesAsync()) `
      -ResultType ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $timeline = $session.GetTimelineProperties()
    $startMs = [int][Math]::Round($timeline.StartTime.TotalMilliseconds)
    $endMs = [int][Math]::Round($timeline.EndTime.TotalMilliseconds)
    $durationMs = [Math]::Max(0, $endMs - $startMs)

    return @{
      running = $true
      state = Get-PlaybackState -Session $session
      title = [string]$properties.Title
      artist = [string]$properties.Artist
      album = [string]$properties.AlbumTitle
      durationMs = $durationMs
      positionMs = [int][Math]::Round($timeline.Position.TotalMilliseconds)
      sourceAppUserModelId = [string]$session.SourceAppUserModelId
    }
  }

  $success = $false

  switch ($Action) {
    "previous" { $success = Await-WinRtBooleanOperation ($session.TrySkipPreviousAsync()) }
    "next" { $success = Await-WinRtBooleanOperation ($session.TrySkipNextAsync()) }
    "toggle" { $success = Await-WinRtBooleanOperation ($session.TryTogglePlayPauseAsync()) }
    default { $success = $false }
  }

  return @{
    ok = [bool]$success
    reason = if ($success) { "" } else { "command-failed" }
  }
}

try {
  $result = Invoke-Bridge
} catch {
  $message = $_.Exception.Message

  if ($Mode -eq "status") {
    $result = @{
      running = $false
      state = "error"
      title = ""
      artist = ""
      album = ""
      durationMs = 0
      positionMs = 0
      error = $message
      errorType = Get-StatusErrorType -Message $message
    }
  } else {
    $result = @{
      ok = $false
      reason = "windows-media-session-failed"
      error = $message
    }
  }
}

$result | ConvertTo-Json -Compress
