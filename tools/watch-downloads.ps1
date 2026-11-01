#Requires -Version 5.1
<#
.SYNOPSIS
  看护「下载」文件夹：把插件导出的 高考顺_专业明细_*.csv 自动合并进 data/

.DESCRIPTION
  浏览器不允许 HTTPS 页面（www.gaokao.cn）直接写本地文件，也不允许它 fetch
  http://127.0.0.1（混合内容 / 私有网络访问限制，实测被静默拦截）。
  所以改成"插件照常下载，本脚本盯着下载目录自动导入"：
  不用改浏览器设置，也不用装额外权限。

  流程：
    1. 插件点「导出总表」→ 文件落到 下载 文件夹
    2. 本脚本 3 秒内发现新文件 → POST 给本地服务器合并进 data/
    3. 处理完把原文件移到 .cache/imported/（不删，留痕）
    4. 网页那边自动加载逻辑会自己刷出数据

.EXAMPLE
  .\watch-downloads.ps1
  .\watch-downloads.ps1 -Port 8137 -Interval 3
#>
[CmdletBinding()]
param(
  [int]$Port = 8137,
  [int]$Interval = 3,
  [string]$DownloadsDir = ''
)

$ErrorActionPreference = 'Continue'

if (-not $DownloadsDir) {
  $DownloadsDir = Join-Path $env:USERPROFILE 'Downloads'
}

$Root = Split-Path $PSScriptRoot -Parent
$ArchiveDir = Join-Path $Root '.cache\imported'

Write-Host ''
Write-Host '  高考顺 · 下载目录看护' -ForegroundColor Cyan
Write-Host '  ========================' -ForegroundColor DarkCyan
Write-Host "  监听目录：$DownloadsDir"
Write-Host "  目标服务：http://127.0.0.1:$Port/api/append-csv"
Write-Host "  文件命名：高考顺_专业明细_*.csv"
Write-Host ''
Write-Host '  插件点「导出总表」后，这里会自动把它合并进 data/。' -ForegroundColor Gray
Write-Host '  按 Ctrl+C 停止。' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path -LiteralPath $ArchiveDir)) {
  New-Item -ItemType Directory -Path $ArchiveDir -Force | Out-Null
}

$processed = @{}

function Send-CsvToServer {
  param([string]$Path)

  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  if ($lines.Count -lt 2) { return @{ ok = $false; message = '文件里没有数据行' } }

  $header = $lines[0]
  $rows = @($lines[1..($lines.Count - 1)])
  $fileName = [System.IO.Path]::GetFileName($Path)

  $payload = @{
    file       = $fileName
    header     = $header
    rows       = $rows
    keyColumns = @(0, 2, 5)
  } | ConvertTo-Json -Depth 5 -Compress

  try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/append-csv" -Method Post `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 60
    return $resp
  }
  catch {
    return @{ ok = $false; message = $_.Exception.Message }
  }
}

while ($true) {
  try {
    $files = @(Get-ChildItem -LiteralPath $DownloadsDir -Filter '高考顺_专业明细_*.csv' -File -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
      $key = $f.FullName + '|' + $f.LastWriteTimeUtc.Ticks
      if ($processed.ContainsKey($key)) { continue }

      # 刚下载的文件可能还在写，等它大小稳定
      $size1 = $f.Length
      Start-Sleep -Milliseconds 800
      $f.Refresh()
      if ($f.Length -ne $size1) { continue }

      $result = Send-CsvToServer -Path $f.FullName
      if ($result -and $result.ok) {
        $processed[$key] = $true
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $dest = Join-Path $ArchiveDir ("{0}-{1}" -f $stamp, $f.Name)
        Move-Item -LiteralPath $f.FullName -Destination $dest -Force
        Write-Host ("  [{0}] 已导入 {1} → 共 {2} 行（新增 {3}）" -f (Get-Date -Format 'HH:mm:ss'), $f.Name, $result.rows, $result.added) -ForegroundColor Green
      }
      else {
        $msg = if ($result) { $result.message } else { '未知错误' }
        Write-Host ("  [{0}] 导入失败 {1}：{2}" -f (Get-Date -Format 'HH:mm:ss'), $f.Name, $msg) -ForegroundColor Yellow
        if ($msg -match 'locked|being used|denied|EPERM') {
          Write-Host '         数据文件正被别的程序占着（多半是 Excel 打开着）。关掉后会自动重试。' -ForegroundColor Yellow
        }
        else {
          Write-Host '         请确认 启动.cmd 的服务器还开着。3 秒后重试。' -ForegroundColor DarkGray
        }
      }
    }
  }
  catch {
    Write-Host ("  看护异常：{0}" -f $_.Exception.Message) -ForegroundColor Red
  }

  Start-Sleep -Seconds $Interval
}
