; 化学工具 — Word/Excel/PowerPoint 加载项安装包
; 编译：ISCC.exe installer\chem-addin.iss
; 安装内容：本地服务 exe + 加载项清单；写入 Office 加载项注册表项与开机自启

#define AppName "化学工具"
#define AppVersion "1.4.0"
#define AppPublisher "Chem Tools"
#define AddinId "3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23"

[Setup]
AppId={{3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\ChemOfficeAddin
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\installer
OutputBaseFilename=化学工具安装包
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
CloseApplications=no
RestartApplications=no
UninstallDisplayIcon={app}\化学工具.exe
UninstallDisplayName={#AppName}
; 关闭安装后自动启动程序页面（我们在 [Run] 里显式控制）

[Languages]
Name: "chs"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "开机自动启动化学工具服务（推荐，否则每次用前要手动打开）"; GroupDescription: "启动选项："

[Files]
Source: "..\化学工具.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\manifest.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "修复加载项.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "启动服务.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "tray.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "启动托盘.vbs"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; 清理旧版本遗留、现在已不再使用的文件（升级时自动删掉，避免安装目录越堆越乱）
Type: files; Name: "{app}\启用自动加载.bat"
Type: filesandordirs; Name: "{app}\catalog"
; 旧 AppId（1.2.0 及更早）的卸载器，对应的卸载项同时会清掉，否则控制面板会出现两个「化学工具」
Type: files; Name: "{app}\unins000.exe"
Type: files; Name: "{app}\unins000.dat"

[Registry]
; 注册 Word/Excel/PPT 加载项。
; 关键：注册格式是「值名 = GUID、值数据 = manifest 路径」，直接放在 Developer 键下，
; 而不是建同名子键——子键形式 Office 不认（这就是之前功能区不出现的原因）。
; RefreshAddins=1 让 Office 立即重新加载加载项列表。
Root: HKCU; Subkey: "Software\Microsoft\Office\16.0\WEF\Developer"; ValueType: string; ValueName: "{#AddinId}"; ValueData: "{app}\manifest.xml"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Office\16.0\WEF\Developer"; ValueType: dword; ValueName: "RefreshAddins"; ValueData: "1"
Root: HKCU; Subkey: "Software\Microsoft\Office\14.0\WEF\Developer"; ValueType: string; ValueName: "{#AddinId}"; ValueData: "{app}\manifest.xml"; Flags: uninsdeletevalue
; 开机自启（可选任务）—— 启动托盘：图标常驻任务栏，服务随托盘自动拉起
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ChemOfficeAddin"; ValueData: "wscript.exe ""{app}\启动托盘.vbs"""; Tasks: autostart; Flags: uninsdeletevalue

[Icons]
; 桌面 / 开始菜单：启动托盘（任务栏右下角出现图标，右键可启停服务）
Name: "{group}\化学工具（任务栏图标）"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动托盘.vbs"""; IconFilename: "{app}\化学工具.exe"; Comment: "任务栏常驻图标：启停服务、打开面板"
Name: "{group}\只启动服务（无托盘）"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动服务.vbs"""; IconFilename: "{app}\化学工具.exe"; Comment: "仅在后台启动本地服务，不显示托盘图标"
Name: "{group}\卸载化学工具"; Filename: "{uninstallexe}"
; 用户桌面（不是公共桌面）：低权限安装也能写进去，公共桌面需要管理员
Name: "{userdesktop}\化学工具"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动托盘.vbs"""; IconFilename: "{app}\化学工具.exe"; Comment: "任务栏常驻图标：启停服务、打开面板"

[Run]
; 安装完成后调用 VBS：写注册表 + 隐藏窗口启动托盘（托盘会顺带拉起服务）。
Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动托盘.vbs"""; Flags: nowait runhidden; StatusMsg: "正在注册加载项并启动托盘…"

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM 化学工具.exe /F"; Flags: runhidden; RunOnceId: "StopService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// 双保险：声明式 [Registry] 之外，安装结束时再用 API 写一次加载项注册表项，
// 避免个别环境下声明式写入未生效；卸载时同步清理。
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  // 覆盖 exe 前先结束正在运行的本地服务，否则安装程序会卡在
  // "Closing applications..."（文件被占用）
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM 化学工具.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    // 清理旧版「共享文件夹」注册项（会让 Word 加载旧 manifest，导致按钮/改动不生效）
    if RegKeyExists(HKCU, 'Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{7C3D9E21-4A55-4B2F-9E1C-2B6A8D4F0C11}') then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{7C3D9E21-4A55-4B2F-9E1C-2B6A8D4F0C11}');
    // 加载项注册：值名 = GUID，值数据 = manifest 路径（不要建成子键）
    RegWriteStringValue(
      HKCU,
      'Software\Microsoft\Office\16.0\WEF\Developer',
      '3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23',
      ExpandConstant('{app}\manifest.xml')
    );
    RegWriteDWordValue(
      HKCU,
      'Software\Microsoft\Office\16.0\WEF\Developer',
      'RefreshAddins',
      1
    );
    // 清掉历史遗留的「子键 + 默认值」形式（Office 不认，留着只会干扰排查）
    if RegKeyExists(HKCU, 'Software\Microsoft\Office\16.0\WEF\Developer\3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23') then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Office\16.0\WEF\Developer\3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23');
    // 清掉旧 AppId（1.2.0 及更早）遗留的卸载项，避免控制面板出现两个「化学工具」
    if RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6A2C9F31-7B4E-4D8A-9C15-3E7D2B0A5F68}_is1') then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6A2C9F31-7B4E-4D8A-9C15-3E7D2B0A5F68}_is1');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    RegDeleteValue(
      HKCU,
      'Software\Microsoft\Office\16.0\WEF\Developer',
      '3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23'
    );
    if RegKeyExists(HKCU, 'Software\Microsoft\Office\16.0\WEF\Developer\3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23') then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Office\16.0\WEF\Developer\3f2b9c4e-8a71-4d2f-9b6c-1d5e7a0c4b23');
  end;
end;
