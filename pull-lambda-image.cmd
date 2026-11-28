@echo off
cd /d "%~dp0"
"C:\Program Files\Git\bin\bash.exe" -lc "bash infra/pull-lambda-image.sh > infra/pull-log.txt 2>&1"
