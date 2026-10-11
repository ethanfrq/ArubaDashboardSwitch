# Installing the My Aruba Manager agent on a Windows PC

*Version française : [INSTALLATION-WINDOWS.md](INSTALLATION-WINDOWS.md)*

The PC must stay on, be on the same network as the switch, be able to reach it over SSH and have internet access.

Complete illustrated guide, from the Vercel deployment to the connected agent:
[docs/GUIDE.en.md](https://github.com/ethanfrq/ArubaDashboardSwitch/blob/main/docs/GUIDE.en.md#6-install-the-agent-on-the-windows-pc).
In the dashboard, the **Démarrage** (getting started) assistant repeats these steps and checks each one live.

## 1. Prepare
1. Install Python 3 from https://www.python.org/downloads/: take the classic installer
   ("standalone installer" link, file `python-3.x.x-amd64.exe`), tick "Add python.exe to PATH"
   on the first screen, then "Install Now".
2. Download the agent from the [latest release](https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest)
   (file `aruba-agent-x.y.z.zip`). The zip contains an `aruba-agent-x.y.z` folder: right-click, "Extract All…"
   to `C:\`, then rename `C:\aruba-agent-x.y.z` to `C:\aruba-agent`. The files (`agent.py`,
   `installer-service.bat`, and so on) must be directly in that folder.
3. In a command prompt opened in that folder (type `cmd` in the File Explorer address bar):
   `python -m pip install -r requirements.txt` (or `pip install -r requirements.txt`).
4. Put the `agent_config.json` file in the agent's folder:
   - **the simplest way**: in the dashboard, **Démarrage** assistant, "Configurer l’agent" (configure the agent) step:
     enter the switch IP, then click "Télécharger agent_config.json" (download, administrators only). The file is
     pre-filled (dashboard address, agent token, pace, automatic update): put it in the agent's folder,
     with this exact name;
   - **manual method**: copy `agent_config.example.json` to `agent_config.json` and fill it in:

     | Key | Value |
     |---|---|
     | `switch_host` | management IP of the switch |
     | `switch_user` | SSH account on the switch (often `admin`) |
     | `dashboard_url` | URL of your Vercel dashboard |
     | `agent_token` | value of the `AGENT_TOKEN` variable set on Vercel |
     | `scan_subnet` | network to scan to find device IP addresses, for example `192.168.1.0/24` (1024 addresses at most: /22 to /30) |
     | `auto_update` | `true`: automatic update from the versions published on GitHub (see below), `false` to turn it off |

   In both cases, `switch_password` stays empty: the password is asked during installation and stored encrypted.
   Never publish `agent_config.json`: it contains the agent token.

## 2. Test by hand (optional)
Double-click `demarrer-agent.bat`, then type the switch SSH password.
The dashboard should show "Agent en ligne" (agent online). Then close the window (Ctrl+C): only one agent can run at a time.

## 3. Install as a service (recommended)
Right-click `installer-service.bat`, then "Run as administrator".
- It asks for the switch SSH password and stores it encrypted by Windows (`agent_secret.bin`, unreadable on another PC).
- It creates the "ArubaDashboardAgent" task: it starts with Windows (even when nobody is logged in),
  runs in the background without a window and restarts by itself after an error.
- It creates the "ArubaDashboardMiseAJour" task: the automatic update (see below).
- Logs: `agent.log` and `mise_a_jour.log` in the agent's folder.

The window should show "Service installé et démarré" (service installed and started). Within a minute, the dashboard
shows "Agent en ligne" (agent online), and the **Démarrage** assistant shows "Agent connecté" (agent connected).

Uninstall: `desinstaller-service.bat` (as administrator).

Restart the agent (for example after replacing `agent_config.json`): run `installer-service.bat` again (right-click,
"Run as administrator") and press Enter without typing anything when the password is asked: the saved password is
kept, the service is stopped and started again.
Check or restart from the command line: in a Command Prompt opened **as administrator** (Start menu, type `cmd`,
right-click "Command Prompt", "Run as administrator"), type `cd /d C:\aruba-agent`, then
`python installer_service.py status` or `python installer_service.py restart`.

For round-the-clock operation, set the PC's sleep setting to "Never".

## Automatic update
The agent **only updates from published versions** on the
[Releases](https://github.com/ethanfrq/ArubaDashboardSwitch/releases) page of the GitHub repository.
Every 5 minutes (and when the PC starts), `mise_a_jour.py` checks whether a new version has been published;
if so, it downloads the agent files of that version and installs the ones that changed.
Code still in development, pushed to the main branch without a new published version, is never installed.
There is nothing else to do.
- Only the agent's files are touched: `agent_config.json`, `agent_secret.bin` and the logs never are.
- Downloaded files are verified, and Python scripts are compiled before being installed.
- The previous version is kept in `.sauvegarde`. If the new agent does not restart properly,
  the previous version is put back automatically and the faulty version is not retried until a new version is published.
- The result of the last check is shown at the bottom of the dashboard ("mise à jour auto ✓").
- To check right away (and reinstall both tasks): right-click `mettre-a-jour.bat`, "Run as administrator".

To approve each version yourself before it is installed, set `auto_update` to `false` in `agent_config.json`,
then run `mettre-a-jour.bat` whenever you decide.

For a test PC that should follow the code in development (main branch), set `update_channel` to `"main"`
in `agent_config.json` (the key is already there, with `"releases"`). Do not do this on the PC connected to the switch
in production.

If you publish your own version of the agent, remember that the PCs automatically install whatever is published as a release:
protect the GitHub account (two-factor authentication) and only publish tested versions.

## Upgrading from an old version (before 1.3.0)
Once, in PowerShell opened as administrator in the agent's folder:

```powershell
Invoke-WebRequest https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest/download/mise_a_jour.py -OutFile mise_a_jour.py
python mise_a_jour.py --installer
```

The script downloads the new version, restarts the agent, checks that it works and then installs both tasks.
The configuration and the stored password are kept. After that, everything is automatic.

## What the agent does
- sends the switch state every 10 s while the administrator dashboard is open, every 30 s for a read-only
  screen, every 60 s otherwise (adjustable in ⚙ Réglages, 120 s at most);
- reads throughput, devices and CPU at each upload, link state and the switch log every 30 s
  (dashboard open), spanning tree and saved configuration every 2 min, the rest less often;
- spaces out all these readings when the switch CPU goes above 60 % (twice as slow) or 80 % (four times as slow);
- fetches commands from the dashboard every 1.5 s right after a command, otherwise every 5 s;
- checks its SSH session before each command (the switch closes sessions left unused), and waits 15 s
  after a failed connection instead of retrying endlessly;
- powers on PCs remotely (Wake-on-LAN) and runs pings at the dashboard's request: Wake-on-LAN must be enabled
  in the BIOS and on the network card of the PCs;
- keeps a result it could not deliver to the dashboard (network down) and sends it again for up to 10 minutes;
- looks up the IP addresses of devices on the `scan_subnet` network every 5 min (the PC's ARP table);
- computes the history (5 min, 30 min, 2 h) and detects incidents for the alerts.
