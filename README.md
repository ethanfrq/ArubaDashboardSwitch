# Aruba Dashboard Switch

Dashboard web pour superviser et piloter un switch **Aruba CX** (AOS-CX, testé sur un **6000 24G 4SFP** en 10.15),
hébergé sur **Vercel**, sans ouvrir aucun port sur le réseau local.

- **Façade en direct** : état de chaque port, vitesse négociée, débit, ports lents (10/100 Mb/s), liens vers d’autres switches,
  et détection des ports « câble branché mais aucun paquet ».
- **Débits et historique** : dernière heure en direct, puis 24 h, 7 jours et 30 jours, au total ou pour un port précis.
- **Appareils connectés** : adresses MAC, noms LLDP / DNS, et **adresses IP** trouvées par l’agent.
- **Gestion** : activer, désactiver ou redémarrer un port, changer sa description, **VLANs** (créer, renommer, supprimer,
  affecter des ports), **test de câble** (longueur et défaut par paire), sauvegarde de la configuration.
- **Console** : n’importe quelle commande CLI, avec les questions oui/non du switch affichées sous forme de boutons.
- **Alertes** par e-mail (Resend) et/ou webhook (Teams, Slack, Discord, ntfy…) : port surveillé qui tombe, température,
  agent arrêté, lien lent, lien sans trafic.
- **Confort** : indicateur de chargement sur chaque action, notifications de réussite ou d’erreur, thème clair/sombre automatique.

## Comment ça marche

```
┌──────────┐   SSH    ┌───────────────────────┐  HTTPS (sortant)  ┌──────────────────────────┐
│  Switch  │ ◄──────► │ Agent Python          │ ────────────────► │ Vercel                   │ ◄── navigateur
│ Aruba CX │          │ (PC du réseau local)  │ ◄──────────────── │ page + fonctions API     │
└──────────┘          └───────────────────────┘   commandes       └────────────┬─────────────┘
                                                                  Upstash Redis · QStash · Resend
```

Le switch a une adresse privée : Vercel ne peut pas le joindre. Un **agent** installé sur un PC du réseau lit le switch en SSH,
envoie l’état au dashboard et exécute les commandes demandées. C’est toujours l’agent qui contacte Vercel, jamais l’inverse.

Pour rester dans les offres gratuites, l’agent envoie l’état toutes les **60 s** quand personne ne regarde, toutes les **10 s**
quand le dashboard est ouvert, et relève alors les commandes toutes les **1,5 s**.

| Dossier | Contenu |
|---|---|
| `public/index.html` | l’interface (une seule page, sans framework ni dépendance) |
| `api/` | fonctions Vercel (Node 24) : connexion, état, commandes, historique, réglages, alertes, agent, vérification planifiée |
| `lib/` | Redis, authentification, envoi des notifications |
| `agent/` | l’agent Python et son installation en service Windows |
| `scripts/` | création de la planification QStash |

## Installation

### 1. Vercel
1. Importer ce dépôt dans Vercel (framework : *Other*, dossier de sortie `public`, déjà réglé dans `vercel.json`).
2. Ajouter depuis le Marketplace Vercel : **Upstash for Redis** et **Upstash QStash** (et **Resend** pour les e-mails).
3. Définir les variables d’environnement (Production) :

| Variable | Rôle |
|---|---|
| `DASHBOARD_PASSWORD` | mot de passe de la page |
| `SESSION_SECRET` | clé de signature des sessions (`openssl rand -base64 32`) |
| `AGENT_TOKEN` | jeton partagé avec l’agent (`openssl rand -hex 32`) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | ajoutées par l’intégration Upstash Redis |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | ajoutées par l’intégration QStash |
| `RESEND_API_KEY` | ajoutée par l’intégration Resend (facultatif) |
| `ALERT_FROM` | expéditeur des e-mails, ex. `Switch <alertes@mon-domaine.fr>` (facultatif) |
| `DASHBOARD_URL` | URL du dashboard citée dans les alertes (facultatif) |

4. Déployer, puis créer la vérification « agent hors ligne » :
   ```bash
   vercel env pull .env.local
   DASHBOARD_URL=https://mon-projet.vercel.app node --env-file=.env.local scripts/setup-qstash.mjs
   ```

### 2. Switch
Le switch doit avoir une IP joignable depuis le PC de l’agent, avec SSH activé (`ssh server vrf default`).

### 3. Agent
Voir [`agent/INSTALLATION-WINDOWS.md`](agent/INSTALLATION-WINDOWS.md) : Python 3 + `pip install paramiko`,
`agent_config.json` créé à partir de `agent_config.example.json`, puis `installer-service.bat` en administrateur.
L’agent fonctionne aussi sous macOS et Linux (`python3 agent.py`).

## Sécurité
- Le dashboard est protégé par mot de passe, avec une session signée (cookie `HttpOnly`, `Secure`, `SameSite=Strict`)
  et un blocage de 15 min après 8 essais ratés.
- L’agent s’authentifie avec `AGENT_TOKEN`, et la vérification planifiée avec la signature QStash.
- Le mot de passe SSH du switch reste sur le PC de l’agent, chiffré par Windows (DPAPI). Il n’est jamais envoyé à Vercel.
- Toute commande de configuration passe par une fenêtre de confirmation qui affiche les lignes exactes envoyées au switch.
- **Aucun secret n’est versionné** : les fichiers `.env*`, `agent_config.json` et `agent_secret.bin` sont exclus par `.gitignore`.

> Ce dashboard donne un accès administrateur au switch depuis internet : choisis un mot de passe solide et unique,
> différent de celui du switch.
