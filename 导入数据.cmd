@echo off
setlocal
cd /d "%~dp0"

echo.
echo   Gaokaoshun - auto import from Downloads
echo   ======================================
echo.
echo   Watching your Downloads folder for:
echo       Gaokaoshun detail CSV files
echo   Merging them into:  data\
echo.
echo   Keep this window open while you use the collector.
echo   Close it (or press Ctrl+C) to stop.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\watch-downloads.ps1"

echo.
echo   Watcher stopped.
pause