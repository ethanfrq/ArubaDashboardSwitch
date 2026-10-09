# Licences des composants tiers

Aruba Dashboard Switch est © 2026 Ethan, tous droits réservés (voir [`LICENSE`](LICENSE)).
Il s’appuie sur les composants libres suivants, qui restent sous leur propre licence.

## Dashboard (Node.js, installé par npm sur Vercel)

| Paquet | Version | Licence |
|---|---|---|
| [@upstash/redis](https://github.com/upstash/redis-js) | 1.39 | MIT |
| [@upstash/qstash](https://github.com/upstash/qstash-js) | 2.12 | MIT |
| [jose](https://github.com/panva/jose) (dépendance de @upstash/qstash) | 5.10 | MIT |
| [neverthrow](https://github.com/supermacro/neverthrow) (dépendance de @upstash/qstash) | 7.2 | MIT |
| [uncrypto](https://github.com/unjs/uncrypto) (dépendance de @upstash/redis) | 0.1 | MIT |

## Agent (Python, installé par pip sur le PC de l’agent)

Ces paquets ne sont pas inclus dans ce dépôt : ils sont téléchargés par `pip install -r agent/requirements.txt`.

| Paquet | Licence |
|---|---|
| [paramiko](https://github.com/paramiko/paramiko) | LGPL-2.1 |
| [cryptography](https://github.com/pyca/cryptography) (dépendance de paramiko) | Apache-2.0 ou BSD-3-Clause |
| [bcrypt](https://github.com/pyca/bcrypt) (dépendance de paramiko) | Apache-2.0 |
| [PyNaCl](https://github.com/pyca/pynacl) (dépendance de paramiko) | Apache-2.0 |
| [cffi](https://github.com/python-cffi/cffi) et [pycparser](https://github.com/eliben/pycparser) | MIT et BSD-3-Clause |

L’agent utilise aussi la bibliothèque standard de Python (licence PSF).

## Services

Le dashboard utilise les services Vercel, Upstash (Redis, QStash) et, en option, Resend, selon leurs conditions d’utilisation respectives.

## Marques

Aruba, HPE Aruba Networking et AOS-CX sont des marques de Hewlett Packard Enterprise.
Ce projet est indépendant et n’est ni affilié à HPE ni approuvé par HPE.
