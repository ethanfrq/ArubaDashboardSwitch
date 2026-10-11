# Installation de l’agent My Aruba Manager sur le PC Windows

*English version : [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)*

Le PC doit rester allumé, être sur le même réseau que le switch, pouvoir le joindre en SSH et avoir accès à internet.

Guide illustré complet, du déploiement sur Vercel jusqu’à l’agent connecté :
[docs/GUIDE.md](https://github.com/ethanfrq/ArubaDashboardSwitch/blob/main/docs/GUIDE.md#6-installer-lagent-sur-le-pc-windows).
Dans le dashboard, l’assistant **Démarrage** reprend ces étapes et vérifie chacune en direct.

## 1. Préparer
1. Installer Python 3 depuis https://www.python.org/downloads/ : prendre l’installateur classique
   (lien « standalone installer », fichier `python-3.x.x-amd64.exe`), cocher « Add python.exe to PATH »
   sur le premier écran, puis « Install Now ».
2. Télécharger l’agent depuis la [dernière version](https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest)
   (fichier `aruba-agent-x.y.z.zip`). Le zip contient un dossier `aruba-agent-x.y.z` : clic droit, « Extraire tout… »
   vers `C:\`, puis renommer `C:\aruba-agent-x.y.z` en `C:\aruba-agent`. Les fichiers (`agent.py`,
   `installer-service.bat`…) doivent être directement dans ce dossier.
3. Dans une invite de commandes ouverte dans ce dossier (taper `cmd` dans la barre d’adresse de l’Explorateur) :
   `python -m pip install -r requirements.txt` (ou `pip install -r requirements.txt`).
4. Mettre le fichier `agent_config.json` dans le dossier de l’agent :
   - **le plus simple** : dans le dashboard, assistant **Démarrage**, étape « Configurer l’agent » : indiquer l’IP
     du switch, puis cliquer sur « Télécharger agent_config.json » (réservé à un administrateur). Le fichier est
     pré-rempli (adresse du dashboard, jeton de l’agent, rythme, mise à jour automatique) : le placer dans le dossier
     de l’agent, sous ce nom exact ;
   - **méthode manuelle** : copier `agent_config.example.json` en `agent_config.json` et le compléter :

     | Clé | Valeur |
     |---|---|
     | `switch_host` | IP de gestion du switch |
     | `switch_user` | compte SSH du switch (souvent `admin`) |
     | `dashboard_url` | URL de ton dashboard Vercel |
     | `agent_token` | valeur de la variable `AGENT_TOKEN` définie sur Vercel |
     | `scan_subnet` | réseau à scanner pour trouver les IP des appareils, par exemple `192.168.1.0/24` (1024 adresses au plus : /22 à /30) |
     | `auto_update` | `true` : mise à jour automatique à partir des versions publiées sur GitHub (voir plus bas), `false` pour la couper |

   Dans les deux cas, `switch_password` reste vide : le mot de passe est demandé à l’installation et enregistré chiffré.
   Ne publie jamais `agent_config.json` : il contient le jeton de l’agent.

## 2. Tester à la main (facultatif)
Double-clic sur `demarrer-agent.bat`, puis saisis le mot de passe SSH du switch.
Le dashboard doit afficher « Agent en ligne ». Ferme ensuite la fenêtre (Ctrl+C) : un seul agent peut tourner à la fois.

## 3. Installer comme service (recommandé)
Clic droit sur `installer-service.bat`, puis « Exécuter en tant qu’administrateur ».
- Il demande le mot de passe SSH du switch et l’enregistre chiffré par Windows (`agent_secret.bin`, illisible sur un autre PC).
- Il crée la tâche « ArubaDashboardAgent » : elle démarre avec Windows (même sans session ouverte),
  tourne en arrière-plan sans fenêtre et redémarre toute seule en cas d’erreur.
- Il crée la tâche « ArubaDashboardMiseAJour » : la mise à jour automatique (voir ci-dessous).
- Journaux : `agent.log` et `mise_a_jour.log` dans le dossier de l’agent.

La fenêtre doit afficher « Service installé et démarré ». En moins d’une minute, le dashboard affiche « Agent en ligne »
(et l’assistant **Démarrage**, « Agent connecté »).

Désinstaller : `desinstaller-service.bat` (en administrateur).

Redémarrer l’agent (par exemple après avoir remplacé `agent_config.json`) : relancer `installer-service.bat`
(clic droit, « Exécuter en tant qu’administrateur ») et appuyer sur Entrée sans rien taper quand le mot de passe
est demandé : le mot de passe enregistré est gardé, le service est arrêté puis relancé.
Vérifier ou redémarrer en ligne de commande : dans une invite de commandes ouverte **en administrateur** (menu
Démarrer, taper `cmd`, clic droit sur « Invite de commandes », « Exécuter en tant qu’administrateur »), taper
`cd /d C:\aruba-agent`, puis `python installer_service.py status` ou `python installer_service.py restart`.

Pour un fonctionnement 24 h/24, règle la mise en veille du PC sur « Jamais ».

## Mise à jour automatique
L’agent ne se met à jour **qu’à partir des versions publiées** sur la page
[Releases](https://github.com/ethanfrq/ArubaDashboardSwitch/releases) du dépôt GitHub.
Toutes les 5 minutes (et au démarrage du PC), `mise_a_jour.py` regarde si une nouvelle version a été publiée ;
si c’est le cas, il télécharge les fichiers de l’agent de cette version et installe ceux qui ont changé.
Le code en cours de développement, envoyé sur la branche principale sans nouvelle version publiée, n’est jamais installé.
Il n’y a rien d’autre à faire.
- Seuls les fichiers de l’agent sont touchés : `agent_config.json`, `agent_secret.bin` et les journaux ne le sont jamais.
- Les fichiers téléchargés sont vérifiés, et les scripts Python sont compilés avant d’être installés.
- L’ancienne version est gardée dans `.sauvegarde`. Si le nouvel agent ne redémarre pas correctement,
  elle est remise en place automatiquement et la version fautive n’est plus retentée tant qu’une nouvelle version n’est pas publiée.
- Le résultat de la dernière vérification s’affiche en bas du dashboard (« mise à jour auto » suivi d’une coche verte, ou d’un triangle orange en cas d’échec).
- Vérifier tout de suite (et réinstaller les deux tâches) : clic droit sur `mettre-a-jour.bat`, « Exécuter en tant qu’administrateur ».

Pour valider chaque version toi-même avant de l’installer, mets `auto_update` à `false` dans `agent_config.json`,
puis lance `mettre-a-jour.bat` quand tu le décides.

Pour un PC de test qui doit suivre le code en développement (branche principale), remplace la valeur de
`update_channel` par `"main"` dans `agent_config.json` (la clé y est déjà, avec `"releases"`). À ne pas faire sur le PC
relié au switch en service.

Si tu publies ta propre version de l’agent, souviens-toi que les PC installent automatiquement ce qui est publié en release :
protège le compte GitHub (double authentification) et ne publie que des versions testées.

## Passer d’une ancienne version (avant 1.3.0)
Le dashboard le signale par l’encadré « L’agent installé sur le PC est ancien : mets-le à jour » (au-dessus du journal
du switch) et le bas de page affiche « agent : version antérieure à 1.3.0 ». À faire une seule fois, sur le PC où
l’agent est installé ; la configuration et le mot de passe enregistré sont conservés.

1. Ouvre PowerShell **en administrateur** : menu Démarrer, tape `PowerShell`, clic droit sur « Windows PowerShell »,
   « Exécuter en tant qu’administrateur », puis « Oui » quand Windows demande l’autorisation.
2. Va dans le dossier de l’agent : tape `cd C:\aruba-agent` (ou le dossier où l’agent est installé), puis Entrée.
3. Copie les deux lignes ci-dessous, colle-les dans la fenêtre PowerShell (clic droit), puis Entrée :

```powershell
Invoke-WebRequest https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest/download/mise_a_jour.py -OutFile mise_a_jour.py
python mise_a_jour.py --installer
```

Le script télécharge la nouvelle version, redémarre l’agent, vérifie qu’il fonctionne puis installe les deux tâches.
Quelques minutes plus tard, le bas du dashboard affiche le numéro de version de l’agent (par exemple « agent v1.4.0 »)
et l’encadré disparaît. Ensuite, tout est automatique.

## Ce que fait l’agent
- envoie l’état du switch toutes les 10 s quand le dashboard administrateur est ouvert, 30 s pour un écran
  lecture seule, 60 s sinon (réglable dans Réglages, 120 s au plus) ;
- relève le débit, les appareils et le CPU à chaque envoi, l’état des liens et le journal du switch toutes les 30 s
  (dashboard ouvert), le spanning-tree et la configuration sauvegardée toutes les 2 min, le reste plus rarement ;
- espace tous ces relevés si le CPU du switch dépasse 60 % (deux fois) ou 80 % (quatre fois) ;
- relève les commandes du dashboard toutes les 1,5 s juste après une commande, sinon toutes les 5 s ;
- vérifie sa session SSH avant chaque commande (le switch ferme les sessions restées inutilisées), et attend 15 s
  après un échec de connexion au lieu de réessayer sans cesse ;
- allume les PC à distance (Wake-on-LAN) et fait des ping à la demande du dashboard : le Wake-on-LAN doit être activé
  dans le BIOS et sur la carte réseau des PC ;
- garde un résultat qu’il n’a pas pu remettre au dashboard (réseau coupé) et le renvoie jusqu’à 10 min plus tard ;
- cherche les IP des appareils du réseau `scan_subnet` toutes les 5 min (table ARP du PC) ;
- calcule l’historique (5 min, 30 min, 2 h) et détecte les incidents pour les alertes.
