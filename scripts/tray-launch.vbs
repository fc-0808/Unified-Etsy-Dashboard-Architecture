' ─────────────────────────────────────────────────────────────────────────────
'  Unified Etsy Dashboard — Silent Tray Icon Launcher
'
'  Installed into the Windows Startup folder by install-autostart.ps1 so the
'  system-tray icon appears immediately after every login — no terminal needed.
'
'  This runs tray.ps1 via powershell.exe with -WindowStyle Hidden so no
'  console window ever appears.  The PowerShell process stays alive in the
'  background, running the Windows Forms message loop that owns the tray icon.
'
'  To stop the tray:  right-click the orange "E" tray icon → Exit Tray
' ─────────────────────────────────────────────────────────────────────────────

Dim fso, shell, scriptDir, psScript

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript  = scriptDir & "\tray.ps1"

' Window style 0 = hidden.  False = fire-and-forget (don't block login).
shell.Run "powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File """ & psScript & """", 0, False

Set shell = Nothing
Set fso   = Nothing
