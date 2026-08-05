' Launches the supervisor with no console window.
'
' Task Scheduler runs the task in the interactive session, so plain "node.exe"
' would pop a console window into the user's face at every logon and stay there.
' WScript.Shell.Run with intWindowStyle 0 starts it hidden; output still reaches
' backend\logs\monitor-<date>.log.
'
' The node path is passed in as an argument by install-autostart.ps1, resolved
' once at install time. An earlier version looked it up here with
' shell.Exec("cmd /c where node.exe") - and .Exec ALWAYS shows a console window,
' with no way to hide it. Since the task re-fires every five minutes, that put a
' cmd window on screen every five minutes, forever. .Run is the only one of the
' two that can be hidden, and it cannot capture output, so the lookup had to go.

Option Explicit

Dim shell, fso, here, backend, node

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
backend = fso.GetParentFolderName(here)

If WScript.Arguments.Count > 0 Then
  node = WScript.Arguments(0)
Else
  ' Fall back to PATH resolution, which Run does for us.
  node = "node.exe"
End If

shell.CurrentDirectory = backend
shell.Run """" & node & """ """ & fso.BuildPath(here, "supervisor.js") & """", 0, False
