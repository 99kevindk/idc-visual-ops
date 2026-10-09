@echo off
chcp 65001 >nul
setlocal
title IDC 3D OPS DEMO - Local Server
cd /d "%~dp0"

echo ============================================================
echo   IDC Intelligent Ops Platform - 3D Data Center Demo
echo   3D digital twin + voice inspection + power/environment monitoring
echo ============================================================
echo.

if not exist "index.html" (
  echo [ERROR] index.html not found in this folder:
  echo         %CD%
  echo         Please keep start.bat next to index.html.
  echo.
  pause
  exit /b 1
)

set "PORT=8123"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=8123; while($p -lt 8140){ try{ $l=New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback,$p); $l.Start(); $l.Stop(); Write-Output $p; exit }catch{ $p++ } }; Write-Output 8123"`) do set "PORT=%%p"

rem ---- build artifact check (source-only repo, no dist/) ----
if not exist "dist\app.js" (
  echo   [i] dist\app.js not found (source-only repo) - running src/app.js as ES modules
  if exist "node_modules\esbuild" (
    if defined NODE_EXE (
      echo   [i] build tools found - generating dist/app.js ...
      "%NODE_EXE%" "scripts\build.mjs" >nul 2>nul
    )
  )
)

echo   URL: http://localhost:%PORT%/
echo   (voice input needs this localhost page - do NOT open index.html directly)
echo.

set "NODE_EXE="
for %%n in (node.exe) do if exist "%%~$PATH:n" set "NODE_EXE=%%~$PATH:n"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

set "GWQ="
set "HASGW="
if not defined NODE_EXE goto :skip_gw
if not exist "tools\gateway\server.mjs" goto :skip_gw
set "HASGW=1"
set "GWQ=?gw=1"
echo   Starting power/environment gateway (donghuan) on port 8124 ...
start "IDC Donghuan Gateway" /min "%NODE_EXE%" "tools\gateway\server.mjs" --port 8124 --driver sim
echo   Gateway: ws://localhost:8124/dh
echo.
:skip_gw

if defined NODE_EXE goto :use_node
where py >nul 2>nul && goto :use_py
where python >nul 2>nul && goto :use_python
goto :use_powershell

:use_node
echo   Runtime: Node.js
echo   Starting server, browser will open automatically when it is ready...
echo.
if not defined HASGW goto :waiter_plain
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\open-when-ready.ps1" -Port %PORT% -Query "%GWQ%"
goto :run_node
:waiter_plain
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\open-when-ready.ps1" -Port %PORT%
:run_node
"%NODE_EXE%" "scripts\start.mjs" %PORT%
goto :done

:use_py
echo   Runtime: Python launcher
echo   Starting server, browser will open automatically when it is ready...
echo.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\open-when-ready.ps1" -Port %PORT%
py -3 -m http.server %PORT% --bind 127.0.0.1
goto :done

:use_python
echo   Runtime: Python
echo   Starting server, browser will open automatically when it is ready...
echo.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\open-when-ready.ps1" -Port %PORT%
python -m http.server %PORT% --bind 127.0.0.1
goto :done

:use_powershell
echo   Runtime: PowerShell built-in server (no Node.js / Python needed)
echo   Browser will open automatically when it is ready...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\serve.ps1" -Port %PORT%
goto :done

:done
echo.
echo   Server stopped. Press any key to close this window.
pause >nul