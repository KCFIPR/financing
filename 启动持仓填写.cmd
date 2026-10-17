@echo off
cd /d "%~dp0"
call npm run holdings
if errorlevel 1 pause
