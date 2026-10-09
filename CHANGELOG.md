# Historique des versions

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
