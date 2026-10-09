@echo off
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Ce fichier doit etre lance en tant qu'administrateur.
  pause
  exit /b 1
)
python installer_service.py uninstall
pause
