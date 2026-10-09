# Installation de l’agent sur le PC Windows

Le PC doit être sur le même réseau que le switch et pouvoir le joindre en SSH.

## 1. Préparer
1. Installer Python 3 depuis https://www.python.org/downloads/ (cocher « Add python.exe to PATH »).
2. Dans une invite de commandes ouverte dans le dossier de l’agent : `pip install -r requirements.txt`
3. Copier ce dossier `agent` sur le PC, par ex. `C:\aruba-agent`.
4. Créer `agent_config.json` : copier `agent_config.example.json` et y coller le jeton de l’agent (valeur AGENT_TOKEN, fournie à part et jamais mise dans Git). Si tu copies le dossier depuis le Mac, `agent_config.windows.json` est déjà rempli : renomme-le simplement.

## 2. Installer comme service (recommandé)
Clic droit sur `installer-service.bat` → « Exécuter en tant qu'administrateur ».
- Il demande le mot de passe SSH du switch et l'enregistre chiffré par Windows (`agent_secret.bin`, illisible sur un autre PC).
- Il crée la tâche « ArubaDashboardAgent » : démarre avec Windows (même sans session ouverte),
  tourne en arrière-plan sans fenêtre, et redémarre toute seule en cas d'erreur.
- Journal : `agent.log` dans le dossier de l'agent.

Désinstaller : `desinstaller-service.bat` (en administrateur).
Vérifier : `python installer_service.py status` · Redémarrer : `python installer_service.py restart`.

## 3. Ou lancer à la main (test)
Double-clic sur `demarrer-agent.bat` (s'arrête quand on ferme la fenêtre). Un seul agent peut tourner à la fois.

## Ce que fait l'agent
- relève le switch toutes les 60 s, toutes les 10 s quand le dashboard est ouvert ;
- relève les commandes toutes les 1,5 s quand le dashboard est ouvert ;
- cherche les IP des appareils du réseau `scan_subnet` toutes les 5 min (table ARP du PC) ;
- calcule l'historique (5 min / 30 min / 2 h) et détecte les incidents pour les alertes.
