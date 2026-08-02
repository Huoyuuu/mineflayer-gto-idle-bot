@echo off
setlocal
cd /d "%~dp0"
echo Testing Minecraft login as Dred and sending /home...
node --env-file-if-exists=.env scripts\dred-login-check.js
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Test finished with exit code %EXIT_CODE%.
echo Report: .runtime\dred-login-report.json
pause
exit /b %EXIT_CODE%
