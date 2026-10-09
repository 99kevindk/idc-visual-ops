param([int]$Port = 8123)
# Pure-PowerShell static server (no Node/Python required).
# Serves the project folder on http://localhost:<port>/ and opens the browser after start.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'index.html'))) { $root = $PSScriptRoot }

$mime = @{
  '.html' = 'text/html; charset=utf-8';   '.js' = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
  '.png'  = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif'
  '.svg'  = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.mp4' = 'video/mp4'; '.webm' = 'video/webm'
  '.woff' = 'font/woff'; '.woff2' = 'font/woff2'; '.ttf' = 'font/ttf'; '.map' = 'application/json'
}

function Find-FreePort([int]$p) {
  while ($p -lt 8140) {
    try { $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); return $p }
    catch { $p++ }
  }
  return 8123
}

$Port = Find-FreePort $Port
$prefix = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "============================================================"
Write-Host "  IDC 3D OPS DEMO - local server is running"
Write-Host "  URL: $prefix"
Write-Host "  (voice input needs this localhost page; press Ctrl+C to stop)"
Write-Host "============================================================"

if ($env:IDC_NO_BROWSER -eq '1') { Write-Host "[serve.ps1] browser open skipped (IDC_NO_BROWSER=1)" }
else { Start-Process $prefix }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ([string]::IsNullOrEmpty($rel) -or $rel -eq '/') { $rel = '/index.html' }
    $tail = $rel.TrimStart('/') -replace '/', '\'
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $tail))
    if ($full.StartsWith($root) -and (Test-Path -LiteralPath $full) -and -not (Get-Item -LiteralPath $full).PSIsContainer) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
      $res.Headers.Add('Cache-Control', 'no-store')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
      $res.ContentLength64 = $msg.Length
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}