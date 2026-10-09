@echo off
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Ce fichier doit etre lance en tant qu'administrateur : clic droit, "Executer en tant qu'administrateur".
  pause
  exit /b 1
)
echo Mise a jour de l'agent depuis GitHub, puis installation des taches (agent + mise a jour automatique)...
python mise_a_jour.py --installer
pause
