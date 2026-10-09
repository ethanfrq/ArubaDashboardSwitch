@echo off
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Ce fichier doit etre lance en tant qu'administrateur : clic droit, "Executer en tant qu'administrateur".
  pause
  exit /b 1
)
echo === Mot de passe SSH du switch (laisse vide pour garder celui deja enregistre) ===
python agent.py --set-password
python installer_service.py install
echo.
echo L'agent se mettra a jour tout seul depuis GitHub (verification toutes les 5 minutes).
pause
