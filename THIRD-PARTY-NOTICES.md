# Third-party notices

My Aruba Manager is © 2026 Ethan ([@ethanfrq](https://github.com/ethanfrq)) and is licensed under the
Apache License 2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)).
It relies on the following open source components, which remain under their own licenses.

## Dashboard server (Node.js, installed by npm on Vercel)

This package is not included in this repository: npm installs it when Vercel builds the project.

| Package | Author | License |
|---|---|---|
| [postgres](https://github.com/porsager/postgres) | Rasmus Porsager | [Unlicense](https://unlicense.org/) (public domain dedication) |

`postgres` has no dependencies of its own.

## Web page (served to the browser)

This library is included in this repository, in `public/vendor/`. It draws the QR code shown when
two-factor authentication is set up.

| Library | Author | License |
|---|---|---|
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | Kazuhiko Arase | MIT |

```
The MIT License (MIT)

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Agent (Python, installed by pip on the agent's PC)

These packages are not included in this repository: they are downloaded by
`pip install -r requirements.txt` in the agent's folder.

| Package | License |
|---|---|
| [paramiko](https://github.com/paramiko/paramiko) | LGPL-2.1 |
| [cryptography](https://github.com/pyca/cryptography) (paramiko dependency) | Apache-2.0 or BSD-3-Clause |
| [bcrypt](https://github.com/pyca/bcrypt) (paramiko dependency) | Apache-2.0 |
| [PyNaCl](https://github.com/pyca/pynacl) (paramiko dependency) | Apache-2.0 |
| [cffi](https://github.com/python-cffi/cffi) and [pycparser](https://github.com/eliben/pycparser) | MIT and BSD-3-Clause |

The agent also uses the Python standard library (PSF License).

## Services

Each installation runs on accounts created by its owner, under the terms of each service:
[Vercel](https://vercel.com/) (page and API), [Supabase](https://supabase.com/) (Postgres database) and,
optionally, [Resend](https://resend.com/) (e-mail alerts) and the webhook services chosen for alerts.
The agent downloads its updates from the releases published on
[GitHub](https://github.com/ethanfrq/ArubaDashboardSwitch/releases).

## Trademarks

Aruba, HPE Aruba Networking and AOS-CX are trademarks of Hewlett Packard Enterprise.
My Aruba Manager is an independent project, not affiliated with or endorsed by HPE.

QR Code is a registered trademark of DENSO WAVE INCORPORATED.
