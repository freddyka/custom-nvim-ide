Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
desktop = sh.SpecialFolders("Desktop")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = appDir & "\dist\win-unpacked\devbox.exe"
Set lnk = sh.CreateShortcut(desktop & "\devbox.lnk")
If fso.FileExists(exePath) Then
  ' gepackte .exe (eigenes Icon eingebettet)
  lnk.TargetPath = exePath
  lnk.WorkingDirectory = fso.GetParentFolderName(exePath)
  lnk.IconLocation = exePath & ", 0"
Else
  ' Fallback: Dev-Launcher
  lnk.TargetPath = "wscript.exe"
  lnk.Arguments = """" & appDir & "\devbox.vbs"""
  lnk.WorkingDirectory = appDir
  ico = appDir & "\assets\icon.ico"
  If fso.FileExists(ico) Then lnk.IconLocation = ico
End If
lnk.Description = "devbox - my custom IDE"
lnk.Save
WScript.Echo "shortcut: " & desktop & "\devbox.lnk -> " & lnk.TargetPath
