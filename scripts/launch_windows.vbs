Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fso.BuildPath(scriptDir, "launch_windows.bat")

shell.CurrentDirectory = fso.GetParentFolderName(scriptDir)
shell.Run """" & launcherPath & """", 0, False
