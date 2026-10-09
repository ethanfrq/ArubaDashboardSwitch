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
   | `auto_update` | `true` : mise à jour automatique depuis GitHub (voir plus bas), `false` pour la couper |

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
- Il crée la tâche « ArubaDashboardMiseAJour » : la mise à jour automatique (voir ci-dessous).
- Journaux : `agent.log` et `mise_a_jour.log` dans le dossier de l’agent.

Désinstaller : `desinstaller-service.bat` (en administrateur).
Vérifier : `python installer_service.py status`. Redémarrer : `python installer_service.py restart`.

Pour un fonctionnement 24 h/24, règle la mise en veille du PC sur « Jamais ».

## Mise à jour automatique
Toutes les 5 minutes (et au démarrage du PC), `mise_a_jour.py` compare chaque fichier du dossier `agent`
du dépôt GitHub avec celui du PC et télécharge ceux qui ont changé. Il n’y a rien d’autre à faire.
- Seuls les fichiers du dépôt sont touchés : `agent_config.json`, `agent_secret.bin` et les journaux ne le sont jamais.
- Chaque fichier est vérifié par son empreinte Git, et les scripts Python sont compilés avant d’être installés.
- L’ancienne version est gardée dans `.sauvegarde`. Si le nouvel agent ne redémarre pas correctement,
  elle est remise en place automatiquement et la version fautive n’est plus retentée tant que le dépôt ne change pas.
- Le résultat de la dernière vérification s’affiche en bas du dashboard (« mise à jour auto ✓ »).
- Mettre à jour tout de suite : clic droit sur `mettre-a-jour.bat`, « Exécuter en tant qu’administrateur ».

Comme le PC exécute automatiquement ce qui est publié sur GitHub, protège le compte GitHub
(double authentification) et ne publie sur la branche `main` que des versions testées.

## Passer d’une ancienne version (avant 1.3.0)
Une seule fois, dans PowerShell ouvert en administrateur dans le dossier de l’agent :

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/ethanfrq/ArubaDashboardSwitch/main/agent/mise_a_jour.py -OutFile mise_a_jour.py
python mise_a_jour.py --installer
```

Le script télécharge la nouvelle version, redémarre l’agent, vérifie qu’il fonctionne puis installe les deux tâches.
La configuration et le mot de passe enregistré sont conservés. Ensuite, tout est automatique.

## Ce que fait l’agent
- envoie l’état du switch toutes les 10 s quand le dashboard administrateur est ouvert, 30 s pour un écran
  lecture seule, 60 s sinon ;
- relève le débit, les appareils et le CPU à chaque envoi, l’état des liens et le journal du switch toutes les 30 s
  (dashboard ouvert), le spanning-tree et la configuration sauvegardée toutes les 2 min, le reste plus rarement ;
- espace tous ces relevés si le CPU du switch dépasse 60 % (deux fois) ou 80 % (quatre fois) ;
- relève les commandes du dashboard toutes les 1,5 s juste après une commande, sinon toutes les 5 s ;
- vérifie sa session SSH avant chaque commande (le switch ferme les sessions restées inutilisées) ;
- cherche les IP des appareils du réseau `scan_subnet` toutes les 5 min (table ARP du PC) ;
- calcule l’historique (5 min, 30 min, 2 h) et détecte les incidents pour les alertes.
