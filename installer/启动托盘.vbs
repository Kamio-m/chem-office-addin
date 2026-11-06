' Launch the Chem Tools tray silently (no console window).
' Runs tray.ps1 with hidden window so nothing flashes on screen.
Option Explicit

Dim sh, dir, cmd
Set sh = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "tray.ps1"""
sh.Run cmd, 0, False
