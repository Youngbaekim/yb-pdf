@echo off
rem YB-PDF local test server (double-click to run)
cd /d "%~dp0"
where node >nul 2>nul || (echo [ERROR] Node.js is not installed. Install LTS from https://nodejs.org & pause & exit /b)
if not exist node_modules (echo Installing packages... & call npm install)
if not exist public\pdfjs (call node scripts\copy-pdfjs.mjs)
echo.
echo Keep this window open while using YB-PDF. Close it (or Ctrl+C) to stop.
echo.
call npm run dev -- --open
pause
