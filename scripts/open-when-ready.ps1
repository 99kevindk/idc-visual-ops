param([int]$Port = 8123, [int]$TimeoutSec = 30, [string]$Query = "")
# 轮询本地服务，返回 200 后才打开浏览器（避免"页面打不开"）
if ($env:IDC_NO_BROWSER -eq '1') { Write-Host "[waiter] skip browser (IDC_NO_BROWSER=1)"; exit 0 }
$url = "http://localhost:$Port/$Query"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri ("http://localhost:$Port/") -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { Start-Process $url; Write-Host "[waiter] opened $url"; exit 0 }
  } catch { Start-Sleep -Milliseconds 300 }
}
Write-Host "[waiter] server not reachable at http://localhost:$Port/ ; please refresh the browser manually."