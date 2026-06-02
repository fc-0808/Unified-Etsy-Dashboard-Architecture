' ─────────────────────────────────────────────────────────────────────────────
'  Unified Etsy Dashboard — Silent Desktop Shortcut Launcher
'
'  This file is the TARGET of the "Etsy Dashboard" shortcut on the Desktop
'  and in the Start Menu.  Running it via wscript.exe (the default for .vbs)
'  means Windows will NEVER show a black console window — the dashboard just
'  opens in your browser.
'
'  What it does:
'   1. Locates start-dashboard.ps1 relative to its own position (scripts\)
'   2. Runs it silently via powershell.exe -WindowStyle Hidden
'   3. start-dashboard.ps1 handles health-check, PM2 start, and browser open
'
'  The shortcut itself is created by  scripts\install-autostart.ps1.
'  You should never need to run this file directly.
' ─────────────────────────────────────────────────────────────────────────────

Dim fso, shell, scriptDir, psScript

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' This file lives in  <ProjectRoot>\scripts\
' start-dashboard.ps1 is in the same folder.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript  = scriptDir & "\start-dashboard.ps1"

' Run PowerShell hidden (window style 0) — non-blocking (False = don't wait)
shell.Run "powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File """ & psScript & """", 0, False

Set shell = Nothing
Set fso   = Nothing
