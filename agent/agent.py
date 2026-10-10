#!/usr/bin/env python3
"""Agent Aruba CX -> dashboard Vercel.

Lit l'état du switch (SSH, ou console série pour les tests), l'envoie au dashboard,
exécute les commandes demandées, calcule l'historique, repère les IP des appareils
et signale les incidents (alertes). Fait aussi lui-même quelques actions demandées par le
dashboard (lignes « # » : allumer un PC par Wake-on-LAN, ping).

    python agent.py                 # fonctionnement normal
    python agent.py --set-password  # enregistre le mot de passe SSH du switch (chiffré)
    python agent.py --once          # un relevé affiché en JSON, sans rien envoyer
"""
import argparse, base64, contextlib, getpass, hashlib, ipaddress, json, logging, math, os, queue, re, socket
import subprocess, sys, threading, time, urllib.error, urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler
from pathlib import Path

AGENT_VERSION = "1.4.0"
HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "agent_config.json").read_text(encoding="utf-8"))
SECRET = HERE / "agent_secret.bin"
CABLES = HERE / "cable_cache.json"
HEARTBEAT = HERE / "agent_etat.json"     # lu par mise_a_jour.py pour vérifier qu'une nouvelle version tourne
UPDATE_STATUS = HERE / "mise_a_jour.json"  # écrit par mise_a_jour.py, affiché dans le dashboard
IS_WIN = os.name == "nt"

# Rythme d'envoi par défaut ; le dashboard le règle (Réglages, « Rythme de l'agent »), voir sync_periods().
IDLE_SYNC = CFG.get("idle_sync", 60)   # personne sur le dashboard : envoi toutes les 60 s
WARM_SYNC = CFG.get("warm_sync", 30)   # écran lecture seule ouvert : toutes les 30 s
HOT_SYNC = CFG.get("hot_sync", 10)     # dashboard administrateur ouvert : toutes les 10 s
# Jamais plus de 2 min entre deux envois, relevé compris et même switch chargé : le serveur juge l'agent hors ligne
# après 3 min (actions planifiées et sauvegardes sautées) et alerte par e-mail après 5 min.
SYNC_MAX, SYNC_REST = 120, 5           # écart maximal entre deux envois, pause minimale entre deux relevés (s)
SYNC_LIMITS = {"hot": (5, SYNC_MAX), "warm": (10, SYNC_MAX), "idle": (10, SYNC_MAX)}  # bornes (s) des valeurs réglées
POLL_BUSY, POLL_EVERY = 1.5, 5         # commandes : toutes les 1,5 s juste après une commande, sinon 5 s
SCAN_EVERY = 300                       # recherche des IP toutes les 5 min
HISTORY_SPAN = 3600                    # débit en direct : la dernière heure
IDLE_ALERT_AFTER = 600                 # lien sans trafic : alerte après 10 min
SESSION_CHECK = 120                    # session de commandes inutilisée depuis 2 min : vérifiée avant usage
CONNECT_PAUSE = 15                     # connexion SSH des commandes en échec : pas de nouvel essai avant 15 s
LINK_PAUSE = (5, 60)                   # liaison perdue : nouvel essai après 5 s, puis 10, 20, 40 et 60 s au plus
AUTH_PAUSE = 300                       # mot de passe SSH refusé : 5 min sans aucun essai (verrouillage du compte)
CAPS = ["wol", "ping"]                 # actions faites par l'agent lui-même (lignes « # »), annoncées au dashboard
WOL_PORTS, WOL_REPEAT, WOL_MAX = (9, 7), 3, 64   # Wake-on-LAN : ports UDP, envois de chaque paquet, adresses par ligne
PING_COUNT, PING_TIMEOUT, PING_LINES = 4, 20, 12  # ping : paquets, durée max (s), lignes de sortie gardées

# Fréquence de chaque relevé (secondes) : (dashboard ouvert, écran lecture seule, personne).
# Le débit, les appareils et le CPU sont relevés à chaque envoi ; le reste change moins souvent et est espacé
# pour ne pas charger le switch. Si son CPU dépasse 60 % (80 %), tout est espacé 2 fois (4 fois) plus.
PERIODS = {
    "links": (30, 60, 120),     # état des liens : dernier changement, coupures
    "logs": (30, 60, 120),      # journal du switch
    "temps": (30, 60, 120), "errors": (30, 60, 120), "lldp": (30, 60, 120),
    "vlans": (60, 120, 300),
    "stp": (120, 300, 600),     # spanning-tree
    "saved": (120, 300, 600),   # configuration sauvegardée ou non
    "ip": (300, 600, 900), "system": (300, 600, 600),
}
LOG_LINES = 50
DIAG_CMDS = {"links": "show interface link-status", "stp": "show spanning-tree",
             "saved": "checkpoint diff startup-config running-config", "logs": f"show logging -r -n {LOG_LINES}",
             "ip": "show ip interface vlan1"}
DIAG_RESEND = 600                      # relevé complet renvoyé au moins toutes les 10 min, sinon seulement s'il change

PROMPT = re.compile(r"[\w.-]+(\([^()]*\))?# ?$")  # y compris (config-if-<1/1/3-1/1/8>)
CONFIRM = re.compile(r"\(y/n\)\??\s*$|\[y/n\]\??\s*$", re.I)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
IN_PROGRESS = re.compile(r"currently in progress|test is in progress", re.I)
NOT_READY = re.compile(r"results for interface \S+ are not available", re.I)
ERROR_LINE = re.compile(r"^\s*(% |Invalid input|Error:|ERROR)")

log = logging.getLogger("agent")


class NotLoggedIn(Exception):
    pass


class SwitchUnreachable(ConnectionError):
    """Connexion SSH des commandes impossible (ou pause de quelques secondes après un échec)."""


def link_errors():
    """Erreurs de liaison avec le switch, y compris celles de paramiko (ex. « Error reading SSH protocol banner »)."""
    pm = sys.modules.get("paramiko")
    ssh = getattr(pm, "SSHException", None) if pm else None
    return (OSError, ConnectionError, EOFError) + ((ssh,) if ssh else ())


def auth_refused(e):
    """Vrai si le switch a refusé l'identification SSH (paramiko.AuthenticationException et ses variantes)."""
    pm = sys.modules.get("paramiko")
    auth = getattr(pm, "AuthenticationException", None) if pm else None
    return isinstance(auth, type) and isinstance(e, auth)


# ================================================================ mot de passe

def _dpapi(data, protect):
    """Chiffrement Windows (DPAPI, portée machine) : lisible par le service, pas copiable ailleurs."""
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = BLOB()
    flags = 0x1 | 0x4  # UI_FORBIDDEN | LOCAL_MACHINE
    fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    args = (ctypes.byref(blob_in), ctypes.c_wchar_p("aruba-agent") if protect else None,
            None, None, None, flags, ctypes.byref(blob_out))
    if not fn(*args):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def store_password(pw):
    data = pw.encode()
    SECRET.write_bytes(_dpapi(data, True) if IS_WIN else base64.b64encode(data))
    if not IS_WIN:
        os.chmod(SECRET, 0o600)


def read_secret():
    raw = SECRET.read_bytes()
    return (_dpapi(raw, False) if IS_WIN else base64.b64decode(raw)).decode()


def load_password():
    if CFG.get("switch_password"):
        return CFG["switch_password"]
    if SECRET.exists():
        return read_secret()
    if sys.stdin and sys.stdin.isatty():
        return getpass.getpass(f"Mot de passe SSH de {CFG['switch_user']}@{CFG['switch_host']} : ")
    raise SystemExit("Aucun mot de passe enregistré : lance « python agent.py --set-password ».")


# ================================================================ transports

class _Base:
    last_io = 0.0  # dernier échange avec le switch
    sends = 0      # nombre de lignes envoyées (pour savoir si une commande a pu partir)

    def alive(self):
        return True

    def _read_until_prompt(self, cmd_echo, timeout):
        buf, end = "", time.time() + timeout
        while time.time() < end:
            d = self._recv()
            if d:
                buf += d
                end = max(end, time.time() + 1)
                if "-- MORE --" in d or "--More--" in d:
                    self._send(" ")
            last = ANSI.sub("", buf.replace("\r", "")).rstrip(" ").split("\n")[-1]
            if re.search(r"login: ?$|Password: ?$", last):
                raise NotLoggedIn()
            if len(buf) > len(cmd_echo) and (PROMPT.search(last) or CONFIRM.search(last)):
                return buf, last
        return buf, ANSI.sub("", buf.replace("\r", "")).split("\n")[-1]

    def run(self, cmd, timeout=20):
        self._drain()
        self._send(cmd + "\r")
        self.sends += 1
        buf, last = self._read_until_prompt(cmd, timeout)
        self.last_io = time.time()
        lines = [ANSI.sub("", l) for l in buf.replace("\r", "").split("\n")]
        return lines[1:-1], last  # sans l'écho ni le prompt


class ConsoleTransport(_Base):
    """Passe par console_bridge.py (/tmp/aruba_console.sock). Pour les tests sur Mac."""
    shared = True

    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.connect(path)
        self.s.settimeout(0.2)

    def _send(self, t):
        self.s.sendall(t.encode())

    def _recv(self):
        try:
            d = self.s.recv(65536)
        except socket.timeout:
            return ""
        if not d:
            raise ConnectionError("bridge fermé")
        return d.decode(errors="replace")

    def _drain(self):
        while self._recv():
            pass

    def close(self):
        self.s.close()


class SSHTransport(_Base):
    shared = False

    def __init__(self, host, user, password):
        import paramiko  # pip install paramiko
        self.c = paramiko.SSHClient()
        self.c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            self.c.connect(host, username=user, password=password, timeout=10,
                           look_for_keys=False, allow_agent=False)
            self.c.get_transport().set_keepalive(30)
            self.ch = self.c.invoke_shell(width=400, height=1000)
            self.ch.settimeout(0.2)
            time.sleep(1.5)
            self._drain()
            self._send("\r")
            self._read_until_prompt("", 10)
            self.run("no page", 5)
        except BaseException:
            self.c.close()  # connexion à moitié ouverte : fermée proprement avant de signaler l'échec
            raise

    def alive(self):
        tr = self.c.get_transport()
        return bool(tr and tr.is_active()) and not self.ch.closed

    def _send(self, t):
        self.ch.send(t)

    def _recv(self):
        try:
            d = self.ch.recv(65536)
        except socket.timeout:
            return ""
        if not d and self.ch.closed:
            raise ConnectionError("session SSH fermée")
        return d.decode(errors="replace")

    def _drain(self):
        while self.ch.recv_ready():
            self.ch.recv(65536)

    def close(self):
        self.c.close()


PASSWORD = None


def reload_password():
    """Relit le mot de passe enregistré après un refus : un « --set-password » fait pendant la pause sert dès
    l'essai suivant, sans redémarrer l'agent."""
    global PASSWORD
    if CFG.get("transport") == "console" or CFG.get("switch_password") or not SECRET.exists():
        return
    try:
        PASSWORD = read_secret()
    except Exception as e:  # noqa: BLE001
        log.warning("Mot de passe enregistré illisible : %s", e)


def connect():
    if CFG.get("transport") == "console":
        return ConsoleTransport(CFG.get("console_socket", "/tmp/aruba_console.sock"))
    return SSHTransport(CFG["switch_host"], CFG["switch_user"], PASSWORD)


# ================================================================ parsers

def slice_cols(header, line):
    names = header.split()
    starts = [header.index(n) for n in names]
    return {n: (line[starts[i]:starts[i + 1]] if i + 1 < len(names) else line[starts[i]:]).strip()
            for i, n in enumerate(names)}


def parse_brief(lines):
    hdr = next(l for l in lines if l.startswith("Port"))
    out = {}
    for l in lines:
        if re.match(r"^1/1/\d+", l):
            c = slice_cols(hdr, l)
            out[c["Port"]] = {"port": c["Port"], "vlan": c["Native"], "mode": c["Mode"],
                              "type": c["Type"], "enabled": c["Enabled"] == "yes",
                              "up": c["Status"] == "up", "reason": c["Reason"],
                              "speed": None if c["Speed"] in ("--", "") else c["Speed"],
                              "desc": "" if c["Description"] == "--" else c["Description"]}
    return out


STAT_KEYS = ["rx_bytes", "rx_pkts", "rx_drops", "tx_bytes", "tx_pkts", "tx_drops",
             "rx_bcast", "rx_mcast", "tx_bcast", "tx_mcast", "rx_pause", "tx_pause"]


def parse_stats(lines):
    out = {}
    for l in lines:
        p = l.split()
        if len(p) == 13 and re.match(r"^1/1/\d+$", p[0]):
            out[p[0]] = dict(zip(STAT_KEYS, map(int, p[1:])))
    return out


def parse_errors(lines):
    out = {}
    for l in lines:
        p = l.split()
        if len(p) == 7 and re.match(r"^1/1/\d+$", p[0]) and all(x.isdigit() for x in p[1:]):
            out[p[0]] = {"rx_errors": int(p[1]), "tx_errors": int(p[2]), "crc": int(p[5])}
    return out


def parse_macs(lines):
    out = []
    for l in lines:
        m = re.match(r"^([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(\d+)\s+(\S+)\s+(\S+)", l.strip())
        if m:
            out.append({"mac": m[1], "vlan": m[2], "type": m[3], "port": m[4]})
    return out


def parse_lldp(lines):
    hdr = next((l for l in lines if l.startswith("LOCAL-PORT")), None)
    if not hdr:
        return []
    return [{"port": c["LOCAL-PORT"], "chassis": c["CHASSIS-ID"], "port_id": c["PORT-ID"],
             "port_desc": c["PORT-DESC"], "name": c["SYS-NAME"]}
            for c in (slice_cols(hdr, l) for l in lines if re.match(r"^1/1/\d+", l))]


def parse_vlans(lines):
    out = []
    for l in lines:
        m = re.match(r"^(\d+)\s+(\S+)\s+(up|down)\s+(\S+)\s+(\S+)\s*(.*)$", l)
        if m:
            out.append({"id": int(m[1]), "name": m[2], "up": m[3] == "up", "reason": m[4],
                        "type": m[5], "ports": m[6].strip()})
    return out


def parse_temps(lines):
    out = []
    for l in lines:
        m = re.match(r"^(\S+)\s+(\S+)\s+([\d.]+) C\s+(\S+)", l)
        if m:
            out.append({"sensor": m[1], "temp": float(m[3]), "status": m[4]})
    return out


def grab(lines, label):
    for l in lines:
        m = re.match(rf"^{re.escape(label)}\s*:\s*(.+?)\s*$", l)
        if m:
            return m[1]
    return None


CABLE_ROW = re.compile(r"^\s*(?:(1/1/\d+)\s+)?(?:\(\S+\)\s+)?(\d-\d)\s+(good|open|intra_short|inter_short|high_imp|low_imp|unknown)"
                       r"\s+(\S+)\s+([\d.]+\s*\+/-\s*[\d.]+|--)", re.I)


def parse_cables(lines):
    """Résultats de « diag cable-diagnostic show » : {port: [{pair, status, imp, dist}]}."""
    res, cur = {}, None
    for l in lines:
        m = CABLE_ROW.match(l)
        if not m:
            continue
        if m[1]:
            cur = m[1]
            res[cur] = []
        if cur:
            res[cur].append({"pair": m[2], "status": m[3].lower(), "imp": m[4], "dist": m[5]})
    return res


def compact_diag(key, lines):
    """Réduit une réponse du relevé détaillé à ce qu'affiche le dashboard, sans ce qui change à chaque lecture
    (« il y a 5 min », compteurs de BPDU) : le relevé n'est renvoyé au dashboard que s'il a vraiment changé."""
    lines = [l.rstrip() for l in lines]
    if key == "links":  # port, type, état, raison, transitions, date du dernier changement
        out = []
        for l in lines:
            cols = re.split(r"\s{2,}", l.strip())
            if re.match(r"^1/1/\d+$", cols[0]) and len(cols) >= 6:
                when = re.search(r"\([^()]*\)", cols[5])
                out.append("  ".join(cols[:5] + [when[0] if when else cols[5]]))
        return out
    if key == "stp":  # état général, racine, et rôle/état de chaque port
        out, seen = [], set()
        for l in lines:
            m = re.match(r"^(1/1/\d+)\s+(\S+)\s+(\S+)\s+(\d+)", l)
            if m and m[1] not in seen:
                seen.add(m[1])
                out.append("  ".join(m.groups()))
            elif not m and re.search(r"status|Root ID|Bridge ID|MAC-Address", l):
                out.append(l.strip())
        return out
    if key == "saved":  # sauvegardée ou non, sans le détail des différences
        if any("No difference" in l for l in lines):
            return ["No difference in configs."]
        diff = [l for l in lines if re.match(r"^[+-]", l)]
        return [f"+ {len(diff)} ligne(s) différente(s)"] if diff else [l for l in lines if ERROR_LINE.match(l)][:1]
    if key == "logs":
        return [l for l in lines if re.match(r"^\d{4}-\d\d-\d\dT", l)][:LOG_LINES]
    if key == "ip":
        return [l.strip() for l in lines if "IPv4 address" in l]
    return lines


def fmt_mac(v):
    """« ec50aa-8b9100 » -> « ec:50:aa:8b:91:00 »."""
    hexa = re.sub(r"[^0-9a-f]", "", (v or "").lower())
    return ":".join(hexa[i:i + 2] for i in range(0, 12, 2)) if len(hexa) == 12 else None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pnum(name):
    return int(name.split("/")[-1])


def is_uplink(port, lldp):
    return any(l["port"] == port and l["name"] and re.search(r"\d{4}|aruba|switch", l["name"], re.I) for l in lldp)


# ================================================================ historique

class Bucket:
    """Moyenne des débits par tranche de temps fixe (5 min, 30 min, 2 h)."""

    def __init__(self, period):
        self.period, self.key, self.acc, self.dt = period, None, None, 0.0

    def add(self, t, dt, values):
        k = int(t // self.period)
        out = None
        if self.key is not None and k != self.key and self.dt > 0:
            out = [self.key * self.period] + [round(v / self.dt) for v in self.acc]
            self.acc, self.dt = None, 0.0
        self.key = k
        self.acc = [a + v * dt for a, v in zip(self.acc, values)] if self.acc else [v * dt for v in values]
        self.dt += dt
        return out


# ================================================================ collecte

class Collector:
    def __init__(self):
        self.prev, self.prev_t, self.history, self.static, self.n = None, None, [], {}, 0
        self.last, self.force, self.cpu = {}, set(), 0.0   # dernier passage de chaque relevé, relevés à refaire
        self.errs, self.lldp, self.diag, self.diag_t = {}, [], {}, 0
        self.diag_text, self.diag_hash, self.diag_sent = "", "", ("", 0)
        self.rx_seen = {}
        self.buckets = {"m5": Bucket(300), "m30": Bucket(1800), "h2": Bucket(7200)}
        self.samples = {k: [] for k in self.buckets}
        self.events = []
        self.prev_up, self.alerted = {}, set()

    def slow_factor(self):
        return 4 if self.cpu >= 80 else 2 if self.cpu >= 60 else 1

    def due(self, key, mode):
        """Vrai si ce relevé doit être refait maintenant (selon le mode et la charge du switch)."""
        hot, warm, idle = PERIODS[key]
        period = {"hot": hot, "warm": warm}.get(mode, idle) * self.slow_factor()
        now = time.time()
        if key in self.force or now - self.last.get(key, 0) >= period - 2:
            self.force.discard(key)
            self.last[key] = now
            return True
        return False

    def collect(self, t, settings, mode="hot"):
        if getattr(t, "shared", False):  # console série partagée : la pagination a pu être réactivée
            t.run("no page", 5)
        if self.due("system", mode):
            sysl, _ = t.run("show system")
            self.static.update(hostname=grab(sysl, "Hostname"), model=grab(sysl, "Product Name"),
                               serial=grab(sysl, "Chassis Serial Nbr"),
                               version=grab(sysl, "AOS-CX Version"), location=grab(sysl, "System Location"),
                               uptime=grab(sysl, "Up Time"), base_mac=fmt_mac(grab(sysl, "Base MAC Address")))
        if self.due("temps", mode):
            self.static["temps"] = parse_temps(t.run("show environment temperature")[0])
        ports = parse_brief(t.run("show interface brief")[0])
        stats = parse_stats(t.run("show interface statistics", 30)[0])
        if self.due("errors", mode):
            self.errs = parse_errors(t.run("show interface error-statistics", 30)[0])
        errs = self.errs
        res, _ = t.run("show system resource-utilization")
        macs = parse_macs(t.run("show mac-address-table")[0])
        if self.due("lldp", mode):
            self.lldp = parse_lldp(t.run("show lldp neighbor-info")[0])
        lldp = self.lldp
        if self.due("vlans", mode):
            self.static["vlans"] = parse_vlans(t.run("show vlan")[0])
        # charge pour espacer les relevés : moyenne sur 1 min (la valeur instantanée varie trop)
        self.cpu = num(grab(res, "CPU usage(% average over 1 minute)")) or num(grab(res, "CPU usage(%)")) or 0.0
        self.diag_step(t, mode)

        now = time.time()
        dt = now - self.prev_t if self.prev_t else None
        tot_rx = tot_tx = 0.0
        per_port = []
        for name in sorted(ports, key=pnum):
            p = ports[name]
            s = stats.get(name, {})
            p.update(s)
            p.update(errs.get(name, {}))
            p["rx_bps"] = p["tx_bps"] = None
            rx = tx = 0.0
            if self.prev and dt and name in self.prev:
                rx = max(0, s.get("rx_bytes", 0) - self.prev[name].get("rx_bytes", 0)) * 8 / dt
                tx = max(0, s.get("tx_bytes", 0) - self.prev[name].get("tx_bytes", 0)) * 8 / dt
                p["rx_bps"], p["tx_bps"] = round(rx), round(tx)  # entiers : état plus léger à envoyer
                tot_rx += rx; tot_tx += tx
            per_port += [rx, tx]
            p["macs"] = sum(1 for m in macs if m["port"] == name)
            seen = self.rx_seen.get(name)
            if not p["up"] or seen is None or s.get("rx_pkts") != seen[0]:
                self.rx_seen[name] = seen = (s.get("rx_pkts"), now)
            p["rx_quiet_since"] = round(seen[1])
            p["uplink"] = is_uplink(name, lldp)

        if dt:
            self.history = [h for h in self.history + [[round(now), round(tot_rx), round(tot_tx)]] if h[0] >= now - HISTORY_SPAN]
            for k, b in self.buckets.items():
                out = b.add(now, dt, [tot_rx, tot_tx] + per_port)
                if out:
                    self.samples[k].append(out)
        self.prev, self.prev_t = stats, now
        state = {**self.static, "updated": now, "ports": [ports[k] for k in sorted(ports, key=pnum)],
                 "macs": macs, "lldp": lldp, "cpu": num(grab(res, "CPU usage(%)")),
                 "mem": num(grab(res, "Memory usage(%)")), "history": self.history,
                 "diag": {"t": round(self.diag_t), "h": self.diag_hash,
                          "every": PERIODS["links"][{"hot": 0, "warm": 1}.get(mode, 2)] * self.slow_factor()}}
        self.detect(state, settings)
        self.n += 1
        return state

    # ------------------------------------------------------------ relevé détaillé
    def diag_step(self, t, mode):
        """Liens, spanning-tree, configuration sauvegardée, journal et IP de gestion, chacun à son rythme."""
        ran = False
        for key, cmd in DIAG_CMDS.items():
            if self.due(key, mode):
                self.diag[key] = compact_diag(key, t.run(cmd, 30)[0])
                ran = True
                if key == "links":
                    self.diag_t = time.time()
        if ran:
            self.diag_text = "\n".join(f"» {DIAG_CMDS[k]}\n" + "\n".join(self.diag[k]) for k in DIAG_CMDS if k in self.diag)
            self.diag_hash = hashlib.sha1(self.diag_text.encode()).hexdigest()[:12]

    def diag_payload(self):
        """Relevé détaillé à joindre à l'envoi : seulement s'il a changé (ou toutes les 10 min)."""
        h, sent_at = self.diag_sent
        if self.diag_text and (h != self.diag_hash or time.time() - sent_at > DIAG_RESEND):
            return {"h": self.diag_hash, "t": round(self.diag_t), "out": self.diag_text}
        return None

    # ------------------------------------------------------------ alertes
    def detect(self, state, settings):
        if self.n == 0:  # premier relevé : on mémorise sans alerter
            self.prev_up = {p["port"]: p["up"] for p in state["ports"]}
            return
        notify = settings.get("notify", {})
        watch = settings.get("watchPorts")
        if not watch:
            watch = [p["port"] for p in state["ports"] if p["uplink"] or p["desc"]]
        watch = set(watch)
        now = state["updated"]

        def ev(key, kind, level, text, port=None, clear=None):
            if clear:
                if key in self.alerted:
                    self.alerted.discard(key)
                    self.events.append({"type": kind, "level": "ok", "port": port, "text": text, "t": now})
            elif key not in self.alerted:
                self.alerted.add(key)
                self.events.append({"type": kind, "level": level, "port": port, "text": text, "t": now})

        for p in state["ports"]:
            n, label = p["port"], f"Port {pnum(p['port'])}" + (f" ({p['desc']})" if p["desc"] else "")
            if notify.get("portDown", True) and n in watch:
                was = self.prev_up.get(n)
                if was and not p["up"]:
                    ev(f"down:{n}", "port_down", "critical", f"{label} est tombé ({p['reason'] or 'lien perdu'}).", n)
                elif p["up"]:
                    ev(f"down:{n}", "port_up", "ok", f"{label} est revenu ({p['speed']} Mb/s).", n, clear=True)
            slow = p["up"] and p["type"] == "1GbT" and (num(p["speed"]) or 1000) < 1000
            if notify.get("slowLink"):
                if slow:
                    ev(f"slow:{n}", "slow_link", "warning", f"{label} négocié à {p['speed']} Mb/s au lieu de 1000 (câble ?).", n)
                else:
                    ev(f"slow:{n}", "slow_link", "ok", f"{label} est revenu à une vitesse normale.", n, clear=True)
            if notify.get("idleLink") and n in watch:
                quiet = p["up"] and now - p["rx_quiet_since"] >= IDLE_ALERT_AFTER
                if quiet:
                    ev(f"idle:{n}", "idle_link", "warning", f"{label} : câble branché mais aucun paquet depuis 10 min.", n)
                else:
                    ev(f"idle:{n}", "idle_link", "ok", f"{label} reçoit de nouveau du trafic.", n, clear=True)
        self.prev_up = {p["port"]: p["up"] for p in state["ports"]}

        temps = state.get("temps") or []
        if notify.get("temp", True) and temps:
            limit = float(settings.get("tempMax") or 70)
            hottest = max(temps, key=lambda x: x["temp"])
            bad = [x for x in temps if x["status"] != "normal"]
            if hottest["temp"] >= limit or bad:
                ev("temp", "temp_high", "critical",
                   f"Température élevée : {hottest['temp']:.0f} °C ({hottest['sensor']}), seuil {limit:.0f} °C.")
            elif hottest["temp"] < limit - 5:
                ev("temp", "temp_ok", "ok", f"Température revenue à la normale ({hottest['temp']:.0f} °C).", clear=True)

    def take(self):
        samples = {k: v[:] for k, v in self.samples.items() if v}
        events = self.events[:]
        return samples, events

    def ack(self, samples, events):
        for k, v in samples.items():
            del self.samples[k][:len(v)]
        del self.events[:len(events)]


# ================================================================ IP des appareils

def norm_mac(m):
    return ":".join(x.zfill(2) for x in re.split(r"[:-]", m.lower()))


def scan_ips(subnet):
    """Provoque une résolution ARP sur tout le sous-réseau puis lit la table ARP du PC."""
    net = ipaddress.ip_network(subnet, strict=False)
    if net.num_addresses > 1024:
        return {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setblocking(False)
    for _ in range(2):
        for ip in net.hosts():
            try:
                s.sendto(b"\0", (str(ip), 9))
            except OSError:
                pass
            time.sleep(0.003)
        time.sleep(1)
    s.close()
    time.sleep(1.5)
    flags = 0x08000000 if IS_WIN else 0  # pas de fenêtre console sous Windows
    txt = subprocess.run(["arp", "-a"], capture_output=True, text=True, errors="replace",
                         timeout=30, creationflags=flags).stdout
    found = {}
    for m in re.finditer(r"(\d+\.\d+\.\d+\.\d+)\)?\s+(?:at\s+)?([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})", txt):
        ip, mac = m[1], norm_mac(m[2])
        if ipaddress.ip_address(ip) in net and mac != "ff:ff:ff:ff:ff:ff" and not mac.startswith("01:00:5e"):
            found[mac] = {"ip": ip}
    ex = ThreadPoolExecutor(16)
    futs = {mac: ex.submit(socket.gethostbyaddr, v["ip"]) for mac, v in found.items()}
    deadline = time.time() + 4
    for mac, f in futs.items():
        try:
            found[mac]["name"] = f.result(timeout=max(0.05, deadline - time.time()))[0].split(".")[0]
        except Exception:  # noqa: BLE001
            pass
    ex.shutdown(wait=False)
    return found


# ================================================================ HTTP

def api(path, payload):
    req = urllib.request.Request(CFG["dashboard_url"].rstrip("/") + path,
                                 data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + CFG["agent_token"],
                                          "User-Agent": f"aruba-agent/{AGENT_VERSION}"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read() or b"{}")


# ================================================================ actions de l'agent (lignes « # »)
# Une ligne de commande qui commence par « # » n'est jamais envoyée au switch : l'agent la fait lui-même.
#   #wol <mac> [<mac> …]   allume des PC (Wake-on-LAN), 1 à 64 adresses aa:bb:cc:dd:ee:ff
#   #ping <ipv4>           ping depuis le PC de l'agent ; dernière ligne « Résultat : 4/4 réponses, 1 ms en moyenne »

MAC_RE = re.compile(r"^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$", re.I)
UNKNOWN_ACTION = "% Action d'agent inconnue"
PING_SUMMARY = (
    re.compile(r"(\d+)\s+packets?\s+transmitted,\s+(\d+)\s+(?:packets?\s+)?received", re.I),          # Linux, macOS
    re.compile(r"(?:Sent|envoy\S*)\s*=\s*(\d+)\s*,\s*(?:Received|re\S{1,2}us)\s*=\s*(\d+)", re.I),  # Windows (EN, FR)
)
PING_AVG = (
    re.compile(r"(?:rtt|round-trip)\s+min/avg/max(?:/\w+)?\s*=\s*[\d.]+/([\d.]+)/", re.I),  # Linux, macOS
    re.compile(r"(?:Average|Moyenne)\s*=\s*(\d+(?:[.,]\d+)?)\s*ms", re.I),                    # Windows
)
PING_TIME = re.compile(r"(?:time|temps)\s*[=<]\s*(\d+(?:[.,]\d+)?)\s*ms", re.I)
PING_REPLY = re.compile(r"\bttl\s*[=:]\s*\d+", re.I)  # vraie réponse (Windows compte aussi « hôte inaccessible »)


def is_agent_line(line):
    return line.lstrip().startswith("#")


def magic_packet(mac):
    """Paquet magique Wake-on-LAN : 6 octets FF puis 16 fois l'adresse MAC."""
    return b"\xff" * 6 + bytes.fromhex(mac.replace(":", "")) * 16


def wol_targets():
    """Adresses de diffusion : générale, et celle du réseau des PC (scan_subnet) quand il est connu."""
    out = ["255.255.255.255"]
    try:
        net = ipaddress.ip_network(str(CFG.get("scan_subnet") or ""), strict=False)
        if net.version == 4 and net.prefixlen <= 30 and str(net.broadcast_address) not in out:
            out.append(str(net.broadcast_address))
    except ValueError:
        pass
    return out


def wake_on_lan(macs):
    """Diffuse le paquet magique de chaque adresse (UDP, ports 9 et 7, 3 fois). Renvoie (lignes, réussite)."""
    sent, err = {m: 0 for m in macs}, {}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    except OSError as e:
        return [f"% Wake-on-LAN impossible : {e}"], False
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        dests = [(ip, port) for ip in wol_targets() for port in WOL_PORTS]
        for rep in range(WOL_REPEAT):
            for mac in macs:
                pkt = magic_packet(mac)
                for d in dests:
                    try:
                        s.sendto(pkt, d)
                        sent[mac] += 1
                    except OSError as e:
                        err[mac] = e
            if rep < WOL_REPEAT - 1:
                time.sleep(0.1)
    except OSError as e:
        return [f"% Wake-on-LAN impossible : {e}"], False
    finally:
        s.close()
    return ([f"Wake-on-LAN envoyé à {m}" if sent[m] else f"% Wake-on-LAN impossible vers {m} : {err.get(m)}" for m in macs],
            all(sent.values()))


def valid_ipv4(text):
    """Adresse IPv4 d'un appareil, normalisée (ni multicast, ni diffusion, ni 0.0.0.0) ; sinon None."""
    try:
        ip = ipaddress.IPv4Address(str(text))
    except ValueError:
        return None
    if ip.is_multicast or ip.is_unspecified or int(ip) == 0xFFFFFFFF:
        return None
    return str(ip)


def console_text(raw):
    """Sortie d'un programme en texte : UTF-8, sinon page de code de la console Windows (cp850 en français)."""
    encs = ["utf-8"]
    if IS_WIN:
        try:
            import ctypes
            encs.append(f"cp{ctypes.windll.kernel32.GetOEMCP()}")
        except Exception:  # noqa: BLE001
            pass
    for enc in encs:
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            pass
    return raw.decode("cp1252", errors="replace")


def parse_ping(text):
    """Sortie d'un ping (Windows en français ou en anglais, Linux, macOS) -> (envoyés, reçus, moyenne en ms ou None).
    Seules les vraies réponses comptent : Windows compte « Impossible de joindre l'hôte » comme une réponse."""
    sent = received = avg = None
    for rx in PING_SUMMARY:
        m = rx.search(text)
        if m:
            sent, received = int(m[1]), int(m[2])
            break
    replies = len(PING_REPLY.findall(text))
    received = replies if received is None else min(received, replies)
    if sent is None:
        sent = max(PING_COUNT, received)
    if received:
        for rx in PING_AVG:
            m = rx.search(text)
            if m:
                avg = float(m[1].replace(",", "."))
                break
        if avg is None:
            times = [float(x.replace(",", ".")) for x in PING_TIME.findall(text)]
            avg = sum(times) / len(times) if times else None
    return sent, received, avg


def ping_result(sent, received, avg):
    """Ligne lue par le dashboard : « Résultat : 4/4 réponses, 0.5 ms en moyenne » (ou « Résultat : 0/4 réponses »)."""
    if received and avg is not None:
        ms = f"{avg:.1f}".rstrip("0").rstrip(".")
        return f"Résultat : {received}/{sent} réponses, {ms} ms en moyenne"
    return f"Résultat : {received}/{sent} réponses"


def ping(ip):
    """Ping système (liste d'arguments, jamais de shell), 20 s au plus. Renvoie (lignes, réussite)."""
    if IS_WIN:
        args = ["ping", "-n", str(PING_COUNT), "-w", "1000", ip]
    else:  # délai de réponse : en secondes sous Linux, en millisecondes sous macOS
        args = ["ping", "-c", str(PING_COUNT), "-W", "1000" if sys.platform == "darwin" else "1", ip]
    try:
        p = subprocess.run(args, capture_output=True, timeout=PING_TIMEOUT, creationflags=0x08000000 if IS_WIN else 0)
    except subprocess.TimeoutExpired:
        return [f"% Ping interrompu : toujours en cours après {PING_TIMEOUT} s", ping_result(PING_COUNT, 0, None)], False
    except OSError as e:
        return [f"% Ping impossible sur ce PC : {e}"], False
    text = console_text((p.stdout or b"") + (p.stderr or b""))
    lines = [l.strip() for l in text.replace("\r", "").split("\n") if l.strip()]
    return lines[:PING_LINES] + [ping_result(*parse_ping(text))], True


def agent_action(line):
    """Ligne « # » d'une commande, faite par l'agent lui-même. Renvoie (lignes de sortie, réussite)."""
    words = line.split()
    name, args = (words[0].lower(), words[1:]) if words else ("", [])
    if name == "#wol" and 1 <= len(args) <= WOL_MAX and all(MAC_RE.match(a) for a in args):
        return wake_on_lan(list(dict.fromkeys(a.lower() for a in args)))
    if name == "#ping" and len(args) == 1:
        ip = valid_ipv4(args[0])
        if ip:
            return ping(ip)
    return [UNKNOWN_ACTION], False


# ================================================================ commandes

CONFIG_LINE = re.compile(r"^(conf|interface|vlan|no |shutdown|description|name|write|copy|checkpoint)", re.I)


class Commander(threading.Thread):
    """Exécute les commandes du dashboard ; relève la file quand quelqu'un regarde le dashboard
    (toutes les 1,5 s juste après une commande, sinon toutes les 5 s)."""

    def __init__(self, agent):
        super().__init__(daemon=True)
        self.agent, self.q, self.t, self.busy = agent, queue.Queue(), None, False
        self.down_until, self.down_err = 0.0, ""  # dernier échec de connexion SSH : pause avant un nouvel essai
        self.pending, self.pending_try = [], 0.0   # résultats pas encore remis au dashboard (réseau coupé)

    def reset(self):
        try:
            self.t and self.t.close()
        except Exception:  # noqa: BLE001
            pass
        self.t = None

    def hold(self, pause, why):
        """Aucune connexion des commandes avant « pause » secondes (aussi décidé par la boucle principale)."""
        self.down_until, self.down_err = max(self.down_until, time.time() + pause), why

    def usable(self):
        """Le switch ferme une session SSH restée inutilisée : on la vérifie avant de s'en servir."""
        if not self.t.alive():
            return False
        if time.time() - self.t.last_io < SESSION_CHECK:
            return True
        try:
            return bool(PROMPT.search(self.t.run("", 5)[1]))
        except Exception:  # noqa: BLE001
            return False

    def transport(self):
        if CFG.get("transport") == "console":
            return self.agent.ensure_transport(), self.agent.tlock
        if self.t is not None and not self.usable():
            log.info("Session de commandes expirée : reconnexion au switch.")
            self.reset()
        if self.t is None:
            wait = self.down_until - time.time()
            if wait > 0:  # échec récent : on ne réessaie pas tout de suite, pour ne pas marteler le switch
                raise SwitchUnreachable(f"connexion SSH au switch impossible ({self.down_err}). "
                                        f"Nouvel essai possible dans {math.ceil(wait)} s.")
            try:
                self.t = connect()
            except Exception as e:  # noqa: BLE001  (bannière SSH illisible, connexion refusée, mot de passe…)
                self.reset()
                auth = auth_refused(e)  # mot de passe refusé : pause longue, pour ne pas faire verrouiller le compte
                pause = AUTH_PAUSE if auth else CONNECT_PAUSE
                self.hold(pause, "mot de passe SSH refusé par le switch" if auth else (str(e) or type(e).__name__)[:200])
                log.warning("Commandes : connexion au switch impossible (%s), pas de nouvel essai avant %d s.",
                            self.down_err, pause)
                raise SwitchUnreachable(f"connexion SSH au switch impossible ({self.down_err}).") from e
            self.down_until = 0.0
        return self.t, threading.Lock()

    def post_result(self, payload):
        """Remet un résultat au dashboard ; s'il est injoignable (ex. un changement sensible a coupé le réseau du PC),
        le résultat est gardé et renvoyé plus tard, jusqu'à 10 min, au lieu d'être perdu."""
        try:
            api("/api/agent/result", payload)
        except Exception as e:  # noqa: BLE001
            log.warning("Résultat %s non remis (%s) : nouvel essai plus tard.", payload["id"][:8], e)
            self.pending = (self.pending + [(time.time(), payload)])[-20:]

    def flush_pending(self):
        if not self.pending or time.time() - self.pending_try < 15:
            return
        self.pending_try = time.time()
        self.pending = [x for x in self.pending if time.time() - x[0] < 600]
        while self.pending:
            try:
                api("/api/agent/result", self.pending[0][1])
            except Exception:  # noqa: BLE001
                return  # toujours injoignable : nouvel essai dans 15 s
            log.info("Résultat %s remis avec retard.", self.pending.pop(0)[1]["id"][:8])

    def run(self):
        while True:
            try:
                self.flush_pending()
                if self.agent.hot():
                    r = api("/api/agent/poll", {})
                    self.busy = bool(r.get("busy"))
                    if not r.get("hot"):  # plus personne sur le dashboard : la file est relevée à chaque envoi
                        self.agent.hot_until = 0
                    for c in r.get("commands", []):
                        self.q.put(c)
                while not self.q.empty():
                    self.execute(self.q.get())
            except Exception as e:  # noqa: BLE001
                log.warning("Commandes : %s", e)
                if isinstance(e, link_errors()):
                    self.reset()
                time.sleep(3)
            time.sleep((POLL_BUSY if self.busy else POLL_EVERY) if self.agent.hot() else 1)

    def wait_answer(self, cid):
        end = time.time() + 90
        while time.time() < end:
            r = api("/api/agent/poll", {"waiting": cid})
            for c in r.get("commands", []):
                self.q.put(c)
            if r.get("answer") in ("y", "n"):
                return r["answer"]
            time.sleep(1)
        return None

    def execute(self, c):
        log.info("Commande %s : %r", c["id"][:8], c["cmd"][:80])
        lines = [l.rstrip() for l in c["cmd"].replace("\r", "").split("\n") if l.strip()]
        st = {"out": [], "ok": True, "i": 0}  # sortie, réussite, prochaine ligne à exécuter
        for attempt in (1, 2):
            if not self._execute(c, lines, attempt, st):
                break
            log.info("Commande %s : session coupée avant l'envoi, nouvel essai.", c["id"][:8])
        out, ok = st["out"], st["ok"]
        if any(CONFIG_LINE.match(l.strip()) for l in lines):
            self.agent.col.force.update(("saved", "links", "vlans", "stp"))  # refléter le changement tout de suite
        found = parse_cables(out)
        if found:
            now = round(time.time())
            for port, rows in found.items():
                self.agent.cables[port] = {"t": now, "rows": rows}
            try:
                CABLES.write_text(json.dumps(self.agent.cables), encoding="utf-8")
            except OSError:
                pass
        self.post_result({"id": c["id"], "status": "done" if ok else "error", "output": "\n".join(out).strip()})
        if not all(is_agent_line(l) for l in lines):
            self.agent.wake.set()  # relevé immédiat pour refléter le changement (inutile après un ping ou un réveil)

    def _execute(self, c, lines, attempt, st):
        """Exécute les lignes à partir de st["i"] en complétant st["out"] et st["ok"]. Renvoie vrai s'il faut réessayer :
        on ne réessaie que si rien n'a pu être envoyé au switch. Les lignes « # » sont faites par l'agent lui-même,
        sans ouvrir de session SSH, et ne sont jamais refaites lors du nouvel essai."""
        out, last, t, sent, tested = st["out"], "", None, 0, False
        with contextlib.ExitStack() as held:
            try:
                while st["i"] < len(lines):
                    i = st["i"]
                    if is_agent_line(lines[i]):
                        try:
                            body, good = agent_action(lines[i].strip())
                        except Exception as e:  # noqa: BLE001  (jamais refaite, même en cas d'imprévu)
                            body, good = [f"% Action de l'agent en échec : {e}"], False
                        out.append("» " + lines[i])
                        out.extend(body)
                        st["ok"] = st["ok"] and good
                        st["i"] = i + 1
                        continue
                    if t is None:  # session ouverte à la première ligne destinée au switch
                        t, lock = self.transport()
                        held.enter_context(lock)
                        sent = t.sends
                    body, last = t.run(lines[i], 90)
                    tested = tested or "cable-diagnostic test" in lines[i]
                    for _ in range(8):  # test de câble : le résultat arrive quelques secondes plus tard
                        waiting = any(IN_PROGRESS.search(l) or (tested and NOT_READY.search(l)) for l in body)
                        if not waiting:
                            break
                        time.sleep(3)
                        body, last = t.run(lines[i], 30)
                    out.append("» " + lines[i])
                    out.extend(body)
                    st["ok"] = st["ok"] and not any(ERROR_LINE.match(l) for l in body)
                    if CONFIRM.search(last):
                        question = last.strip()
                        nxt = lines[i + 1].strip().lower() if i + 1 < len(lines) else ""
                        if nxt in ("y", "n"):
                            ans, i = nxt, i + 1
                            out.append(f"{question} {ans}")
                        else:
                            api("/api/agent/result", {"id": c["id"], "status": "confirm", "question": question,
                                                      "output": "\n".join(out + [question])})
                            ans = self.wait_answer(c["id"])
                            if ans is None:
                                ans = "n"
                                out.append(f"{question} n   (pas de réponse en 90 s : refusé)")
                            else:
                                out.append(f"{question} {ans}")
                        body, last = t.run(ans, 180)
                        out.extend(body)
                        st["ok"] = st["ok"] and not any(ERROR_LINE.match(l) for l in body)
                    st["i"] = i + 1
                if t is not None and "(config" in last:  # ne jamais laisser la session en mode configuration
                    t.run("end", 10)
            except NotLoggedIn:
                out.append("Session console non connectée sur le switch.")
                st["ok"] = False
            except Exception as e:  # noqa: BLE001
                self.reset()
                if attempt == 1 and not isinstance(e, SwitchUnreachable) and (t is None or t.sends == sent):
                    return True
                out.append(f"Erreur : {e}")
                st["ok"] = False
        return False


# ================================================================ boucle principale

def sync_periods(settings):
    """Secondes entre deux envois selon le mode (hot, warm, idle) : réglées depuis le dashboard (réglages « agent »),
    sinon celles du fichier de configuration ; bornées (dashboard ouvert 5 à 120 s, sinon 10 à 120 s)."""
    conf = settings.get("agent") if isinstance(settings, dict) else None
    conf = conf if isinstance(conf, dict) else {}
    out = {}
    for mode, default, fallback in (("hot", HOT_SYNC, 10), ("warm", WARM_SYNC, 30), ("idle", IDLE_SYNC, 60)):
        lo, hi = SYNC_LIMITS[mode]
        v = next((x for x in (num(conf.get(mode)), num(default), fallback) if x is not None and math.isfinite(x)))
        out[mode] = int(round(min(hi, max(lo, v))))
    return out


class Agent:
    def __init__(self):
        self.col, self.t, self.tlock = Collector(), None, threading.Lock()
        self.settings, self.sver, self.hot_until, self.warm_until = {}, None, 0, 0
        self.ips, self.last_scan, self.wake = {}, 0, threading.Event()
        self.fails = 0  # échecs de liaison consécutifs avec le switch
        self.spans = deque(maxlen=10)  # durée (relevé et envoi) des 10 derniers tours de boucle
        try:
            self.cables = json.loads(CABLES.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cables = {}
        self.commander = Commander(self)

    def hot(self):
        return time.time() < self.hot_until

    def mode(self):
        return "hot" if self.hot() else "warm" if time.time() < self.warm_until else "idle"

    def interval(self, mode=None):
        """Secondes entre deux envois : rythme réglé, doublé si le switch est très chargé, 120 s au plus."""
        base = sync_periods(self.settings)[mode or self.mode()]
        return min(SYNC_MAX, base * (2 if self.col.cpu >= 80 else 1))

    def pause(self, started):
        """Attente après un envoi : le rythme, mais jamais plus de SYNC_MAX entre deux envois, relevés lents compris
        (on retranche le plus long des derniers tours : le prochain relevé peut être plus lourd que celui-ci), et au
        moins SYNC_REST pour laisser souffler le switch."""
        self.spans.append(time.time() - started)
        return min(self.interval(), max(SYNC_REST, SYNC_MAX - max(self.spans)))

    def link_pause(self, e, auth):
        """Attente avant de retenter le switch : de plus en plus longue si l'échec se répète ; 5 min si le mot de passe
        est refusé, et les commandes attendent aussi (aucun des deux fils ne relance le switch pendant ce temps)."""
        self.fails += 1
        if auth:
            log.error("Mot de passe SSH refusé par le switch : enregistre le bon avec « python agent.py --set-password ». "
                      "Nouvel essai dans %d min.", AUTH_PAUSE // 60)
            self.commander.hold(AUTH_PAUSE, "mot de passe SSH refusé par le switch")
            return AUTH_PAUSE
        pause = min(LINK_PAUSE[1], LINK_PAUSE[0] * 2 ** min(self.fails - 1, 10))
        log.warning("Liaison switch perdue : %s. Nouvel essai dans %d s.", e, pause)
        return pause

    def ensure_transport(self):
        if self.t is None:
            self.t = connect()
            log.info("Connecté au switch.")
        return self.t

    def scan(self):
        try:
            self.ips = scan_ips(CFG["scan_subnet"])
            log.info("Recherche IP : %d appareil(s) trouvé(s).", len(self.ips))
        except Exception as e:  # noqa: BLE001
            log.warning("Recherche IP impossible : %s", e)

    def run(self):
        self.commander.start()
        while True:
            started = time.time()
            try:
                with self.tlock:
                    state = self.col.collect(self.ensure_transport(), self.settings, self.mode())
                if self.fails:  # liaison revenue : les commandes peuvent de nouveau se connecter sans attendre
                    log.info("Liaison switch rétablie.")
                    self.fails, self.commander.down_until = 0, 0.0
                took = time.time() - started
                if took > 15:
                    log.info("Relevé lent : %.0f s (CPU du switch %.0f %%).", took, self.col.cpu)
                if CFG.get("scan_subnet") and time.time() - self.last_scan > SCAN_EVERY:
                    self.last_scan = time.time()
                    threading.Thread(target=self.scan, daemon=True).start()
                state["ips"] = self.ips
                state["cables"] = self.cables
                if CFG.get("transport") != "console":
                    state["mgmt_ip"] = CFG.get("switch_host")
                state["agent"] = {"version": AGENT_VERSION, "host": socket.gethostname(),
                                  "scan": CFG.get("scan_subnet"), "sync": self.interval(), "took": round(took, 1),
                                  "maj": read_update_status(), "caps": CAPS}
                samples, events = self.col.take()
                diag = self.col.diag_payload()
                r = api("/api/agent/sync", {"state": state, "samples": samples, "events": events, "sver": self.sver,
                                            **({"diag": diag} if diag else {})})
                self.col.ack(samples, events)
                if diag:
                    self.col.diag_sent = (diag["h"], time.time())
                if "settings" in r:
                    self.settings, self.sver = r["settings"] or {}, r.get("sver")
                # mode valable jusqu'au prochain envoi (au moins 75 s), même si le rythme réglé est lent
                self.hot_until = time.time() + max(75, self.interval("hot") + 15) if r.get("hot") else 0
                self.warm_until = time.time() + max(75, self.interval("warm") + 15) if r.get("warm") else 0
                for c in r.get("commands", []):
                    self.commander.q.put(c)
            except NotLoggedIn:
                log.warning("Session non connectée sur le switch (prompt login). Nouvel essai dans 30 s.")
                if CFG.get("transport") != "console":
                    self.t = None
                heartbeat()
                time.sleep(30)
                continue
            except urllib.error.HTTPError as e:
                log.warning("Dashboard : HTTP %s %r", e.code, e.read()[:200])
            except (urllib.error.URLError, TimeoutError) as e:
                log.warning("Dashboard injoignable : %s", e)
            except link_errors() as e:  # bannière SSH illisible, mot de passe refusé… : on réessaie, l'agent ne s'arrête pas
                try:
                    self.t and self.t.close()
                except Exception:  # noqa: BLE001
                    pass
                self.t = None
                heartbeat()
                auth = auth_refused(e)
                time.sleep(self.link_pause(e, auth))
                if auth:
                    reload_password()
                continue
            heartbeat()  # la boucle tourne (même sans internet ou sans switch) ; un bug, lui, l'arrête avant
            self.wake.wait(self.pause(started))
            self.wake.clear()


def heartbeat():
    """Preuve de vie locale : mise_a_jour.py vérifie ainsi qu'une nouvelle version tourne sans planter."""
    try:
        HEARTBEAT.write_text(json.dumps({"t": round(time.time()), "version": AGENT_VERSION}), encoding="utf-8")
    except OSError:
        pass


def read_update_status():
    try:
        st = json.loads(UPDATE_STATUS.read_text(encoding="utf-8"))
        return {k: st.get(k) for k in ("t", "ok", "msg", "commit")}
    except (OSError, ValueError):
        return None


def setup_logging():
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(HERE / "agent.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if sys.stdout:
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        log.addHandler(sh)


def single_instance():
    """Empêche deux agents de tourner en même temps (service + lancement manuel)."""
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 48723))
    except OSError:
        raise SystemExit("Un agent tourne déjà sur ce PC.")
    return s


def main():
    global PASSWORD
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--set-password", action="store_true")
    a = ap.parse_args()
    if a.set_password:
        pw = getpass.getpass(f"Mot de passe SSH de {CFG.get('switch_user')}@{CFG.get('switch_host')} : ")
        if pw:
            store_password(pw)
            print("Mot de passe enregistré (chiffré)." if IS_WIN else "Mot de passe enregistré.")
        else:
            print("Rien de changé.")
        return
    setup_logging()
    if CFG.get("transport") != "console":
        PASSWORD = load_password()
    if a.once:
        col, t = Collector(), connect()
        col.collect(t, {})
        time.sleep(3)
        print(json.dumps(col.collect(t, {}), indent=1, ensure_ascii=False))
        return
    lock = single_instance()  # noqa: F841 (gardé ouvert pendant toute la durée)
    log.info("Agent %s démarré (%s).", AGENT_VERSION, CFG.get("transport", "ssh"))
    Agent().run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
