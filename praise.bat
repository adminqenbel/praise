@echo off
setlocal EnableDelayedExpansion
rem ============================================================================
rem  Praise - one-file launcher
rem
rem    praise.bat              start backend + dashboard and open the browser
rem    praise.bat mock         same, but use the offline keyword classifier (no Gemini calls)
rem    praise.bat demo         also create demo data (parent@demo.test / Mia)
rem    praise.bat stop         stop the backend and dashboard
rem    praise.bat nobrowser    do not open the browser (can combine: praise.bat mock nobrowser)
rem
rem  From a terminal run it as .praise.bat. Needs: PostgreSQL running, Python 3.11+, backend\.env (created from
rem  .env.example on first run). The Chrome extension is loaded by hand:
rem  chrome://extensions -> Developer mode -> Load unpacked -> this folder\extension
rem ============================================================================

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "DASH=%ROOT%dashboard"
set "VENV=%BACKEND%\.venv"
set "API_PORT=5000"
set "DASH_PORT=5500"

set "DO_STOP=" & set "DO_DEMO=" & set "NO_BROWSER="
for %%A in (%*) do (
  if /I "%%A"=="stop" set "DO_STOP=1"
  if /I "%%A"=="demo" set "DO_DEMO=1"
  if /I "%%A"=="mock" set "AI_MODE=mock"
  if /I "%%A"=="nobrowser" set "NO_BROWSER=1"
)

if defined DO_STOP goto :stop

echo.
echo === Praise ===

rem ---- 1. database ---------------------------------------------------------
call :check_port 5432 PostgreSQL PG_OK
if not "!PG_OK!"=="1" (
  echo   [!] PostgreSQL is not listening on 5432. Start its Windows service, e.g.:
  echo       net start postgresql-x64-18      ^(run as Administrator; name may differ^)
  goto :fail
)

rem ---- 2. python environment ----------------------------------------------
if not exist "%VENV%\Scripts\python.exe" (
  echo Creating Python environment ^(first run, a minute or two^)...
  python -m venv "%VENV%" || ( echo   [!] Python 3.11+ not found on PATH. & goto :fail )
  "%VENV%\Scripts\python.exe" -m pip install -q -r "%BACKEND%\requirements.txt" || goto :fail
)

if not exist "%BACKEND%\.env" (
  copy "%BACKEND%\.env.example" "%BACKEND%\.env" >nul
  echo.
  echo   [!] Created backend\.env from the example. Open it and set:
  echo         DATABASE_URL  ^(your PostgreSQL password^)
  echo         GEMINI_API_KEY ^(or run praise.bat mock to skip the AI^)
  echo       then run praise.bat again.
  goto :fail
)

rem ---- 3. database setup (safe to repeat) ------------------------------------
pushd "%BACKEND%"
set "FLASK_APP=app.py"
echo Applying database migrations...
"%VENV%\Scripts\flask.exe" db upgrade 2>nul
if errorlevel 1 ( echo   [!] Migration failed. Check DATABASE_URL in backend\.env and that the "praise" database exists. & popd & goto :fail )
"%VENV%\Scripts\flask.exe" seed-sites
popd

rem ---- 4. servers -------------------------------------------------------------
call :port_busy %API_PORT% API_BUSY
call :port_busy %DASH_PORT% DASH_BUSY

"%VENV%\Scripts\python.exe" "%ROOT%scripts\sync_common.py" >nul

if "!API_BUSY!"=="1" ( echo Backend already running on %API_PORT%. ) else (
  echo Starting backend on http://localhost:%API_PORT% ...
  start "Praise backend" /D "%BACKEND%" cmd /k ""%VENV%\Scripts\flask.exe" --app app run --port %API_PORT%"
)
if "!DASH_BUSY!"=="1" ( echo Dashboard already running on %DASH_PORT%. ) else (
  echo Starting dashboard on http://localhost:%DASH_PORT% ...
  start "Praise dashboard" /D "%DASH%" cmd /k ""%VENV%\Scripts\python.exe" serve.py %DASH_PORT%"
)

rem ---- 5. wait for the backend ------------------------------------------------
set "UP="
for /L %%I in (1,1,20) do (
  if not defined UP (
    curl -s -o nul -f http://localhost:%API_PORT%/health && set "UP=1"
    if not defined UP ping -n 2 127.0.0.1 >nul
  )
)
if not defined UP ( echo   [!] Backend did not answer on /health. See the "Praise backend" window. & goto :fail )
echo Backend is up.

if defined DO_DEMO (
  echo Creating demo data...
  "%VENV%\Scripts\python.exe" "%BACKEND%\scripts\seed_demo.py" http://localhost:%API_PORT%
  echo   Parent login: parent@demo.test / demo-password-123
  echo   ^(An admin needs: cd backend ^& .venv\Scripts\flask --app app create-admin^)
)

echo.
echo   Dashboard : http://localhost:%DASH_PORT%
echo   API       : http://localhost:%API_PORT%/health
if /I "%AI_MODE%"=="mock" ( echo   AI        : offline mock classifier ) else ( echo   AI        : Gemini ^(see GEMINI_API_KEY in backend\.env^) )
echo   Extension (one for everyone): chrome://extensions - Load unpacked - %ROOT%extension  - then enter a pairing code
echo   Stop      : praise.bat stop
if not defined NO_BROWSER start "" "http://localhost:%DASH_PORT%"
goto :eof

rem ---- stop -----------------------------------------------------------------
:stop
echo Stopping Praise...
for %%P in (%API_PORT% %DASH_PORT%) do (
  for /f "tokens=5" %%X in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    taskkill /PID %%X /F >nul 2>&1 && echo   stopped process on port %%P
  )
)
echo Done. ^(PostgreSQL is left running.^)
goto :eof

rem ---- helpers --------------------------------------------------------------
:check_port
rem %1 port, %2 label, %3 result variable (set to 1 when something is listening)
set "%~3="
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %~1); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 ( set "%~3=1" & echo %~2 is running. )
exit /b 0

:port_busy
set "%~2="
netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul && set "%~2=1"
exit /b 0

:fail
echo.
echo Startup stopped. Fix the item above and run praise.bat again.
exit /b 1
