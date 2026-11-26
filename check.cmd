@echo off
REM Runs the smoke test of the deployed app. Output: infra\check-log.txt
cd /d "%~dp0"
"C:\Program Files\Git\bin\bash.exe" -lc "bash infra/check.sh > infra/check-log.txt 2>&1"
