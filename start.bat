@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 22+ from https://nodejs.org then run start.bat again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first launch only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed. Check internet connection.
    pause
    exit /b 1
  )
)

echo Starting SiteScope...
node --no-warnings server.js --open
pause
