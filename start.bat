@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting dev server...
start "" /B npm run dev

echo Waiting for server...
:wait
ping -n 2 127.0.0.1 >nul
curl -s -o NUL http://127.0.0.1:5173 2>nul && goto open
goto wait

:open
start "" http://127.0.0.1:5173
echo Server ready — browser opened.
