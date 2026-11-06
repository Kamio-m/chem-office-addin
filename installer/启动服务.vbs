' Chem Tools - background launcher (also registers the Office add-in)
' Registry format: under ...\WEF\Developer, a VALUE named by the manifest's
' <Id> (3f2b9c4e-...), whose data is the manifest path. Plus RefreshAddins=1
' so Office reloads the add-in list on next start.
' NOTE: keep this file pure ASCII - VBScript reads it as ANSI.

Option Explicit

Dim sh, fso, basePath, exePath, manifestPath, devKey, i, ver, versions
Dim addinId

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

basePath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
' exe file name is non-ASCII: build it from code points (HUA XUE GONG JU)
exePath = basePath & ChrW(21270) & ChrW(23398) & ChrW(24037) & ChrW(20855) & ".exe"
manifestPath = basePath & "manifest.xml"

If Not fso.FileExists(manifestPath) Then
  WScript.Quit 1
End If

' Must match <Id> inside manifest.xml
addinId = "3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23"
versions = Split("16.0;14.0", ";")

' ---- 1) Register add-in (value name = add-in Id, data = manifest path) ----
For i = 0 To UBound(versions)
  ver = versions(i)
  devKey = "HKEY_CURRENT_USER\Software\Microsoft\Office\" & ver & "\WEF\Developer"
  On Error Resume Next
  sh.RegWrite devKey & "\" & addinId, manifestPath, "REG_SZ"
  sh.RegWrite devKey & "\RefreshAddins", 1, "REG_DWORD"
  On Error GoTo 0
Next

' ---- 2) Remove legacy shared-folder catalog (pointed to an outdated manifest) ----
On Error Resume Next
sh.RegDelete "HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{7C3D9E21-4A55-4B2F-9E1C-2B6A8D4F0C11}\"
On Error GoTo 0

' ---- 3) Start the service with a hidden window ----
If Not fso.FileExists(exePath) Then
  WScript.Quit 1
End If
sh.Run """" & exePath & """ --silent", 0, False
