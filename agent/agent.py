#!/usr/bin/env python3
"""Agent Aruba CX -> dashboard Vercel.

Lit l'état du switch (SSH, ou console série pour les tests), l'envoie au dashboard,
exécute les commandes demandées, calcule l'historique, repère les IP des appareils
et signale les incidents (alertes).

    python agent.py                 # fonctionnement normal
    python agent.py --set-password  # enregistre le mot de passe SSH du switch (chiffré)
    python agent.py --once          # un relevé affiché en JSON, sans rien envoyer
"""
import argparse, base64, getpass, ipaddress, json, logging, os, queue, re, socket, subprocess
import sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "agent_config.json").read_text(encoding="utf-8"))
SECRET = HERE / "agent_secret.bin"
CABLES = HERE / "cable_cache.json"
IS_WIN = os.name == "nt"

IDLE_SYNC = CFG.get("idle_sync", 60)   # personne sur le dashboard : envoi toutes les 60 s
HOT_SYNC = CFG.get("hot_sync", 10)     # dashboard ouvert : toutes les 10 s
POLL_EVERY = 1.5                       # dashboard ouvert : commandes relevées toutes les 1,5 s
SCAN_EVERY = 300                       # recherche des IP toutes les 5 min
HISTORY_MAX = 360                      # 1 h de points à 10 s
IDLE_ALERT_AFTER = 600                 # lien sans trafic : alerte après 10 min

PROMPT = re.compile(r"[\w.-]+(\([\w./-]+\))?# ?$")
CONFIRM = re.compile(r"\(y/n\)\??\s*$|\[y/n\]\??\s*$", re.I)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
IN_PROGRESS = re.compile(r"currently in progress|test is in progress", re.I)
NOT_READY = re.compile(r"results for interface \S+ are not available", re.I)
ERROR_LINE = re.compile(r"^\s*(% |Invalid input|Error:|ERROR)")

log = logging.getLogger("agent")


class NotLoggedIn(Exception):
    pass


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


def load_password():
    if CFG.get("switch_password"):
        return CFG["switch_password"]
    if SECRET.exists():
        raw = SECRET.read_bytes()
        return (_dpapi(raw, False) if IS_WIN else base64.b64decode(raw)).decode()
    if sys.stdin and sys.stdin.isatty():
        return getpass.getpass(f"Mot de passe SSH de {CFG['switch_user']}@{CFG['switch_host']} : ")
    raise SystemExit("Aucun mot de passe enregistré : lance « python agent.py --set-password ».")


# ================================================================ transports

class _Base:
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
        buf, last = self._read_until_prompt(cmd, timeout)
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
        self.c.connect(host, username=user, password=password, timeout=10,
                       look_for_keys=False, allow_agent=False)
        self.ch = self.c.invoke_shell(width=400, height=1000)
        self.ch.settimeout(0.2)
        time.sleep(1.5)
        self._drain()
        self._send("\r")
        self._read_until_prompt("", 10)
        self.run("no page", 5)

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
        self.rx_seen = {}
        self.buckets = {"m5": Bucket(300), "m30": Bucket(1800), "h2": Bucket(7200)}
        self.samples = {k: [] for k in self.buckets}
        self.events = []
        self.prev_up, self.alerted = {}, set()

    def collect(self, t, settings):
        t.run("no page", 5)
        if self.n % 10 == 0:
            sysl, _ = t.run("show system")
            self.static.update(hostname=grab(sysl, "Hostname"), model=grab(sysl, "Product Name"),
                               serial=grab(sysl, "Chassis Serial Nbr"),
                               version=grab(sysl, "AOS-CX Version"), location=grab(sysl, "System Location"),
                               uptime=grab(sysl, "Up Time"))
        self.static["temps"] = parse_temps(t.run("show environment temperature")[0])
        ports = parse_brief(t.run("show interface brief")[0])
        stats = parse_stats(t.run("show interface statistics", 30)[0])
        errs = parse_errors(t.run("show interface error-statistics", 30)[0])
        res, _ = t.run("show system resource-utilization")
        macs = parse_macs(t.run("show mac-address-table")[0])
        lldp = parse_lldp(t.run("show lldp neighbor-info")[0])
        self.static["vlans"] = parse_vlans(t.run("show vlan")[0])

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
            if self.prev and dt and name in self.prev:
                p["rx_bps"] = max(0, s.get("rx_bytes", 0) - self.prev[name].get("rx_bytes", 0)) * 8 / dt
                p["tx_bps"] = max(0, s.get("tx_bytes", 0) - self.prev[name].get("tx_bytes", 0)) * 8 / dt
                tot_rx += p["rx_bps"]; tot_tx += p["tx_bps"]
            per_port += [p["rx_bps"] or 0, p["tx_bps"] or 0]
            p["macs"] = sum(1 for m in macs if m["port"] == name)
            seen = self.rx_seen.get(name)
            if not p["up"] or seen is None or s.get("rx_pkts") != seen[0]:
                self.rx_seen[name] = seen = (s.get("rx_pkts"), now)
            p["rx_quiet_since"] = round(seen[1])
            p["uplink"] = is_uplink(name, lldp)

        if dt:
            self.history = (self.history + [[round(now), round(tot_rx), round(tot_tx)]])[-HISTORY_MAX:]
            for k, b in self.buckets.items():
                out = b.add(now, dt, [tot_rx, tot_tx] + per_port)
                if out:
                    self.samples[k].append(out)
        self.prev, self.prev_t = stats, now
        state = {**self.static, "updated": now, "ports": [ports[k] for k in sorted(ports, key=pnum)],
                 "macs": macs, "lldp": lldp, "cpu": num(grab(res, "CPU usage(%)")),
                 "mem": num(grab(res, "Memory usage(%)")), "history": self.history}
        self.detect(state, settings)
        self.n += 1
        return state

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
                                          "User-Agent": "aruba-agent/2"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read() or b"{}")


# ================================================================ commandes

class Commander(threading.Thread):
    """Exécute les commandes du dashboard ; relève la file toutes les 1,5 s quand quelqu'un regarde."""

    def __init__(self, agent):
        super().__init__(daemon=True)
        self.agent, self.q, self.t = agent, queue.Queue(), None

    def transport(self):
        if CFG.get("transport") == "console":
            return self.agent.ensure_transport(), self.agent.tlock
        if self.t is None:
            self.t = connect()
        return self.t, threading.Lock()

    def run(self):
        while True:
            try:
                if self.agent.hot():
                    for c in api("/api/agent/poll", {}).get("commands", []):
                        self.q.put(c)
                while not self.q.empty():
                    self.execute(self.q.get())
            except Exception as e:  # noqa: BLE001
                log.warning("Commandes : %s", e)
                if isinstance(e, (OSError, ConnectionError, EOFError)) and self.t:
                    self.t = None
                time.sleep(3)
            time.sleep(POLL_EVERY if self.agent.hot() else 1)

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
        out, ok, last = [], True, ""
        try:
            t, lock = self.transport()
            with lock:
                i, tested = 0, False
                while i < len(lines):
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
                    ok = ok and not any(ERROR_LINE.match(l) for l in body)
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
                        ok = ok and not any(ERROR_LINE.match(l) for l in body)
                    i += 1
                if "(config" in last:  # ne jamais laisser la session en mode configuration
                    t.run("end", 10)
        except NotLoggedIn:
            out.append("Session console non connectée sur le switch.")
            ok = False
        except Exception as e:  # noqa: BLE001
            out.append(f"Erreur : {e}")
            ok = False
            self.t = None
        found = parse_cables(out)
        if found:
            now = round(time.time())
            for port, rows in found.items():
                self.agent.cables[port] = {"t": now, "rows": rows}
            try:
                CABLES.write_text(json.dumps(self.agent.cables), encoding="utf-8")
            except OSError:
                pass
        api("/api/agent/result", {"id": c["id"], "status": "done" if ok else "error", "output": "\n".join(out).strip()})
        self.agent.wake.set()  # relevé immédiat pour refléter le changement


# ================================================================ boucle principale

class Agent:
    def __init__(self):
        self.col, self.t, self.tlock = Collector(), None, threading.Lock()
        self.settings, self.sver, self.hot_until = {}, None, 0
        self.ips, self.last_scan, self.wake = {}, 0, threading.Event()
        try:
            self.cables = json.loads(CABLES.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cables = {}
        self.commander = Commander(self)

    def hot(self):
        return time.time() < self.hot_until

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
            try:
                with self.tlock:
                    state = self.col.collect(self.ensure_transport(), self.settings)
                if CFG.get("scan_subnet") and time.time() - self.last_scan > SCAN_EVERY:
                    self.last_scan = time.time()
                    threading.Thread(target=self.scan, daemon=True).start()
                state["ips"] = self.ips
                state["cables"] = self.cables
                state["agent"] = {"version": 2, "host": socket.gethostname(),
                                  "scan": CFG.get("scan_subnet"), "sync": HOT_SYNC if self.hot() else IDLE_SYNC}
                samples, events = self.col.take()
                r = api("/api/agent/sync", {"state": state, "samples": samples, "events": events, "sver": self.sver})
                self.col.ack(samples, events)
                if "settings" in r:
                    self.settings, self.sver = r["settings"] or {}, r.get("sver")
                self.hot_until = time.time() + 75 if r.get("hot") else 0
                for c in r.get("commands", []):
                    self.commander.q.put(c)
            except NotLoggedIn:
                log.warning("Session non connectée sur le switch (prompt login). Nouvel essai dans 30 s.")
                if CFG.get("transport") != "console":
                    self.t = None
                time.sleep(30)
                continue
            except urllib.error.HTTPError as e:
                log.warning("Dashboard : HTTP %s %r", e.code, e.read()[:200])
            except (urllib.error.URLError, TimeoutError) as e:
                log.warning("Dashboard injoignable : %s", e)
            except (OSError, ConnectionError, EOFError) as e:
                log.warning("Liaison switch perdue : %s. Reconnexion…", e)
                try:
                    self.t and self.t.close()
                except Exception:  # noqa: BLE001
                    pass
                self.t = None
                time.sleep(5)
                continue
            self.wake.wait(HOT_SYNC if self.hot() else IDLE_SYNC)
            self.wake.clear()


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
    log.info("Agent démarré (%s).", CFG.get("transport", "ssh"))
    Agent().run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
