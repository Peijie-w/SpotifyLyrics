@echo off
setlocal

set "PROJECT_DIR=%~dp0.."
set "ELECTRON_BIN=%PROJECT_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_BIN%" (
  echo Startup failed: Electron runtime not found. Run "npm install" first.
  pause
  exit /b 1
)

start "" "%ELECTRON_BIN%" "%PROJECT_DIR%"
