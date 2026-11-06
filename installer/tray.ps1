# 化学工具 — 任务栏托盘控制
# 右键菜单：打开面板 / 启动服务 / 停止服务 / 重启服务 / 开机自启 / 退出
# 由 启动托盘.vbs 以隐藏窗口方式拉起，无控制台闪烁。

param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing | Out-Null

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExePath = Join-Path $AppDir '化学工具.exe'
$TrayVbs = Join-Path $AppDir '启动托盘.vbs'
$PanelUrl = 'https://localhost:3000'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'ChemOfficeAddin'

function Test-Port {
  param([int]$Port = 3000, [int]$TimeoutMs = 400)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-AppProcess {
  Get-Process -Name '化学工具' -ErrorAction SilentlyContinue
}

function Test-AppRunning {
  if (-not (Get-AppProcess)) { return $false }
  return (Test-Port)
}

function Start-App {
  if (Get-AppProcess) { return (Test-Port) }
  if (-not (Test-Path -LiteralPath $ExePath)) { return $false }
  Start-Process -FilePath $ExePath -ArgumentList '--silent' -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Port) { return $true }
  }
  return (Test-Port)
}

function Stop-App {
  $procs = Get-AppProcess
  if (-not $procs) { return $false }
  $procs | Stop-Process -Force
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-AppProcess)) { break }
  }
  return $true
}

function Test-Autostart {
  try {
    $v = (Get-ItemProperty -Path $RunKey -Name $RunName -ErrorAction Stop).$RunName
    return ($v -like '*启动托盘.vbs*')
  } catch {
    return $false
  }
}

function Set-Autostart {
  param([bool]$On)
  if ($On) {
    Set-ItemProperty -Path $RunKey -Name $RunName -Value ('wscript.exe "' + $TrayVbs + '"')
  } else {
    Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue
  }
}

function Open-Panel {
  Start-Process $PanelUrl
}

# ---------------- 自检模式（无界面，便于验证） ----------------
if ($SelfTest) {
  Write-Output ("服务运行: " + (Test-AppRunning))
  Write-Output ("进程存在: " + [bool](Get-AppProcess))
  Write-Output ("开机自启(托盘): " + (Test-Autostart))
  Write-Output ("exe 存在: " + (Test-Path -LiteralPath $ExePath))
  Write-Output ("vbs 存在: " + (Test-Path -LiteralPath $TrayVbs))
  exit 0
}

# ---------------- 单实例 ----------------
# 用会话内命名互斥量（Global\ 需要额外权限，普通用户可能创建失败）
$mutex = $null
$isOwner = $true
try {
  $mutex = New-Object System.Threading.Mutex($false, 'ChemOfficeAddinTray')
  $isOwner = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $isOwner = $true
} catch {
  $isOwner = $true # 拿不到互斥量也照常显示，宁可多一个图标，也别启动失败
}
if (-not $isOwner) { exit 0 }

# ---------------- 托盘 ----------------
$icon = $null
try {
  if (Test-Path -LiteralPath $ExePath) {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($ExePath)
  }
} catch { }
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = '化学工具'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$miStatus.Enabled = $false
[void]$menu.Items.Add($miStatus)

[void]$menu.Items.Add('-')

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$miOpen.Text = '打开工具面板'
[void]$menu.Items.Add($miOpen)

$miStart = New-Object System.Windows.Forms.ToolStripMenuItem
$miStart.Text = '启动服务'
[void]$menu.Items.Add($miStart)

$miStop = New-Object System.Windows.Forms.ToolStripMenuItem
$miStop.Text = '停止服务'
[void]$menu.Items.Add($miStop)

$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$miRestart.Text = '重启服务'
[void]$menu.Items.Add($miRestart)

[void]$menu.Items.Add('-')

$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem
$miAuto.Text = '开机自动启动'
[void]$menu.Items.Add($miAuto)

$miExit = New-Object System.Windows.Forms.ToolStripMenuItem
$miExit.Text = '退出托盘'
[void]$menu.Items.Add($miExit)

$ni.ContextMenuStrip = $menu

$context = New-Object System.Windows.Forms.ApplicationContext

function Update-Menu {
  $running = Test-AppRunning
  if ($running) {
    $miStatus.Text = '状态：运行中（端口 3000）'
  } else {
    $miStatus.Text = '状态：已停止'
  }
  $miStart.Enabled = -not $running
  $miStop.Enabled = $running
  $miRestart.Enabled = $running
  $miAuto.Checked = Test-Autostart
  $ni.Text = if ($running) { '化学工具 · 运行中' } else { '化学工具 · 已停止' }
}

$miOpen.add_Click({ try { Open-Panel } catch { } })
$miStart.add_Click({
    try {
      if (Start-App) {
        $ni.ShowBalloonTip(2000, '化学工具', '服务已启动', [System.Windows.Forms.ToolTipIcon]::Info)
      } else {
        $ni.ShowBalloonTip(3000, '化学工具', '启动失败：请检查安装目录里的 化学工具.exe', [System.Windows.Forms.ToolTipIcon]::Warning)
      }
    } catch { }
    Update-Menu
  })
$miStop.add_Click({
    try {
      if (Stop-App) {
        $ni.ShowBalloonTip(2000, '化学工具', '服务已停止，Word 面板将无法加载', [System.Windows.Forms.ToolTipIcon]::Info)
      }
    } catch { }
    Update-Menu
  })
$miRestart.add_Click({
    try {
      Stop-App | Out-Null
      Start-Sleep -Milliseconds 300
      if (Start-App) {
        $ni.ShowBalloonTip(2000, '化学工具', '服务已重启', [System.Windows.Forms.ToolTipIcon]::Info)
      }
    } catch { }
    Update-Menu
  })
$miAuto.add_Click({
    try {
      Set-Autostart (-not (Test-Autostart))
      $ni.ShowBalloonTip(1500, '化学工具', $(if (Test-Autostart) { '已开启开机自动启动' } else { '已关闭开机自动启动' }), [System.Windows.Forms.ToolTipIcon]::Info)
    } catch { }
    Update-Menu
  })
$miExit.add_Click({
    $ni.Visible = $false
    $ni.Dispose()
    $context.ExitThread()
  })
$ni.add_DoubleClick({ try { Open-Panel } catch { } })

# 托盘启动时若服务没跑，直接拉起来
try {
  if (-not (Test-AppRunning)) { Start-App | Out-Null }
} catch { }

$watcher = New-Object System.Windows.Forms.Timer
$watcher.Interval = 5000
$watcher.add_Tick({
    # 程序被卸载 / 目录被删时自动退出，避免留下孤儿图标
    if (-not (Test-Path -LiteralPath $ExePath)) {
      $ni.Visible = $false
      $ni.Dispose()
      $context.ExitThread()
      return
    }
    Update-Menu
  })
$watcher.Start()

Update-Menu
[System.Windows.Forms.Application]::Run($context)
$watcher.Stop()
