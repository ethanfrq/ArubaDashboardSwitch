# My Aruba Manager

**Monitor and manage an HPE Aruba Networking CX switch from anywhere, in your browser, without opening a single port on your network.**

A web dashboard for **HPE Aruba Networking CX** switches (AOS-CX): live front panel, throughput and history,
connected devices with their IP addresses, VLANs, cable tests, command console, alerts and administration tools.
Built for schools, networking courses (such as the French BTS SIO, BTS CIEL and IUT programs) and small organizations.
The user interface is in French.
It runs on the free plans of Vercel and Supabase and relies on a small Python agent installed on a PC of the local network.

[![Version](https://img.shields.io/github/v/release/ethanfrq/ArubaDashboardSwitch?label=version)](https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![HPE Aruba Networking CX](https://img.shields.io/badge/HPE%20Aruba%20Networking%20CX-AOS--CX%2010.x-ff8300)](#compatibility-and-limits)

**Version française : [README.fr.md](README.fr.md)**

> Created by **Ethan** ([@ethanfrq](https://github.com/ethanfrq)). Compatible with HPE Aruba Networking CX.
>
> Independent project, not affiliated with or endorsed by HPE.
> Aruba, HPE Aruba Networking and AOS-CX are trademarks of Hewlett Packard Enterprise.

[![Presentation video (30 s)](docs/video/apercu.jpg)](docs/video/my-aruba-manager.mp4)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fethanfrq%2FArubaDashboardSwitch&env=DASHBOARD_PASSWORD,SESSION_SECRET,AGENT_TOKEN&envDescription=Dashboard%20password%2C%20session%20key%20and%20agent%20token&project-name=my-aruba-manager)

---

## Features

### Monitoring
- **Live front panel**: every port with its state, negotiated speed and throughput. Slow ports (10/100 Mb/s),
  links to other switches and ports that are "connected but without traffic" are highlighted.
- **Cables detected without a link**: a scan of the free ports shows whether a cable is plugged in, its length and whether it is faulty.
- **Verified "free" ports**: a port without a link is only shown as free when a recent cable test confirms it.
  Ports never tested, or plugged and unplugged since the last test, are marked "to be checked" and tested
  automatically in small batches; the others are checked again every 2 hours (can be turned off in the settings).
- **Throughput and history**: the last hour live, then 24 hours, 7 days and 30 days, in total or port by port.
- **Ports and devices**: a single table (name, IP, MAC, throughput, errors) with search and sorting.
- **Switch health**: CPU, memory, temperatures, uptime, IP, MAC, serial number, firmware.
- **Unsaved configuration** shown in the top bar, with one-click save.
- **Spanning tree**: root switch, blocked ports (network loop), abnormal broadcast traffic.
- **History of each port**: since when it has been up or down, number of link drops, unstable ports.
- **Switch log**: the latest events, translated into plain French (links, logins, spanning tree).
- **Frequent polling without overloading the switch**: link state and log every 30 s, spanning tree and
  saved configuration every 2 min; commands whose output rarely changes are spaced out, and everything slows down
  when the switch CPU rises.

### Management
- Enable, disable or restart a port, change its description.
- **VLANs**: create, rename, delete, assign ports.
- **Cable test** (TDR): length and state of each pair, with a plain-language verdict.
- **Console**: any CLI command; yes/no questions from the switch are shown as buttons.
- One-click configuration save.

### Administration without touching the code
Everything is set from the **Administration** card and the ⚙ settings:
- **Undo a change**: before each change, the dashboard creates a restore point on the switch.
  You see what will be undone, then roll back in one click (by typing CONFIRMER). For a sensitive change
  (management IP, link to another switch, and so on), the switch **rolls back on its own after 5 minutes** unless you confirm
  that everything still works: you cannot lock yourself out.
- **Configuration backups**: automatic copy after each change and every 6 hours, history,
  line-by-line comparison between two versions, download (secrets masked), return to a switch restore point.
- **Port profiles** (student PC, printer, Wi-Fi access point, server, unused port; all editable): VLAN, description,
  protections (BPDU guard, admin-edge, loop-protect) and state applied in one click.
- **Multiple selection**: Shift+click or Ctrl+click on ports (or the selection tool on mobile), then an action bar:
  enable, shut down, restart, VLAN, description with automatic numbering, profile, power on, test cables.
- **Device directory**: name a PC once and its name follows it on every port; port history,
  optional "new device" alert. **Patch plan** (wall socket, room, note) for each port,
  **CSV export** and **printing** of the plan.
- **Scheduled actions**: shut down, re-enable or restart ports, power on PCs at a set time, carried out
  even when the dashboard is closed (never while the agent is offline; 8 ports or more must be confirmed with CONFIRMER).
- **Power on PCs remotely** (Wake-on-LAN) and **ping** from the agent's PC.
- **Port diagnosis** (clear steps and a one-sentence conclusion) and a **"device not working?"** troubleshooting guide.
- **Health check**: unsaved configuration, protections on user ports, NTP, default SNMP community,
  unused ports, cables, slow or unstable ports, and more, with one-click fixes.
- **Settings**: site name, time zone, agent pace, alerts, read-only access, two-factor authentication.

### Two access levels
- **Administrator**: the whole dashboard, commands included. Protected by a password and, once enabled,
  by **two-factor authentication**: a 6-digit code from an app such as Google Authenticator or
  Microsoft Authenticator, with single-use recovery codes.
- **Read-only**, for a monitoring screen: a second password, set in the settings, gives access to everything
  on display without any command. This is enforced by the server, not only by the page. The session lasts 30 days and
  the screen refreshes every 30 s without forcing the agent into real-time mode, to stay within the free plans.
- **Monitoring view**: a button lets the administrator hide every command without logging out.

### Alerts
- By **e-mail** (Resend) and/or **webhook** (Teams, Slack, Discord, ntfy for your phone, and others).
- Monitored port going down or coming back, temperature too high, agent stopped, slow link, link without traffic,
  new device (optional), failed scheduled action.

### Comfort
- Light and dark mode, loading indicators and notifications for every action.
- Mandatory confirmation, showing the exact lines sent to the switch, before any change.
- **Check after each change**: the dashboard verifies in the next switch reading that the change
  was actually applied (port enabled or shut down, VLAN, description, VLAN created or deleted, configuration saved) and warns you otherwise.

---

## Screenshots

*All screenshots show the French interface with demo data (fictitious names, IP and MAC addresses).*

**Overview**: indicators, switch front panel, throughput and alerts, in light or dark mode.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/captures/apercu-sombre.png">
  <img alt="Dashboard overview: indicators, switch front panel, throughput and alerts" src="docs/captures/apercu-clair.png">
</picture>

**Live front panel**: active ports (green), no traffic (amber), cable plugged in without a link (blue, with its length), faulty cable (red),
cable state to be checked (amber outline).

![Switch front panel](docs/captures/facade.png)

**Ports and devices**: a single table with name, IP, MAC, throughput and errors, with search and sorting.

![Ports and devices table](docs/captures/ports-appareils.png)

**Port details**: information, actions (enable, restart, description, VLAN) and pair-by-pair cable test.

![Port detail panel with cable test](docs/captures/port-detail.png)

**History**: total or per-port throughput over 1 hour, 24 hours, 7 days or 30 days.

![Throughput history over 24 hours](docs/captures/historique.png)

**VLANs and console**: each VLAN with its mini front panel, and a console that runs any switch command.

![VLAN card and management console](docs/captures/vlan-console.png)

**Settings**: e-mail and/or webhook alerts, monitored ports, temperature threshold, automatic cable checks.

![Alert settings](docs/captures/alertes.png)

---

## How it works

```
┌──────────┐   SSH    ┌───────────────────┐ HTTPS (outbound) ┌──────────────────┐
│  Switch  │ ◄──────► │  Python agent     │ ───────────────► │  Vercel          │ ◄── browser
│ Aruba CX │          │  (PC on the LAN)  │ ◄─────────────── │  page + API      │
└──────────┘          └───────────────────┘     commands     └─────────┬────────┘
                                                                       ▲
                                                                       │ data
                                                                       ▼
                                                          ┌─────────────────────────┐
                                                          │  Supabase (Postgres)    │
                                                          │  5-min job (pg_cron)    │
                                                          └─────────────────────────┘
```

The switch has a private address, so Vercel cannot reach it. An **agent** installed on a PC of the local network
reads the switch over SSH, sends its state to the dashboard and runs the requested commands.
**The agent always contacts Vercel, never the other way around**: no port to open on your network.

Vercel hosts the page and the API. The data (switch state, history, settings, command log,
configuration backups, device directory) is stored in a **Supabase** database (Postgres)
attached to the Vercel project. The tables are created automatically on first launch, and the check that runs
every 5 minutes (agent offline, scheduled actions, backups) is scheduled automatically
in Supabase with pg_cron. E-mail alerts go through Resend (optional).

To stay within the free plans, the agent sends the state every **60 s** when nobody is watching,
every **30 s** for a read-only screen and every **10 s** while the administrator dashboard is open. It then fetches
commands every **5 s** (**1.5 s** right after a command). The page reloads the state right after each upload from
the agent, and only reloads the command log, the alerts and the detailed reading when they have changed.

The agent **updates itself, only from published versions** (the
[Releases](https://github.com/ethanfrq/ArubaDashboardSwitch/releases) page of this repository): code that is still
in development is never installed. If an update fails, the previous version is restored automatically.

---

## Installation

### What you need
- An **HPE Aruba Networking CX** switch with a management IP and SSH enabled (`ssh server vrf default`).
- A **PC that stays on** in the same network as the switch, with internet access.
  Windows is recommended: the agent installs there as a service, and the step-by-step guide is written for it.
  The agent also runs on macOS and Linux.
- A **Vercel** account (free Hobby plan). The **Supabase** database (free plan) is added to it in one click.
  Nothing else to sign up for.

### 1. Deploy the dashboard
1. Click **Deploy with Vercel** above. Vercel copies the project into your GitHub (or GitLab, Bitbucket) account,
   then asks for these three variables:

   | Variable | Purpose | How to generate it |
   |---|---|---|
   | `DASHBOARD_PASSWORD` | administrator password for the page | a strong, unique password |
   | `SESSION_SECRET` | key used to sign sessions | `openssl rand -base64 32` |
   | `AGENT_TOKEN` | token shared with the agent | `openssl rand -hex 32` |

2. Let the first deployment finish: the dashboard will only be complete once the database is added (step 2).

### 2. Add the Supabase database
1. In the Vercel project, open the **Storage** tab and choose **Supabase** (Vercel Marketplace) with the free plan.
2. Choose the **Paris (cdg1)** region to keep the data in Europe, then connect the database to the project.
   The Supabase connection variables are added to the project automatically: there is nothing to copy.
3. Recommended: make sure the Vercel functions run in the same region
   (**Settings > Functions > Function Region**: Paris, cdg1).
4. **Redeploy** the project (**Deployments** tab, ⋯ menu of the latest deployment, **Redeploy**)
   so that it picks up the new variables.

On first launch, the dashboard creates its tables and schedules the 5-minute check in Supabase.
There is no script to run.

**E-mail alerts (optional)**: add **Resend** from the Vercel Marketplace, then redeploy.
Optional variables: `ALERT_FROM` (e-mail sender, for example `Switch <alerts@my-domain.com>`)
and `DASHBOARD_URL` (link included in the alerts). Webhook alerts need no additional service.

### 3. Install the agent
Download the ready-to-use agent from the [latest release](https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest)
(file `aruba-agent-x.y.z.zip`). Everything is explained step by step in [`agent/INSTALL-WINDOWS.md`](agent/INSTALL-WINDOWS.md)
(in French: [`agent/INSTALLATION-WINDOWS.md`](agent/INSTALLATION-WINDOWS.md)). In short:
1. Python 3, then `pip install -r requirements.txt` in the agent's folder.
2. Create `agent_config.json` from `agent_config.example.json`
   (switch IP, dashboard URL, `AGENT_TOKEN`, network to scan to find device IP addresses).
3. Test with `demarrer-agent.bat`, then install it as a service with `installer-service.bat` (as administrator).
   The agent then starts with Windows, without a window, restarts by itself after an error
   and updates itself from the versions published on GitHub.

### 4. First settings
Open the URL of your Vercel project and log in with `DASHBOARD_PASSWORD`. Then, in ⚙ **Réglages** (settings):
- **enable two-factor authentication**: scan the QR code with an app (Google Authenticator, Microsoft Authenticator, and so on)
  and keep the recovery codes somewhere safe; each one works only once;
- set up the alerts (e-mail, webhook, monitored ports, temperature threshold);
- for a monitoring screen, set a password in **Accès lecture seule** (read-only access) and log the screen in with it.

---

## Security

### What is in place
- Password-protected page; signed session (`HttpOnly`, `Secure`, `SameSite=Strict` cookie);
  15-minute lockout after 8 failed attempts.
- **Two-factor authentication** (TOTP) for the administrator account, enabled in ⚙ settings,
  with single-use recovery codes.
- The agent authenticates with `AGENT_TOKEN`. The switch SSH password **never leaves the agent's PC**:
  it is encrypted there by Windows (DPAPI).
- Read-only access is checked by the server on every request: no command except automatic readings (checked line by line),
  no settings, no command history, no configuration diff details. Its password is stored hashed (scrypt);
  changing or disabling it logs out the screens already connected.
- Every change goes through a window that shows the exact lines sent to the switch.
- AOS-CX abbreviations ("int 1/1/24", "shu", and so on) are recognized: they cannot bypass the second confirmation.
  Tabs and control characters are refused; typed text (description, name) cannot add a command line.
- Automatic actions (schedules, cleanup, backups) never run a command considered sensitive.
- Dangerous commands (reboot, erase, accounts, management IP, links to other switches,
  port of the agent's PC, and so on) require a **second confirmation enforced by the server**:
  a single-use token valid for 2 minutes and typing the word CONFIRMER.
- **Hardened web page**: strict Content-Security-Policy (no inline scripts) and systematic escaping of data
  coming from the network (device names announced over LLDP or DNS, descriptions, switch log), so that crafted text
  cannot run in the page. The page cannot be displayed inside a frame on another site.
- The agent only updates from **published versions** (GitHub releases), never from work in progress.
- No secret is committed (`.env*`, `agent_config.json` and `agent_secret.bin` are excluded).
- Your data stays in your own Vercel and Supabase accounts: the author of the project has no access to it.

### Lost phone (two-factor authentication)
Use one of the recovery codes. If you have none left: open the database in Supabase (from Vercel: **Storage** tab,
your database, then **Open in Supabase**), go to the **Table Editor**, open the `mam_kv` table and delete the row
whose key is `mam:totp`. Two-factor authentication is then disabled: log in with the password
and enable it again right away with your new phone.

### Recommendations
- Choose a **strong, unique** administrator password, different from the switch password.
- **Enable two-factor authentication** at the first login.
- Ideally, the management interface of network equipment should only be reachable **through a VPN**
  (WireGuard, Tailscale) rather than exposed publicly. In Vercel mode the page is, by design, reachable
  from the internet: the password and two-factor authentication are therefore essential. The local mode planned
  in the [roadmap](#roadmap) will allow access restricted to the local network or a VPN.
- Do not share the URL needlessly; for a display screen, use read-only access.
- Download the important configuration backups regularly: the Supabase free plan
  does not back up the database automatically.

### Limits of the Vercel mode
- **Vercel's Hobby plan is limited to personal, non-commercial use.** A company or a paid service
  needs a paid Vercel plan (or can wait for the local mode planned in the roadmap).
- The free plans of Vercel and Supabase **do not come with a GDPR data processing agreement**.
  The dashboard stores IP and MAC addresses, device names and the action log, which may be
  personal data. **For a school or an organization, have this choice approved by the person in charge**
  (head of the school, IT manager, data protection officer) before going live.

---

## Compatibility and limits
- Tested on an **HPE Aruba Networking CX 6000 24G 4SFP** (AOS-CX 10.15). The front panel is designed for
  24-port + 4 SFP models. Other CX models may work but have not been tested.
- The switch is read through the CLI over SSH: parsing the output may depend on the firmware version.
- One switch per dashboard, one agent per switch.
- User interface in French only.
- Vercel free plan: at most 12 functions per deployment; the project is designed to stay within this limit.
- Supabase free plan:
  - 500 MB of database and 5 GB of outbound bandwidth per month;
  - the project is paused after 7 days without activity. The agent writes continuously, so this only happens
    if the agent's PC stays off for a week. The project can then be resumed from the Supabase dashboard;
  - no automatic database backup.

## Roadmap
Planned next steps, with no set date:
- **All-in-one local mode**: the agent becomes the server (page and API on the local PC), SQLite database,
  no cloud account, Docker image. Access from the local network or through a VPN.
- **Reading the switch through the AOS-CX REST API** instead of the CLI over SSH.
- **Several switches** in the same dashboard.

## Project structure
| Folder | Contents |
|---|---|
| `public/index.html` | the user interface (a single page, no framework) |
| `public/js/` | the administration features on the page side, one per file |
| `public/vendor/` | third-party library served with the page (QR code for two-factor authentication) |
| `api/` | Vercel functions (Node 24) |
| `lib/` | database (Supabase, Postgres), authentication and roles (administrator, read-only, two-factor), notifications |
| `lib/features/` | the server side of the administration features |
| `agent/` | the Python agent, its automatic update and its installation as a Windows service |
| `docs/` | screenshots and presentation video |

---

## Author
Designed and developed by **Ethan** ([@ethanfrq](https://github.com/ethanfrq)).

## Contributing
[Issues](https://github.com/ethanfrq/ArubaDashboardSwitch/issues) and
[pull requests](https://github.com/ethanfrq/ArubaDashboardSwitch/pulls) are welcome: bugs, ideas,
questions, support for another CX switch model, and more.
- For a bug or another switch model, give the model, the AOS-CX version and the agent version.
  Remove IP and MAC addresses, names and secrets from what you share.
- For a significant change, please open an issue first to discuss it.
- By submitting a contribution, you agree that it is licensed under the Apache License 2.0 (section 5 of the license).

## Releases
What changed in each version is listed in [`CHANGELOG.md`](CHANGELOG.md) (in French) and on the [Releases](https://github.com/ethanfrq/ArubaDashboardSwitch/releases) page.

## License
My Aruba Manager is licensed under the **Apache License 2.0**: see [`LICENSE`](LICENSE).
You may use, modify and redistribute it, including commercially, provided that you include the license,
keep the copyright notices and the [`NOTICE`](NOTICE) file, and state which files you changed.
The license grants no rights to names or trademarks.

Third-party components (postgres, qrcode-generator, paramiko, and others) remain under their own licenses:
see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Trademarks
Aruba, HPE Aruba Networking and AOS-CX are trademarks of Hewlett Packard Enterprise.
My Aruba Manager is an independent project, not affiliated with or endorsed by HPE;
these names are only used to indicate compatibility.
