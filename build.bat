@echo off
setlocal

rem Build le .exe Windows portable. Sortie : dist\prandia\
rem Premiere compilation : ~2-3 min. Compilations suivantes : ~1 min (cache PyInstaller).

cd /d "%~dp0"

set "VENV_PY=.venv\Scripts\python.exe"

rem ---- 1. Verifie le venv ----
if not exist "%VENV_PY%" (
    echo [erreur] Venv introuvable. Lance run.bat une fois pour le creer.
    pause
    exit /b 1
)

rem ---- 2. Installe PyInstaller s'il manque ----
"%VENV_PY%" -c "import PyInstaller" 2>nul
if errorlevel 1 (
    echo [build] Installation de PyInstaller...
    "%VENV_PY%" -m pip install pyinstaller
    if errorlevel 1 goto err_pyinstaller
)

rem ---- 3. Nettoie le build precedent ----
echo [build] Suppression de dist\ et build\ ...
if exist build rmdir /S /Q build
if exist dist rmdir /S /Q dist

rem ---- 4. Compile ----
echo [build] Compilation en cours (1-3 min selon la machine)...
"%VENV_PY%" -m PyInstaller prandia.spec --noconfirm
if errorlevel 1 goto err_build

rem ---- 5. Resume ----
echo.
echo [ok] Compile dans dist\prandia\
echo      Lance dist\prandia\prandia.exe
echo.
echo Le dossier dist\prandia\ est portable :
echo   - copie-le sur une cle USB ou une autre machine Windows
echo   - double-clique prandia.exe (pas besoin d'installer Python)
echo   - la DB sera creee a cote de l'exe (prandia.db)
echo.
goto end

:err_pyinstaller
echo [erreur] L'installation de PyInstaller a echoue.
echo          Verifie ta connexion internet.
goto fail

:err_build
echo.
echo [erreur] La compilation a echoue.
echo          Lis les messages au-dessus pour comprendre.
goto fail

:fail
pause
endlocal
exit /b 1

:end
pause
endlocal
