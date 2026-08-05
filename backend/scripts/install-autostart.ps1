# Registers the data pool monitor to start by itself.
#
# Two triggers, because either one alone leaves a gap:
#   - At logon  : covers the normal case, and starts it now-ish after a reboot.
#   - Every 5 m : a repeating trigger that does nothing when the task is already
#                 running, so if both the supervisor and the machine were killed
#                 outright the service comes back without anyone logging in to
#                 nurse it.
#
# Runs as the current user - no administrator rights and no stored password.
# Re-running this script is safe; it replaces the existing task.

$ErrorActionPreference = 'Stop'

$backend = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start-hidden.vbs'
$taskName = 'ZainDataPoolMonitor'

if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }

# Resolve node once, here, and bake the path into the task. The launcher used to
# look it up itself with WScript.Shell.Exec, which always shows a console window
# - so every 5-minute trigger flashed a cmd window on screen.
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node.exe' }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument "`"$launcher`" `"$node`"" -WorkingDirectory $backend

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$heartbeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName `
    -Action $action -Trigger @($atLogon, $heartbeat) `
    -Settings $settings -Principal $principal `
    -Description 'Polls CBS every second and sends data pool threshold SMS.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Host "Registered and started scheduled task '$taskName'."
Write-Host "  Runs as       : $env:USERDOMAIN\$env:USERNAME (no admin rights needed)"
Write-Host "  Starts        : at logon, and re-checked every 5 minutes"
Write-Host "  Logs          : $(Join-Path $backend 'logs')"
$port = (Select-String -Path (Join-Path $backend '.env') -Pattern '^PORT=(\d+)' | Select-Object -First 1).Matches.Groups[1].Value
if (-not $port) { $port = '5005' }
Write-Host "  Health check  : http://localhost:$port/api/health"
Write-Host ""
Write-Host "Stop it with  : .\scripts\uninstall-autostart.ps1"
