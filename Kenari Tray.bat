@echo off
cd /d "%~dp0"
start "" /min node_modules\electron\dist\electron.exe .
