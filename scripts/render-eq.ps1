param(
  [Parameter(Mandatory = $true)][string]$Src
)

$ErrorActionPreference = "Stop"

$dir = [System.IO.Path]::GetDirectoryName($Src)
$base = [System.IO.Path]::GetFileNameWithoutExtension($Src)
$html = Join-Path $dir ($base + ".html")
$files = Join-Path $dir ($base + ".files")

if (Test-Path $html) { Remove-Item $html -Force }
if (Test-Path $files) { Remove-Item $files -Recurse -Force }

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($Src, $false, $true)
  $doc.Content.Font.Size = 28
  $doc.SaveAs2($html, 8)
  $doc.Close(0)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

if (Test-Path $files) {
  $pngs = Get-ChildItem $files -Filter *.png | Sort-Object Name
  $outDir = Join-Path $env:TEMP "eqshot"
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $i = 0
  foreach ($p in $pngs) {
    $i++
    $dest = Join-Path $outDir ("eq$i.png")
    Copy-Item $p.FullName $dest -Force
    Write-Output ($dest + "  " + $p.Length + "B")
  }
  if ($i -eq 0) { Write-Output "no png produced" }
} else {
  Write-Output "no export dir"
}
