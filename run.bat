@echo off
setlocal

rem Lance Prandia. Cree le venv et installe les deps si besoin,
rem puis demarre l'app. Idempotent : sur les lancements suivants on saute
rem directement au demarrage.

cd /d "%~dp0"

set "VENV_PY=.venv\Scripts\python.exe"

rem ---- 1. Cree le venv si absent ou casse -------------------------------
if not exist "%VENV_PY%" goto create_venv
"%VENV_PY%" --version >nul 2>nul
if not errorlevel 1 goto check_deps

echo [setup] Le venv existant est casse (probablement venu d'une autre machine).
echo [setup] Suppression et recreation...
rmdir /S /Q ".venv"

:create_venv
echo [setup] Creation du venv...
py -3.12 -m venv .venv 2>nul
if not errorlevel 1 goto check_deps
py -3.11 -m venv .venv 2>nul
if not errorlevel 1 goto check_deps
rem Dernier recours : python du PATH (peut etre 3.14, on tente quand meme)
where python >nul 2>nul
if errorlevel 1 goto err_no_python
python -m venv .venv
if errorlevel 1 goto err_venv

:check_deps
rem ---- 2. Verifie que PySide6 est importable (test plus fiable qu'un sentinel)
"%VENV_PY%" -c "import PySide6" >nul 2>nul
if not errorlevel 1 goto launch

echo [setup] Installation des dependances (premiere fois, ~1-2 min selon connexion)...
"%VENV_PY%" -m pip install --upgrade pip
"%VENV_PY%" -m pip install -e ".[dev]"
if errorlevel 1 goto err_install

rem Verifie l'install reellement.
"%VENV_PY%" -c "import PySide6" >nul 2>nul
if errorlevel 1 goto err_install

:launch
"%VENV_PY%" -m app.main
if errorlevel 1 goto err_runtime
goto end

rem ---- gestion des erreurs (toujours pause pour que tu lises) -----------
:err_no_python
echo.
echo [erreur] Python introuvable. Installe Python 3.11+ depuis https://www.python.org/
echo          et coche "Add Python to PATH" pendant l'installation.
goto fail

:err_venv
echo.
echo [erreur] La creation du venv a echoue.
goto fail

:err_install
echo.
echo [erreur] L'installation des dependances a echoue.
echo          Verifie ta connexion internet et que rien ne verrouille .venv\
goto fail

:err_runtime
echo.
echo [erreur] L'application s'est arretee avec une erreur.
echo          Lis les messages au-dessus pour comprendre.
goto fail

:fail
pause
endlocal
exit /b 1

:end
endlocal
