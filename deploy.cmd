@echo off
REM Deploys the whole app on Floci (Docker Desktop must be running). Log: infra\deploy-log.txt
cd /d "%~dp0"
set "GITBASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%GITBASH%" set "GITBASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not exist "%GITBASH%" (
  echo Git Bash was not found. Install Git for Windows, or run: bash infra/deploy-all.sh  from Git Bash.
  pause
  exit /b 1
)
"%GITBASH%" -lc "cd \"$(cygpath '%~dp0')\" && set -o pipefail; bash infra/preflight.sh 2>&1 | tee infra/deploy-log.txt && bash infra/deploy-all.sh 2>&1 | tee -a infra/deploy-log.txt"
echo.
echo Finished. The full log is in infra\deploy-log.txt
pause
