# Historique des versions

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
