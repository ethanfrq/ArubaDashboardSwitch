# Installation de l’agent sur le PC Windows

Le PC doit rester allumé, être sur le même réseau que le switch, pouvoir le joindre en SSH et avoir accès à internet.

## 1. Préparer
1. Installer Python 3 depuis https://www.python.org/downloads/ (cocher « Add python.exe to PATH »).
2. Décompresser l’agent dans un dossier, par exemple `C:\aruba-agent`.
3. Dans une invite de commandes ouverte dans ce dossier : `pip install -r requirements.txt`
4. Copier `agent_config.example.json` en `agent_config.json` et le compléter :

   | Clé | Valeur |
   |---|---|
   | `switch_host` | IP de gestion du switch |
   | `switch_user` | compte SSH du switch (souvent `admin`) |
   | `dashboard_url` | URL de ton dashboard Vercel |
   | `agent_token` | valeur de la variable `AGENT_TOKEN` définie sur Vercel |
   | `scan_subnet` | réseau à scanner pour trouver les IP des appareils, par exemple `192.168.1.0/24` |

   Laisse `switch_password` vide : le mot de passe est demandé à l’installation et enregistré chiffré.
   Ne publie jamais `agent_config.json` : il contient le jeton de l’agent.

## 2. Tester à la main
Double-clic sur `demarrer-agent.bat`, puis saisis le mot de passe SSH du switch.
Le dashboard doit afficher « Agent en ligne ». Ferme ensuite la fenêtre (Ctrl+C) : un seul agent peut tourner à la fois.

## 3. Installer comme service (recommandé)
Clic droit sur `installer-service.bat`, puis « Exécuter en tant qu’administrateur ».
- Il demande le mot de passe SSH du switch et l’enregistre chiffré par Windows (`agent_secret.bin`, illisible sur un autre PC).
- Il crée la tâche « ArubaDashboardAgent » : elle démarre avec Windows (même sans session ouverte),
  tourne en arrière-plan sans fenêtre et redémarre toute seule en cas d’erreur.
- Journal : `agent.log` dans le dossier de l’agent.

Désinstaller : `desinstaller-service.bat` (en administrateur).
Vérifier : `python installer_service.py status`. Redémarrer : `python installer_service.py restart`.

Pour un fonctionnement 24 h/24, règle la mise en veille du PC sur « Jamais ».

## Ce que fait l’agent
- relève le switch toutes les 60 s, toutes les 10 s quand le dashboard est ouvert ;
- relève les commandes toutes les 1,5 s quand le dashboard est ouvert ;
- cherche les IP des appareils du réseau `scan_subnet` toutes les 5 min (table ARP du PC) ;
- calcule l’historique (5 min, 30 min, 2 h) et détecte les incidents pour les alertes.
