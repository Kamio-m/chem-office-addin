# 化学工具 — 加载项修复脚本
# 作用：重新注册 Office 加载项（HKCU），重启本地服务。
# 使用：Word 功能区看不到「化学工具」组时，右键以 PowerShell 运行本脚本。

$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "ChemOfficeAddin"
$manifest = Join-Path $dir "manifest.xml"
$exe = Join-Path $dir "化学工具.exe"

if (-not (Test-Path $manifest)) {
  Write-Host "未找到 manifest.xml，请先运行安装包。" -ForegroundColor Red
  exit 1
}

# 1) 注册加载项（Word / Excel / PowerPoint 共用）
$guid = "{6A2C9F31-7B4E-4D8A-9C15-3E7D2B0A5F68}"
$key = "HKCU:\Software\Microsoft\Office\16.0\WEF\Developer\$guid"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host "已注册加载项：$manifest"

# 2) 清理旧版「共享文件夹」注册项（会让 Word 读旧清单）
$old = "HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{7C3D9E21-4A55-4B2F-9E1C-2B6A8D4F0C11}"
if (Test-Path $old) {
  Remove-Item $old -Recurse -Force
  Write-Host "已清理旧共享文件夹注册项"
}

# 3) 重启本地服务
Get-Process -Name "化学工具" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
if (Test-Path $exe) {
  Start-Process -FilePath $exe -ArgumentList "--silent" -WindowStyle Hidden
  Write-Host "已启动化学工具服务"
} else {
  Write-Host "未找到 化学工具.exe，跳过启动。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "完成。请完全关闭并重开 Word，查看「开始」选项卡右侧的「化学工具」组。" -ForegroundColor Green
