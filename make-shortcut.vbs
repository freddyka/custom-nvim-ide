Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
desktop = sh.SpecialFolders("Desktop")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(desktop & "\devbox.lnk")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = """" & appDir & "\devbox.vbs"""
lnk.WorkingDirectory = appDir
ico = appDir & "\assets\icon.ico"
If fso.FileExists(ico) Then lnk.IconLocation = ico
lnk.Description = "devbox - Terminal-Grid + Browser"
lnk.Save
WScript.Echo "shortcut: " & desktop & "\devbox.lnk"
