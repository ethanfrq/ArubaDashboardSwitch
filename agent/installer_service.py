"""Installe l'agent comme service Windows (tâches planifiées SYSTEM) :
- ArubaDashboardAgent : l'agent, au démarrage du PC, relancé en cas d'erreur ;
- ArubaDashboardMiseAJour : mise à jour automatique (versions publiées sur GitHub), au démarrage puis toutes les 5 minutes.
Les noms des tâches restent ceux des premières versions : les PC déjà installés gardent les mêmes.

    python installer_service.py install | uninstall | status | restart | taches
"""
import subprocess, sys, tempfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
TASK = "ArubaDashboardAgent"
UPDATE_TASK = "ArubaDashboardMiseAJour"

HEAD = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>{desc}</Description></RegistrationInfo>
  <Triggers>{triggers}</Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>{limit}</ExecutionTimeLimit>
    {restart}
  </Settings>
  <Actions Context="Author"><Exec><Command>{cmd}</Command><Arguments>"{script}"</Arguments><WorkingDirectory>{wd}</WorkingDirectory></Exec></Actions>
</Task>
"""

AGENT = dict(desc="Agent My Aruba Manager (envoie l'etat du switch au dashboard)",
             triggers="<BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>",
             limit="PT0S", restart="<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
             script="agent.py")
UPDATE = dict(desc="Mise a jour automatique de l'agent My Aruba Manager (versions publiees sur GitHub)",
              triggers="<BootTrigger><Enabled>true</Enabled><Delay>PT2M</Delay></BootTrigger>"
                       "<TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>"
                       "<StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>",
              limit="PT15M", restart="", script="mise_a_jour.py")


def sch(*args, check=True):
    r = subprocess.run(["schtasks", *args], capture_output=True, text=True, errors="replace")
    print((r.stdout + r.stderr).strip())
    if check and r.returncode:
        sys.exit(r.returncode)
    return r


def create(name, spec):
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")  # sans fenêtre
    xml = HEAD.format(desc=escape(spec["desc"]), triggers=spec["triggers"], limit=spec["limit"], restart=spec["restart"],
                      cmd=escape(str(pyw if pyw.exists() else exe)), script=escape(str(HERE / spec["script"])),
                      wd=escape(str(HERE)))
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False, encoding="utf-16") as f:
        f.write(xml)
    sch("/Create", "/TN", name, "/XML", f.name, "/F")


def tasks():
    """(Re)crée les deux tâches sans arrêter l'agent en cours (utilisé par la mise à jour automatique)."""
    create(TASK, AGENT)
    create(UPDATE_TASK, UPDATE)


def install():
    if not (HERE / "agent_secret.bin").exists():
        sys.exit("Enregistre d'abord le mot de passe du switch : python agent.py --set-password")
    sch("/End", "/TN", TASK, check=False)
    tasks()
    sch("/Run", "/TN", TASK)
    print("\nService installé et démarré. Journal : " + str(HERE / "agent.log"))
    print("Mise à jour automatique (versions publiées sur GitHub) : toutes les 5 minutes. Journal : " + str(HERE / "mise_a_jour.log"))


def uninstall():
    sch("/End", "/TN", TASK, check=False)
    sch("/Delete", "/TN", TASK, "/F", check=False)
    sch("/Delete", "/TN", UPDATE_TASK, "/F", check=False)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if action == "install":
        install()
    elif action == "uninstall":
        uninstall()
    elif action == "taches":
        tasks()
    elif action == "restart":
        sch("/End", "/TN", TASK, check=False)
        sch("/Run", "/TN", TASK)
    else:
        sch("/Query", "/TN", TASK, "/V", "/FO", "LIST", check=False)
        sch("/Query", "/TN", UPDATE_TASK, "/FO", "LIST", check=False)
