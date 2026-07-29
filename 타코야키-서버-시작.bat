@echo off
title Tacoyaki Box Server
cd /d "%~dp0"

echo ====================================
echo    Tacoyaki Box - Server Launcher
echo ====================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

if not exist node_modules goto INSTALL
goto AFTER_INSTALL
:INSTALL
echo [*] First run: installing required files. This takes about 1-3 minutes...
call npm install --no-audit --no-fund
if errorlevel 1 goto INSTALL_FAIL
:AFTER_INSTALL

if not exist cloudflared.exe goto GET_TUNNEL
goto RUN
:GET_TUNNEL
echo [*] Downloading the tunnel tool (one time only)...
powershell -Command "try { Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe' } catch { exit 1 }"
if not exist cloudflared.exe goto TUNNEL_FAIL
:RUN

echo [*] Starting the server...
start "Tacoyaki Server - DO NOT CLOSE" cmd /k "chcp 65001 >nul & npm start"
timeout /t 6 /nobreak >nul

echo.
echo ===========================================
echo    In a moment an address starting with https:// will appear below.
echo    Copy that address into the [Connect] box in the Tacoyaki Box app.
echo    Friends can connect only while this window and the server window stay open.
echo ===========================================
echo.

cloudflared.exe tunnel --url http://localhost:8787
echo.
echo [*] The tunnel has stopped. Close the server window too to shut down completely.
pause
exit /b

:NO_NODE
echo [!] Node.js is not installed.
echo     Install the LTS version from nodejs.org, then
echo     double-click this file again.
start "" https://nodejs.org/
pause
exit /b

:INSTALL_FAIL
echo [!] Installation failed. Check your internet connection and try again.
pause
exit /b

:TUNNEL_FAIL
echo [!] Failed to download the tunnel tool.
echo     Try again later, or use the cloud (Railway) method in the Server Hosting Guide.
pause
exit /b
