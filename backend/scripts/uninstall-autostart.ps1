# Stops the monitor and removes its scheduled task.
#
# Unregistering the task does not touch a supervisor that is already running, so
# the running process is stopped first - otherwise the service would carry on
# polling with nothing left to manage it.

$ErrorActionPreference = 'Stop'

$backend = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $backend 'logs\supervisor.pid'
$taskName = 'ZainDataPoolMonitor'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
} else {
    Write-Host "No scheduled task '$taskName' registered."
}

if (Test-Path $pidFile) {
    $supervisorPid = (Get-Content $pidFile -Raw).Trim()
    # Killing the supervisor's tree takes server.js with it; killing the
    # supervisor alone would leave the server orphaned but still polling.
    & taskkill.exe /PID $supervisorPid /T /F 2>&1 | Out-Null
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "Stopped supervisor (pid $supervisorPid) and server.js."
} else {
    Write-Host "No supervisor pid file - nothing running to stop."
}
