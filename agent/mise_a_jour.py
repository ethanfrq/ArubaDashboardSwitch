#!/usr/bin/env python3
"""Mise à jour automatique de l'agent depuis GitHub.

Compare chaque fichier du dossier « agent » du dépôt avec celui du PC et télécharge ceux qui ont changé.
Lancé toutes les 5 minutes par la tâche planifiée « ArubaDashboardMiseAJour » (voir installer_service.py).

    python mise_a_jour.py              # vérifie et met à jour si besoin
    python mise_a_jour.py --verifier   # dit seulement si une mise à jour est disponible
    python mise_a_jour.py --installer  # met à jour puis installe ou réinstalle les deux tâches (administrateur)

Sécurité :
- seuls les fichiers présents dans le dossier « agent » du dépôt sont touchés : la configuration
  (agent_config.json), le mot de passe chiffré (agent_secret.bin) et les journaux ne le sont jamais ;
- chaque fichier téléchargé est vérifié par son empreinte Git avant d'être utilisé ;
- les scripts Python sont compilés avant remplacement, l'ancienne version est gardée dans « .sauvegarde » ;
- si le nouvel agent ne redémarre pas correctement, l'ancienne version est remise automatiquement
  et la version fautive n'est plus retentée tant que le dépôt ne change pas.
"""
import base64, hashlib, json, logging, os, py_compile, re, shutil, subprocess, sys, time
import urllib.error, urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / ".mise_a_jour"          # ETag, version refusée
STATUS = HERE / "mise_a_jour.json"     # dernier résultat, affiché dans le dashboard par l'agent
BACKUP = HERE / ".sauvegarde"
STAGING = HERE / ".telechargement"
HEARTBEAT = HERE / "agent_etat.json"   # écrit par l'agent après chaque envoi réussi
TASK = "ArubaDashboardAgent"
IS_WIN = os.name == "nt"
NO_WINDOW = 0x08000000 if IS_WIN else 0

# Jamais remplacés ni supprimés, même si un fichier du même nom apparaissait dans le dépôt.
LOCAL_ONLY = {"agent_config.json", "agent_secret.bin", "cable_cache.json", "agent_etat.json", "mise_a_jour.json"}

log = logging.getLogger("mise_a_jour")


def config():
    try:
        cfg = json.loads((HERE / "agent_config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cfg = {}
    return {"repo": cfg.get("update_repo", "ethanfrq/ArubaDashboardSwitch"),
            "branch": cfg.get("update_branch", "main"),
            "folder": cfg.get("update_folder", "agent"),
            "enabled": cfg.get("auto_update", True)}


def setup_logging():
    log.setLevel(logging.INFO)
    fh = RotatingFileHandler(HERE / "mise_a_jour.log", maxBytes=300_000, backupCount=1, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(fh)
    if sys.stdout:
        log.addHandler(logging.StreamHandler(sys.stdout))


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def report(ok, msg, commit=None):
    log.info(msg)
    save_json(STATUS, {"t": round(time.time()), "ok": ok, "msg": msg, "commit": commit})


def github(path, etag=None):
    """Appel à l'API GitHub. Renvoie (données, etag) ou (None, etag) si rien n'a changé (304, gratuit)."""
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "aruba-agent-mise-a-jour"}
    if etag:
        headers["If-None-Match"] = etag
    req = urllib.request.Request("https://api.github.com" + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read()), r.headers.get("ETag")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return None, etag
        raise


def git_blob_sha(data):
    """Empreinte d'un fichier telle que Git la calcule : permet de comparer sans rien télécharger."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def remote_files(cfg, state, force):
    """Fichiers du dossier sur GitHub : ({nom: empreinte}, commit). Si le dépôt n'a pas bougé depuis la dernière
    vérification (réponse 304, non décomptée par GitHub), on réutilise la liste gardée en mémoire."""
    cached = state.get("files")
    branch, ref = github(f"/repos/{cfg['repo']}/branches/{cfg['branch']}", None if force or not cached else state.get("etag"))
    if branch is None:
        return cached, state.get("commit")
    commit = branch["commit"]["sha"]
    listing, _ = github(f"/repos/{cfg['repo']}/contents/{cfg['folder']}?ref={commit}")
    files = {f["name"]: f["sha"] for f in listing
             if f["type"] == "file" and re.fullmatch(r"[\w.-]+", f["name"]) and not f["name"].startswith(".")
             and f["name"] not in LOCAL_ONLY}
    state.update(etag=ref, files=files, commit=commit)
    return files, commit


def changed_files(files):
    out = []
    for name, sha in files.items():
        local = HERE / name
        if not local.exists() or git_blob_sha(local.read_bytes()) != sha:
            out.append(name)
    return sorted(out)


def download(cfg, name, sha):
    blob, _ = github(f"/repos/{cfg['repo']}/git/blobs/{sha}")
    data = base64.b64decode(blob["content"])
    if git_blob_sha(data) != sha:
        raise ValueError(f"{name} : empreinte incorrecte, téléchargement refusé")
    return data


def agent_version(path):
    m = re.search(r'^AGENT_VERSION = "([^"]+)"', path.read_text(encoding="utf-8"), re.M)
    return m[1] if m else None


def sch(*args):
    return subprocess.run(["schtasks", *args], capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW)


def restart_agent():
    if not IS_WIN:
        log.info("Hors Windows : redémarre l'agent à la main pour utiliser la nouvelle version.")
        return False
    sch("/End", "/TN", TASK)
    time.sleep(3)
    return sch("/Run", "/TN", TASK).returncode == 0


def agent_healthy(version, since, wait=150):
    """Attend que le nouvel agent ait fait au moins un tour complet (même si internet ou le switch est coupé)."""
    end = time.time() + wait
    while time.time() < end:
        try:
            hb = json.loads(HEARTBEAT.read_text(encoding="utf-8"))
            if hb.get("version") == version and hb.get("t", 0) >= since:
                return True
        except (OSError, ValueError):
            pass
        time.sleep(5)
    return False


def apply(cfg, files, names, commit, state):
    STAGING.mkdir(exist_ok=True)
    staged = {}
    for name in names:
        data = download(cfg, name, files[name])
        (STAGING / name).write_bytes(data)
        staged[name] = STAGING / name
    for name, path in staged.items():
        if name.endswith(".py"):
            py_compile.compile(str(path), doraise=True)  # refuse une version qui ne se lance même pas

    BACKUP.mkdir(exist_ok=True)
    for name in names:
        if (HERE / name).exists():
            shutil.copy2(HERE / name, BACKUP / name)
    for name, path in staged.items():
        os.replace(path, HERE / name)
    shutil.rmtree(STAGING, ignore_errors=True)
    log.info("Fichiers mis à jour : %s", ", ".join(names))

    if "requirements.txt" in names:
        r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(HERE / "requirements.txt")],
                           capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW)
        log.info("Dépendances : %s", "à jour" if r.returncode == 0 else (r.stdout + r.stderr).strip()[-300:])

    if "installer_service.py" in names and IS_WIN:  # tâches planifiées éventuellement modifiées
        subprocess.run([sys.executable, str(HERE / "installer_service.py"), "taches"],
                       capture_output=True, creationflags=NO_WINDOW)
    if not {"agent.py", "requirements.txt"} & set(names):  # l'agent en cours n'est pas concerné
        return report(True, f"Mise à jour appliquée ({', '.join(names)}).", commit)
    version = agent_version(HERE / "agent.py")
    since = time.time()
    if not restart_agent():
        return report(True, f"Fichiers mis à jour ({', '.join(names)}), agent à redémarrer.", commit)
    if agent_healthy(version, since):
        return report(True, f"Agent {version} installé et opérationnel.", commit)

    # Le nouvel agent ne fonctionne pas : retour à la version précédente.
    for name in names:
        if (BACKUP / name).exists():
            shutil.copy2(BACKUP / name, HERE / name)
    restart_agent()
    state["refused"] = {n: files[n] for n in names}  # ces versions de fichiers ne seront plus retentées
    report(False, f"La version {version} ne démarre pas correctement : version précédente remise en place. "
                  f"Elle sera retentée à la prochaine modification du dépôt.", commit)


def run(check_only=False, force=False):
    cfg = config()
    if not cfg["enabled"] and not force:
        return report(True, "Mise à jour automatique désactivée (auto_update: false).")
    state = load_state()
    try:
        files, commit = remote_files(cfg, state, force)
        names = changed_files(files)  # toujours comparé : un fichier abîmé sur le PC est réparé
        if not names:
            report(True, "À jour.", commit)
        elif not force and all(state.get("refused", {}).get(n) == files[n] for n in names):
            report(False, "La version en ligne a déjà échoué ici : en attente d'une correction sur GitHub.", commit)
        elif check_only:
            report(True, f"Mise à jour disponible : {', '.join(names)}.", commit)
        else:
            apply(cfg, files, names, commit, state)
    except Exception as e:  # noqa: BLE001
        state.pop("etag", None)  # nouvel essai complet la prochaine fois
        report(False, f"Vérification impossible : {e}")
    finally:
        save_json(STATE, state)


def single_instance():
    """Une seule mise à jour à la fois."""
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 48724))
    except OSError:
        raise SystemExit(0)
    return s


if __name__ == "__main__":
    setup_logging()
    lock = single_instance()  # noqa: F841
    args = set(sys.argv[1:])
    if "--installer" in args:
        run(force=True)
        subprocess.run([sys.executable, str(HERE / "installer_service.py"), "install"])
    else:
        run(check_only="--verifier" in args, force="--forcer" in args)
