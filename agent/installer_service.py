"""Installe l'agent comme service Windows (tâche planifiée SYSTEM, au démarrage, relancée en cas d'erreur).

    python installer_service.py install | uninstall | status | restart
"""
import subprocess, sys, tempfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
TASK = "ArubaDashboardAgent"

XML = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Agent du dashboard switch Aruba (envoie l'etat du switch au dashboard Vercel)</Description></RegistrationInfo>
  <Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>{cmd}</Command><Arguments>"{script}"</Arguments><WorkingDirectory>{wd}</WorkingDirectory></Exec></Actions>
</Task>
"""


def sch(*args, check=True):
    r = subprocess.run(["schtasks", *args], capture_output=True, text=True, errors="replace")
    print((r.stdout + r.stderr).strip())
    if check and r.returncode:
        sys.exit(r.returncode)
    return r


def install():
    if not (HERE / "agent_secret.bin").exists():
        sys.exit("Enregistre d'abord le mot de passe du switch : python agent.py --set-password")
    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    xml = XML.format(cmd=escape(str(pyw if pyw.exists() else exe)), script=escape(str(HERE / "agent.py")),
                     wd=escape(str(HERE)))
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False, encoding="utf-16") as f:
        f.write(xml)
    sch("/End", "/TN", TASK, check=False)
    sch("/Create", "/TN", TASK, "/XML", f.name, "/F")
    sch("/Run", "/TN", TASK)
    print("\nService installé et démarré. Journal : " + str(HERE / "agent.log"))


def uninstall():
    sch("/End", "/TN", TASK, check=False)
    sch("/Delete", "/TN", TASK, "/F")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if action == "install":
        install()
    elif action == "uninstall":
        uninstall()
    elif action == "restart":
        sch("/End", "/TN", TASK, check=False)
        sch("/Run", "/TN", TASK)
    else:
        sch("/Query", "/TN", TASK, "/V", "/FO", "LIST", check=False)
