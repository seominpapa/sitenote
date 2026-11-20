@echo off
setlocal
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.18 or later, then open Sitenote.cmd again.
  pause
  exit /b 1
)
node "%~dp0scripts\launch-web.mjs" %*
set "SITENOTE_EXIT=%errorlevel%"
if not "%SITENOTE_EXIT%"=="0" pause
exit /b %SITENOTE_EXIT%
