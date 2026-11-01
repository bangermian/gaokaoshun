@echo off
setlocal
cd /d "%~dp0"

set "PROFILE=%~dp0.chrome-auto"
set "EXTDIR=%~dp0tools\extension"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME%" (
  echo   [X] Chrome not found. Please install Chrome first.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     Gaokaoshun - scraping window
echo   ============================================================
echo.
echo   This window uses its own profile folder:  .chrome-auto
echo   Your normal Chrome profile is NOT touched.
echo.

rem --- warn if the same profile is already running ---
tasklist /fi "imagename eq chrome.exe" 2>nul | find /i "chrome.exe" >nul
if not errorlevel 1 (
  echo   [i] If a window from this launcher is ALREADY open,
  echo       close it first - Chrome reuses it and the flags
  echo       below would be ignored.
  echo.
)

if not exist "%PROFILE%" mkdir "%PROFILE%"

echo   Opening Chrome with background throttling disabled...
start "" "%CHROME%" ^
 --user-data-dir="%PROFILE%" ^
 --no-first-run ^
 --no-default-browser-check ^
 --disable-background-timer-throttling ^
 --disable-backgrounding-occluded-windows ^
 --disable-renderer-backgrounding ^
 --disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion,msEdgeSleepingTabs,msSleepingTabs ^
 --disable-hang-monitor ^
 "https://www.gaokao.cn/" ^
 "chrome://extensions/"

timeout /t 6 >nul

echo.
echo   ------------------------------------------------------------
echo     FIRST TIME ONLY: load the collector extension
echo   ------------------------------------------------------------
echo.
echo     1) In the chrome://extensions tab that just opened,
echo        turn on  Developer mode  ^(top-right^)
echo     2) Click  Load unpacked
echo     3) Choose this folder:
echo           %EXTDIR%
echo.
echo     After that, refresh gaokao.cn and the panel appears
echo     at the bottom-right. Next launches need no setup.
echo.
echo   Opening the extension folder for you...
start "" explorer "%EXTDIR%"
echo.
echo   This console can be closed now.
timeout /t 10 >nul