# Historique des versions

## 1.7.0 (2026-10-10) · My Aruba Manager

Le projet s’appelle maintenant **My Aruba Manager** et devient **open source** (licence Apache 2.0).
Projet indépendant, sans lien avec HPE ni Aruba Networks.

### Base de données plus simple : Supabase
- Upstash Redis et QStash sont remplacés par **une seule base Supabase** (Postgres, offre gratuite), ajoutée en un clic
  depuis l’onglet **Storage** du projet Vercel. Les tables sont créées toutes seules au premier lancement.
- La vérification toutes les 5 min (agent hors ligne, actions planifiées, alertes) est programmée automatiquement dans
  Supabase (pg_cron) : plus de planification QStash à créer. Son état s’affiche dans ⚙ Réglages en cas de problème.
- Tables protégées : l’API publique de Supabase n’y a aucun accès, seul le serveur du dashboard lit et écrit.
- Fonctions Vercel à Paris (cdg1), près de la base.

### Sécurité
- **Double authentification** pour l’administrateur (application d’authentification, code à 6 chiffres) avec
  8 codes de secours à usage unique, à activer dans ⚙ Réglages.
- **Politique de sécurité du contenu (CSP)** stricte : aucun script en ligne n’est exécuté par la page. Le code de
  l’application est sorti de `index.html` (`public/js/app.js`), les boutons Oui / Non des questions du switch n’ont plus
  de code dans le HTML.
- Injections corrigées dans l’affichage : valeurs CPU et mémoire, compteurs d’erreurs, numéros de VLAN, statut des
  commandes et canaux d’alerte venant de l’agent sont échappés. Un statut inattendu ne casse plus la fenêtre
  « Annuler une modification ». Essai d’injection automatisé sur environ 150 champs : aucun constat.
- Les secrets (mots de passe, communautés SNMP) sont masqués **avant** d’être enregistrés, y compris dans les relevés
  de diagnostic.
- En-têtes de sécurité ajoutés (HSTS, Permissions-Policy, Cross-Origin-Opener-Policy).
- L’agent ne se met plus à jour qu’à partir des **versions publiées** (releases GitHub), jamais depuis la branche
  principale. `"update_channel": "main"` reste possible pour un PC de test.

### Documentation
- README en anglais et en français, avec la vidéo de présentation.
- Licence Apache 2.0 (`LICENSE`, `NOTICE`) et bibliothèques tierces listées (`THIRD-PARTY-NOTICES.md`).

### Passer de la 1.6.0 à la 1.7.0
1. Dans le projet Vercel, onglet **Storage** : ajouter **Supabase** (offre gratuite, région Paris).
2. Facultatif, pour garder réglages, historique, sauvegardes et annuaire : depuis le dossier du projet,
   `vercel env pull .env.migration --environment=production --yes`, puis
   `node --env-file=.env.migration scripts/migrate-from-upstash.mjs`, puis supprimer `.env.migration`.
   Sans cette étape, le dashboard repart de zéro (le mot de passe administrateur, lui, ne change pas).
3. Redéployer, ouvrir le dashboard et vérifier qu’aucune alerte « vérification automatique » n’apparaît dans ⚙ Réglages.
4. Supprimer la planification QStash, puis retirer Upstash et QStash du projet Vercel.
5. Agent : rien à faire. Le programme de mise à jour du PC installe cette version, puis ne suit plus que les releases.

## 1.6.0 (2026-10-10) · agent 1.4.0

Tout se gère depuis l’interface : nouvelle carte **Administration**.

### Fonctions d’administration
- **Annuler une modification** : point de restauration créé sur le switch avant chaque changement, aperçu de ce qui
  sera annulé, retour en arrière (avec CONFIRMER). Pour un changement sensible, **annulation automatique par le switch**
  au bout de 5 min si l’on ne confirme pas que tout fonctionne. Nettoyage automatique des anciens points.
- **Sauvegardes de la configuration** : après chaque changement et toutes les 6 h, historique de 60 versions,
  comparaison ligne à ligne, téléchargement, secrets masqués ; liste des points de restauration du switch.
- **Profils de port** modifiables (Poste élève, Imprimante, Borne Wi-Fi, Serveur, Port libre) et **sélection multiple**
  (Maj+clic, Ctrl+clic ou outil sur mobile) avec barre d’actions groupées.
- **Annuaire des appareils** (noms, historique des ports, oubli), alerte « nouvel appareil » facultative,
  **plan de brassage** par port, **export CSV** et **impression**.
- **Actions planifiées** : couper, rallumer, redémarrer des ports ou allumer des PC à heure fixe, dans le fuseau choisi,
  par le serveur toutes les 5 min, jamais si l’agent est hors ligne, alerte en cas d’échec.
- **Diagnostic d’un port**, **« Un appareil ne marche pas ? »** et **bilan de santé** avec corrections en un clic.
- **Allumer des PC à distance** (Wake-on-LAN) et **ping** depuis le PC de l’agent.
- Réglages : nom du site, fuseau horaire, rythme de l’agent (120 s au plus).

### Sécurité
- La seconde confirmation reconnaît maintenant les **abréviations AOS-CX** (« int 1/1/24 » puis « shu », « relo »,
  « diag cab te »…) qui permettaient de la contourner depuis la console.
- Tabulation et caractères de contrôle refusés dans les commandes ; textes saisis nettoyés avant d’aller au switch.
- Protections de poste (BPDU guard, admin-edge, loop-protect) sur un lien vers un autre switch : seconde confirmation.
- Écrans lecture seule : la configuration complète n’est jamais transmise.
- Actions de l’agent (« #wol », « #ping ») refusées si l’agent installé ne les connaît pas.

### Corrections
- File de commandes : une commande mise en file pendant un relevé de l’agent pouvait rester bloquée.
- Copier la configuration vers un point de restauration n’est plus jugé dangereux ; « no spanning-tree bpdu-guard »
  sur un port n’est plus pris pour la désactivation du spanning-tree.

### Agent 1.4.0
- Wake-on-LAN (« #wol ») et ping (« #ping ») faits par l’agent lui-même, sans session SSH.
- Rythme d’envoi réglable depuis le dashboard.
- Après un échec de connexion SSH, pause de 15 s au lieu de réessayer sans cesse ; un refus de connexion du switch
  n’arrête plus l’agent.
- Mise à jour automatique : rien à faire si l’agent 1.3.0 est installé avec sa tâche de mise à jour.

## 1.5.0 (2026-10-09) · agent 1.3.0

### Relevé plus fréquent, sans charger le switch
- L’agent fait lui-même le relevé détaillé : **état des liens et journal du switch toutes les 30 s** (au lieu de 5 min),
  spanning-tree et configuration sauvegardée toutes les 2 min, aussi quand personne ne regarde (2 et 10 min).
- Les commandes peu changeantes (températures, erreurs, LLDP, VLAN, informations système) sont espacées :
  environ **un tiers de commandes en moins** envoyées au switch, malgré un relevé détaillé dix fois plus fréquent.
- Tout est espacé deux fois si le CPU du switch dépasse 60 % en moyenne sur une minute, quatre fois au-delà de 80 %.
- Après une commande de configuration, l’état des liens, des VLAN et de la sauvegarde est relu tout de suite.
- Ports instables : coupures comptées sur les 10 dernières minutes.

### Agent 1.3.0
- **Correction** : la session SSH des commandes, fermée par le switch après une longue inactivité, faisait échouer
  la commande suivante (« Socket is closed »). Elle est maintenant vérifiée avant usage et rouverte si besoin ;
  une commande coupée avant tout envoi est retentée une fois, jamais une commande déjà partie.
- **Mise à jour automatique** (`mise_a_jour.py`, tâche « ArubaDashboardMiseAJour ») : toutes les 5 minutes,
  les fichiers du dossier `agent` du dépôt GitHub sont comparés à ceux du PC et ceux qui ont changé sont installés.
  Empreintes vérifiées, scripts compilés avant installation, sauvegarde, et retour automatique à l’ancienne version
  si la nouvelle ne démarre pas. Configuration et mot de passe jamais touchés. `mettre-a-jour.bat` pour forcer.
- Version correcte envoyée au dashboard, résultat de la mise à jour automatique affiché en bas de page.

### Offres gratuites (Upstash)
- La page relit l’état juste après chaque envoi de l’agent au lieu de toutes les 5 s.
- Journal des commandes, alertes et relevé détaillé ne sont relus que lorsqu’ils ont changé (lecture habituelle :
  27 Ko au lieu de 59 Ko).
- L’agent relève les commandes toutes les 5 s (1,5 s juste après une commande) au lieu de 1,5 s en permanence.
- Écran lecture seule : l’agent envoie toutes les 30 s pendant qu’il est ouvert.

## 1.4.0 (2026-10-09)

### Deux accès
- **Mot de passe lecture seule** pour un écran de supervision, défini dans ⚙ Réglages (8 caractères minimum, différent de celui de l’administrateur).
  À la connexion, le mot de passe administrateur donne tous les droits, le mot de passe lecture seule donne l’affichage seul.
- Lecture seule **imposée par le serveur** : aucune commande (seuls les relevés et tests de câble automatiques, vérifiés ligne par ligne),
  pas de réglages, pas d’historique des commandes, destinataires des alertes et différences de configuration masqués.
- Mot de passe lecture seule stocké haché (scrypt). Le changer ou le désactiver déconnecte les écrans déjà connectés.
- Écran lecture seule économe : session de 30 jours, rafraîchissement toutes les 15 s, relevé toutes les 10 min, sans forcer l’agent en temps réel.
- **Vue monitoring** pour l’administrateur : un bouton masque toutes les commandes (console, actions, VLAN, réglages) sans se déconnecter.

### Corrections
- Un relevé raté (session SSH fermée par le switch après une longue inactivité) n’efface plus la carte Switch ni le journal :
  le dernier relevé valable reste affiché et un nouveau est demandé une minute plus tard.
- Le sous-titre de la barre du haut se raccourcit au lieu de renvoyer les boutons à la ligne.

## 1.3.0 (2026-10-09)

Plus de vérifications, sans mise à jour de l’agent.

### Ports sans lien
- **Un port n’est plus affiché « libre » sans preuve.** Sans test de câble valable (jamais testé, ou branché
  et débranché depuis le dernier test), il passe **« à vérifier »** (contour ambre, « ? ») sur la façade, dans le tableau et dans le détail du port.
- **Vérification automatique des câbles** quand le dashboard est ouvert : les ports à vérifier sont testés par lots de 4,
  puis tous les ports sans lien sont revérifiés toutes les 2 h (un câble branché sans rien au bout ne laisse aucune trace sur le switch).
  Jamais devant une commande de l’utilisateur, jamais sur un lien vers un autre switch, et désactivable dans les réglages.
- État précis dans le tableau : « Libre », « Câble sans lien », « Câble en défaut » ou « À vérifier ».
  Les ports avec un câble restent visibles ; seuls les ports vérifiés libres sont repliés.
- Un appareil encore annoncé en LLDP sur un port sans lien est indiqué « dernier appareil vu » au lieu d’apparaître branché.

### Commandes
- **Vérification après chaque modification** : le dashboard contrôle dans l’état suivant du switch que le changement a bien été pris en compte
  (port activé ou coupé, VLAN d’un port, description, VLAN créé, renommé ou supprimé, configuration sauvegardée), et prévient sinon.
- Les relevés automatiques ne sont plus envoyés en double quand plusieurs pages du dashboard sont ouvertes.
- Journal des commandes porté à 80 entrées.

## 1.2.0 (2026-10-09)

### Sécurité
- **Double confirmation obligatoire pour les commandes dangereuses**, imposée par le serveur :
  redémarrage, effacement ou remplacement de configuration, comptes administrateurs, accès SSH ou web,
  IP de gestion, spanning-tree, suppression d’un VLAN utilisé, modification de 8 ports ou plus,
  et toute coupure, changement de VLAN ou test de câble sur un lien vers un autre switch ou sur le port du PC de l’agent.
  Le serveur refuse la commande et délivre un jeton à usage unique valable 2 minutes ; il faut taper CONFIRMER pour l’exécuter.

### Corrections
- Test de câble : un résultat n’est plus affiché si le port a été branché ou débranché depuis le test.
- « Paires bonnes + paire ouverte » devient un avertissement (normal en 10/100 Mb/s) au lieu d’un défaut.
- Affectation de VLAN : une commande par port, pour éviter un délai de l’agent 1.0.0 sur les plages de ports.

### Agent 1.2.0 (facultatif)
- Reconnaît l’invite des plages de ports (`config-if-<1/1/3-1/1/8>`) : les commandes sur plusieurs ports ne sont plus ralenties.

## 1.1.0 (2026-10-09)

Nouvelles informations, sans mise à jour de l’agent : le dashboard interroge lui-même le switch (commandes en lecture seule).

- **Carte « Switch »** : IP de gestion, adresse MAC, numéro de série, firmware, configuration sauvegardée ou non,
  spanning-tree (racine, ports bloqués), trafic broadcast reçu, température.
- **Badge « Config non sauvegardée »** dans la barre du haut, avec sauvegarde en un clic.
- **Journal du switch** : les 80 derniers événements, traduits en français, filtrables (ports, avertissements).
- **Par port** : depuis quand il est dans son état, nombre de coupures depuis le démarrage, badge « instable »
  en cas de coupures répétées, rôle et état spanning-tree, alerte si un port est bloqué (boucle réseau).
- **Charge du lien** en pourcentage de la vitesse négociée.
- **Façade** : ports SFP alignés avec trois états (vide, module sans lien, actif), libellés plus courts.
- Relevés automatiques toutes les 5 minutes quand le dashboard est ouvert, partagés entre les navigateurs
  et masqués de la console.

## 1.0.0 (2026-10-09)

Première version publique.

### Supervision
- Façade du switch en direct : état, vitesse négociée et débit de chaque port, ports lents (10/100 Mb/s),
  liens vers d’autres switches, ports « lien établi mais aucun paquet ».
- Détection des câbles branchés sans lien (longueur, rien au bout, câble en défaut) grâce au scan des ports libres.
- Débit en direct sur 1 h, historique sur 24 h, 7 jours et 30 jours, au total ou par port.
- Tableau unique « Ports et appareils » : nom (LLDP ou DNS), IP, MAC, débits, erreurs, avec recherche et tri.
- Santé du switch : CPU, mémoire, températures, temps de fonctionnement.

### Gestion
- Activer, désactiver, redémarrer un port ; changer sa description et son VLAN.
- VLANs : créer, renommer, supprimer, affecter des ports, mini-façade par VLAN.
- Test de câble (TDR) paire par paire avec un verdict en clair.
- Console de commandes avec questions oui/non du switch sous forme de boutons ; sauvegarde de la configuration.

### Alertes
- E-mail (Resend) et webhook (Teams, Slack, Discord, ntfy) : port surveillé qui tombe ou revient,
  température, agent arrêté, lien lent, lien sans trafic.
- Vérification « agent hors ligne » toutes les 5 minutes (QStash).

### Agent
- Agent Python (SSH), installable comme service Windows (démarrage automatique, redémarrage en cas d’erreur).
- Mot de passe du switch chiffré par Windows (DPAPI).
- Recherche des IP des appareils sur le réseau local.

### Interface
- Mode clair / sombre, notifications et indicateurs de chargement sur chaque action, confirmation avant toute modification.
