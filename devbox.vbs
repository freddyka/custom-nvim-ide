' devbox – startet die App ohne sichtbares Konsolenfenster.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = appDir
sh.Run "cmd /c """"" & appDir & "\node_modules\.bin\electron.cmd"" .""", 0, False
