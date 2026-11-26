@echo off
cd /d "%~dp0"
set "GITBASH=C:\Program Files\Git\bin\bash.exe"
"%GITBASH%" -lc "bash infra/diagnose.sh > infra/diagnose-log.txt 2>&1"
