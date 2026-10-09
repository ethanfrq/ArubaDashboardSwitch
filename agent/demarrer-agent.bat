@echo off
cd /d "%~dp0"
echo Lancement manuel de l'agent (fermer la fenetre pour l'arreter).
python agent.py
pause
