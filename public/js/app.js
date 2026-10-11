// My Aruba Manager : application du dashboard (chargée par index.html avant les extensions de public/js).
const APP_VERSION = '1.9.2';
const AGENT_LATEST = '1.4.0'; // dernière version de l'agent publiée avec ce dashboard
// x.y.z en nombre comparable ; parties en trop ou non numériques ignorées (« 1.2.0.1 », version reçue mal formée)
const verNum = (v) => { const p = String(v).split('.'); return [0, 1, 2].reduce((a, i) => a * 1000 + (parseInt(p[i], 10) || 0), 0); };
// Agent installé plus ancien que AGENT_LATEST. Avant 1.3.0, l'agent envoyait un numéro de protocole (« 2 ») ou rien.
const agentSemver = (v) => /^\d+\.\d+/.test(String(v));
const agentOlder = () => !agentSemver(S?.agent?.version) || verNum(S.agent.version) < verNum(AGENT_LATEST);
// Agent d'avant 1.3.0 : sans relevé intégré ni mise à jour automatique, il faut le mettre à jour une fois à la main.
const agentPre13 = () => Boolean(S) && !S.diag?.h && (!agentSemver(S.agent?.version) || verNum(S.agent.version) < verNum('1.3.0'));
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const arr = (x) => (Array.isArray(x) ? x : []);

function fmtBps(v) {
  if (v == null) return '-';
  const u = ['b/s', 'kb/s', 'Mb/s', 'Gb/s']; let i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${(i && v < 100 ? nf : nf0).format(v)} ${u[i]}`;
}
function fmtBytes(v) {
  if (v == null) return '-';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${(i && v < 100 ? nf : nf0).format(v)} ${u[i]}`;
}
const durShort = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))}min` : `${Math.round(s / 3600)}h`);
const fmtDur = (s) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${nf.format(s / 3600)} h`);
const ago = (s) => `il y a ${fmtDur(Math.max(0, s))}`;
const portNum = (p) => Number(String(p).split('/').pop());
const IDLE_AFTER = 120;

let S = null, LOG = [], ALERTS = [], NOW = 0, selected = null, filter = 'all', timer = null, lastTouch = 0;
let LV = '', AV = ''; // versions du journal et des alertes déjà reçues : le serveur ne les renvoie que si elles changent
let SETUP = null; // avant connexion : { ok, db, missing, fresh } (installation à terminer, première connexion)
let EPOCH = 0; // augmente à chaque retour à l'écran de connexion : une lecture de l'état partie avant est ignorée

// ================================================================ extensions (public/js/*.js)
// Chaque fonction d'administration vit dans son propre fichier et s'accroche ici :
//   HOOK.render.push(fn)      après chaque affichage complet
//   HOOK.faceplate.push(fn)   après chaque affichage de la façade (ex. surligner une sélection)
//   HOOK.panel.push(fn)       fn(port) -> HTML d'une section ajoutée au volet d'un port
//   HOOK.portName.push(fn)    fn(port, {name, sub, macs, lldp}) -> {name?, sub?} pour renommer l'appareil d'un port
//   HOOK.poll.push(fn)        après chaque lecture de l'état (X contient les données des extensions)
//   HOOK.role.push(fn)        quand on passe en lecture seule ou en vue admin
//   HOOK.login.push(fn)       avant connexion : fn(setup), état de l'installation renvoyé par /api/state (onboarding.js)
//   addTool({ id, label, icon, title, open })   bouton dans la carte Administration
//   ADMIN.xxx                 fonctions partagées entre extensions (ADMIN.wake, ADMIN.profiles…)
// HTML brut (jamais de donnée du switch ou de l'utilisateur sans esc()) : le HTML renvoyé par HOOK.panel, icon d'addTool,
// actions de toast(). La page interdit tout script dans le HTML (CSP) : écouteurs addEventListener ou data-* seulement.
const HOOK = { render: [], faceplate: [], panel: [], portName: [], poll: [], role: [], login: [] };
const TOOLS = [], X = {}, XV = {}, ADMIN = {};
function hook(name, ...args) {
  const out = [];
  for (const f of HOOK[name]) { try { out.push(f(...args)); } catch (e) { console.error(`extension (${name})`, e); } }
  return out;
}
function addTool(t) { TOOLS.push(t); renderTools(); }
// Outils permis au technicien : ceux qui agissent sur les ports d'accès ou les consultent.
const TECH_TOOLS = new Set(['diagnose', 'wol', 'devices', 'devices-export', 'bulk']);
const toolAllowed = (t) => canAdmin() || (canOperate() && TECH_TOOLS.has(t.id));
function renderTools() {
  const box = $('#adminTools'); if (!box) return;
  const list = TOOLS.filter(toolAllowed);
  $('#sec-admin').hidden = !list.length;
  setHTML(box, list.map((t) => `<button class="btn" type="button" data-tool="${esc(t.id)}" title="${esc(t.title || '')}">${t.icon ? `<span class="ic" aria-hidden="true">${t.icon}</span>` : ''}${esc(t.label)}${t.badge ? `<span class="badge amber">${esc(t.badge)}</span>` : ''}</button>`).join(''));
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]'); if (!b) return;
  const t = TOOLS.find((x) => x.id === b.dataset.tool);
  if (t && toolAllowed(t)) { try { t.open(); } catch (err) { console.error(err); toast('Erreur', { type: 'error', sub: err.message }); } }
});
// Capacités de l'agent (ex. 'wol', 'ping') : certaines actions demandent une version récente.
const agentHas = (cap) => (S?.agent?.caps || []).includes(cap);
const OUT = {}, OUTV = {}, SEEN = {};

const quietFor = (p) => (p.up && p.rx_quiet_since ? Math.max(0, (S.updated || NOW) - p.rx_quiet_since) : 0);
const pState = (p) => (!p.enabled ? 'off' : !p.up ? 'down' : quietFor(p) >= IDLE_AFTER ? 'idle' : 'up');
const pLabel = { up: 'Actif', idle: 'Sans trafic', down: 'Libre', off: 'Désactivé' };
const isSlow = (p) => p.up && p.type === '1GbT' && Number(p.speed) > 0 && Number(p.speed) < 1000;
const loadPct = (bps, p) => (p.up && Number(p.speed) > 0 && bps != null ? (bps / (Number(p.speed) * 1e6)) * 100 : null);
const fmtPct = (x) => (x == null ? '-' : x < 0.1 ? '< 0,1 %' : `${nf.format(x)} %`);
const speedTag = (s) => (s >= 1000 ? `${s / 1000}G` : `${s}M`);
const isUplink = (p) => p.uplink ?? (S.lldp || []).some((l) => l.port === p.port && l.name && /\d{4}|aruba|switch/i.test(l.name));
const pendingFor = (port) => LOG.some((c) => ['pending', 'running', 'confirm'].includes(c.status) && (c.ports || []).includes(port));
// État affiché d'un port : un port sans lien n'est « libre » que si un test de câble récent le confirme.
function stInfo(p) {
  const st = pState(p);
  if (st !== 'down' || p.type !== '1GbT') return { cls: st, label: pLabel[st] };
  const cab = cableOf(p.port);
  if (!cab) return { cls: 'unk', label: 'À vérifier' };
  if (cab.kind === 'empty') return { cls: 'down', label: 'Libre' };
  if (cab.kind === 'fault') return { cls: 'fault', label: 'Câble en défaut' };
  return { cls: 'cable', label: 'Câble sans lien' };
}

// ================================================================ notifications & chargement
const TOASTS = {};
const TOAST_IC = { success: 'check_circle', error: 'error', warn: 'warning', info: 'info' };
function toast(msg, { type = 'info', sub = '', id = null, timeout = 4500, actions = '', spinner = false } = {}) {
  id = id || 'tt' + Math.random().toString(36).slice(2);
  let el = TOASTS[id];
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    $('#toasts').appendChild(el); TOASTS[id] = el;
    el.addEventListener('click', (e) => { if (e.target.closest('.x')) dropToast(id); });
  }
  clearTimeout(el._t);
  el.className = `toast ${type}`;
  const ic = spinner ? '<span class="spinner"></span>' : icon(TOAST_IC[type] || 'info');
  el.innerHTML = `<span class="ic">${ic}</span><div><div>${esc(msg)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${actions ? `<div class="acts">${actions}</div>` : ''}</div><button class="x" aria-label="Fermer">${icon('close', { size: 16 })}</button>`;
  if (timeout) el._t = setTimeout(() => dropToast(id), timeout);
  return id;
}
function dropToast(id) { const el = TOASTS[id]; if (el) { el.remove(); delete TOASTS[id]; } }

// Bouton désactivé pendant l'action : le navigateur lui retire le focus. Il le retrouve ensuite s'il est encore
// affiché et que l'action n'a pas placé le focus ailleurs (navigation au clavier, lecteurs d'écran).
async function busy(btn, fn) {
  const had = Boolean(btn) && document.activeElement === btn;
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }
  try { return await fn(); } finally {
    if (btn) {
      btn.classList.remove('loading'); btn.disabled = btn.dataset.lock === '1';
      const lost = !document.activeElement || document.activeElement === document.body;
      if (had && lost && !btn.disabled && btn.isConnected && btn.getClientRects().length) btn.focus();
    }
  }
}

// ================================================================ thème clair / sombre
const darkNow = () => document.documentElement.dataset.theme === 'dark'
  || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
function labelTheme() {
  const b = $('#themeBtn'), next = darkNow() ? 'clair' : 'sombre';
  b.title = `Passer en mode ${next}`; b.setAttribute('aria-label', `Passer en mode ${next}`);
}
$('#themeBtn').addEventListener('click', () => {
  const t = darkNow() ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (e) {}
  labelTheme();
  if (S) renderChart();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', labelTheme);
labelTheme();

// ================================================================ API
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('401'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data.error || `Erreur ${r.status}`); err.status = r.status; err.data = data; throw err; }
  return data;
}
// Rôle du compte (donné par le serveur) et vue monitoring choisie par l'utilisateur.
//   admin  : tout ; tech (technicien) : actions sur les ports d'accès ; viewer : lecture seule.
// canAdmin() : gestion complète (réglages, comptes, console, VLAN…) ; canOperate() : agir sur les ports.
let ROLE = 'admin', MONITOR = false, ME = null;
try { MONITOR = localStorage.getItem('aruba-view') === 'monitor'; } catch {}
const canAdmin = () => ROLE === 'admin' && !MONITOR;
const canOperate = () => (ROLE === 'admin' || ROLE === 'tech') && !MONITOR;
const ROLE_FR = { admin: 'Administrateur', tech: 'Technicien', viewer: 'Lecture seule' };
function applyRole() {
  const ro = !canOperate();
  document.body.classList.toggle('readonly', ro);
  document.body.classList.toggle('notadmin', !canAdmin());
  document.body.classList.toggle('viewer', ROLE === 'viewer');
  $('#rolePill').hidden = !(ro || ROLE === 'tech');
  $('#rolePill').textContent = ROLE === 'viewer' ? 'Lecture seule' : MONITOR ? 'Vue monitoring' : 'Technicien';
  $('#rolePill').title = ROLE === 'viewer' ? 'Compte lecture seule : aucune commande possible.' : MONITOR ? 'Les commandes sont masquées. Repasse en vue normale pour agir sur le switch.' : 'Technicien : actions sur les ports d’accès. Réglages, comptes et console sont réservés aux administrateurs.';
  $('#viewBtn').hidden = ROLE === 'viewer';
  $('#viewBtn').setAttribute('aria-pressed', String(MONITOR));
  $('#viewBtn').title = MONITOR ? 'Repasser en vue normale (réafficher les commandes)' : 'Vue monitoring : masquer toutes les commandes';
  $('#viewBtn').setAttribute('aria-label', $('#viewBtn').title);
  $('#fpNote').textContent = ro ? 'Clique sur un port pour voir son détail' : 'Clique sur un port pour le gérer · reclique pour le désélectionner';
  if (ro) document.querySelectorAll('dialog[open]:not(.keep)').forEach((d) => d.close());
  hook('role', ro); renderTools();
  if (S) renderPanel(true);
}
$('#viewBtn').addEventListener('click', async () => {
  if (!MONITOR && window.NAV && !(await NAV.leave('dashboard'))) return; // vue monitoring : Réglages se ferme
  MONITOR = !MONITOR;
  try { localStorage.setItem('aruba-view', MONITOR ? 'monitor' : 'admin'); } catch {}
  applyRole();
});
function showLogin() { EPOCH++; keepSettings(); forgetTyped(); LV = AV = ''; SAVED = null; for (const k of Object.keys(XV)) delete XV[k]; $('#foot').hidden = true; $('#app').hidden = true; $('#portPanel').hidden = true; $('#login').hidden = false; clearTimeout(timer); }
function showApp() { $('#login').hidden = true; $('#app').hidden = false; $('#foot').hidden = false; }
$('#appVersion').textContent = `v${APP_VERSION}`;

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  busy($('#loginBtn'), async () => {
    const needCode = !$('#codeField').hidden;
    try {
      const d = await api('/api/login', { login: $('#loginId').value, password: $('#pw').value, ...(needCode ? { code: $('#code').value } : {}) });
      if (d.totp) { $('#codeField').hidden = false; $('#code').value = ''; $('#code').focus(); return; } // mot de passe juste : code demandé
      $('#pw').value = $('#code').value = ''; $('#codeField').hidden = true;
      try { localStorage.setItem('lastLogin', $('#loginId').value.trim()); } catch {}
      const who = $('#loginId').value;
      showApp(); loadSettings().then(() => restoreSettings(who)); poll(); toast('Connecté', { type: 'success', timeout: 2000 });
      if (d.recoveryUsed) toast('Code de secours utilisé', { type: 'warn', sub: 'Il ne servira plus. Crée de nouveaux codes de secours dans Mon profil.', timeout: 12000 });
    }
    catch (err) {
      $('#loginErr').textContent = err.message;
      if (err.data?.totp) { $('#codeField').hidden = false; $('#code').select(); } else $('#pw').select();
      $('#loginErr').focus();
    }
  });
});
$('#logout').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (window.NAV && !(await NAV.leave('dashboard'))) return; // réglages non enregistrés : confirmation
  if (settingsDirty()) fillSettings(true); // changements abandonnés : rien à garder pour la reconnexion
  busy(b, async () => { await api('/api/logout', {}).catch(() => {}); showLogin(); });
});

async function poll() {
  clearTimeout(timer);
  const epoch = EPOCH;
  try {
    const touch = Date.now() - lastTouch > 50000;
    const xv = Object.entries(XV).map(([k, v]) => `${k}:${v}`).join(',');
    const d = await api(`/api/state?lv=${LV}&av=${AV}${xv ? `&xv=${encodeURIComponent(xv)}` : ''}${touch ? '&touch=1' : ''}`);
    if (epoch !== EPOCH) return; // déconnecté pendant la lecture : ne pas rouvrir l'application
    if (d.auth === false) { SETUP = d.setup || null; showLogin(); hook('login', SETUP); ($('#loginId').value ? $('#pw') : $('#loginId')).focus(); return; }
    if (touch) lastTouch = Date.now();
    ME = d.me || ME;
    if ((d.role || 'admin') !== ROLE || !document.body.dataset.role) { ROLE = d.role || 'admin'; document.body.dataset.role = ROLE; applyRole(); }
    if ($('#app').hidden) { showApp(); loadSettings(); }
    S = d.state; NOW = d.now;
    if (d.alerts) { ALERTS = arr(d.alerts); AV = d.av; }
    if (d.log) { trackCommands(arr(d.log)); LV = d.lv; }
    for (const [k, v] of Object.entries(d.x || {})) { X[k] = v.data; XV[k] = v.v; }
    render();
    hook('poll', d);
    runVerify(); maybeDiag(); maybeCableCheck();
  } catch (e) { if (e.message === '401') return; }
  if (epoch !== EPOCH) return;
  const busyNow = LOG.some((c) => ['pending', 'running', 'confirm'].includes(c.status));
  timer = setTimeout(poll, document.hidden ? 30000 : busyNow ? 1500 : nextRead());
}
// Relit l'état juste après le prochain envoi attendu de l'agent : aussi frais qu'en relisant toutes les 5 s,
// avec deux à trois fois moins de lectures (offres gratuites).
function nextRead() {
  const every = S?.agent?.sync || (ROLE === 'viewer' ? 30 : 10);
  let wait = S?.received ? S.received + every + 1.5 - NOW : every;
  if (wait < 1.5) wait = Math.min(every, 10); // agent en retard : on patiente un peu avant de relire
  return Math.min(wait, every + 2) * 1000;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) { lastTouch = 0; poll(); } });

// Suivi des commandes : notifications à chaque changement d'état.
function trackCommands(log) {
  for (const c of log) {
    const prev = SEEN[c.id];
    if (prev && prev !== c.status) onStatus(c);
    SEEN[c.id] = c.status;
  }
  LOG = log;
  const need = LOG.filter((c) => ['done', 'error', 'confirm'].includes(c.status) && OUTV[c.id] !== (c.v || c.status)).map((c) => c.id);
  if (need.length) fetchOutputs(need);
}
async function fetchOutputs(ids) {
  try {
    const outs = await api('/api/output?ids=' + ids.join(','));
    for (const id of ids) { OUT[id] = outs[id] || ''; const c = LOG.find((x) => x.id === id); OUTV[id] = c && (c.v || c.status); }
    renderTerm(); if (S) render();
  } catch {}
}
const ADDED_LINE = /^(copy running-config checkpoint \S+|checkpoint auto \d+)$/;
function cmdName(c) { return c.label || c.cmd.split('\n').map((l) => l.trim()).find((l) => l && !ADDED_LINE.test(l)) || c.cmd.split('\n')[0]; }
function onStatus(c) {
  if (isAuto(c)) return;
  if (c.status === 'done' && CONFIG_RE.test(c.cmd)) setTimeout(() => maybeDiag(true), 1500); // rafraîchit « config sauvegardée ? »
  const name = cmdName(c);
  if (c.status === 'running') toast(name, { id: c.id, sub: 'Exécution sur le switch…', spinner: true, timeout: 0 });
  if (c.status === 'confirm') toast('Le switch demande une confirmation', { id: c.id, type: 'warn', sub: c.question || name, timeout: 0,
    actions: `<button class="btn small primary" data-answer="y" data-answer-id="${esc(c.id)}">Oui</button><button class="btn small" data-answer="n" data-answer-id="${esc(c.id)}">Non</button>` });
  if (c.status === 'done') {
    const exp = expectations(c.cmd);
    if (exp.length) { VERIFY[c.id] = { name, exp, since: c.finished || NOW }; toast(name, { id: c.id, type: 'success', sub: 'Appliqué. Vérification sur le switch…', spinner: true, timeout: 0 }); }
    else toast(name, { id: c.id, type: 'success', sub: /^(show|diag|diagnostics)/.test(c.cmd) ? 'Terminé.' : 'Appliqué sur le switch.' });
  }
  if (c.status === 'error') {
    toast(name, { id: c.id, type: 'error', sub: 'Le switch a renvoyé une erreur. Détail dans la console.', timeout: 9000 });
    setTimeout(() => {
      // erreur seulement sur les lignes ajoutées par le dashboard (point de restauration, annulation automatique) :
      // le changement lui-même est appliqué
      const bad = Object.entries(sections(OUT[c.id])).filter(([, ls]) => ls.some((x) => /^\s*(%\s|Invalid|Error|ERROR)/.test(x)));
      if (bad.length && bad.every(([h]) => ADDED_LINE.test(h))) {
        if (TOASTS[c.id]) toast(name, { id: c.id, type: 'warn', sub: 'Appliqué, mais le switch a refusé le point de restauration ou l’annulation automatique.', timeout: 9000 });
        const exp = expectations(c.cmd); // le changement lui-même est quand même vérifié sur le switch
        if (exp.length) VERIFY[c.id] = { name, exp, since: c.finished || NOW };
        return;
      }
      const l = (OUT[c.id] || '').split('\n').find((x) => /^\s*%|Invalid|Error/i.test(x)); if (l && TOASTS[c.id]) toast(name, { id: c.id, type: 'error', sub: l.trim(), timeout: 9000 });
    }, 1200);
  }
}

// ================================================================ vérification après modification
// Après chaque changement, on contrôle dans l'état suivant du switch qu'il a bien été pris en compte.
const VERIFY = {};
const expandPorts = (list) => String(list).split(',').flatMap((part) => {
  const m = part.trim().match(/^1\/1\/(\d+)(?:-(?:1\/1\/)?(\d+))?$/); if (!m) return [];
  return Array.from({ length: Math.max(0, Number(m[2] || m[1]) - Number(m[1]) + 1) }, (_, i) => `1/1/${Number(m[1]) + i}`);
});
function expectations(cmd) {
  const exp = new Map(); let ports = null, vlan = null; // contexte : interface(s) ou VLAN en cours de configuration
  for (const raw of String(cmd).split('\n')) {
    const l = raw.trim(); let m;
    if ((m = l.match(/^interface\s+(1\/1\/[\d\/,-]+)$/i))) { ports = expandPorts(m[1]); vlan = null; continue; }
    if (/^(exit|end|configure(\s+terminal)?)$/i.test(l)) { ports = vlan = null; continue; }
    if (/^(write\s+memory|copy\s+running-config\s+startup-config)$/i.test(l)) { exp.set('saved|', true); continue; }
    if (!ports && (m = l.match(/^vlan\s+(\d+)$/i))) { vlan = m[1]; exp.set(`vex|${vlan}`, true); continue; }
    if (!ports && (m = l.match(/^no\s+vlan\s+(\d+)$/i))) { exp.delete(`vname|${m[1]}`); exp.set(`vex|${m[1]}`, false); continue; }
    if (vlan && (m = l.match(/^name\s+(.+)$/i))) { exp.set(`vname|${vlan}`, m[1].trim()); continue; }
    for (const p of ports || []) {
      if (/^shutdown$/i.test(l)) exp.set(`en|${p}`, false);
      else if (/^no\s+shutdown$/i.test(l)) exp.set(`en|${p}`, true);
      else if ((m = l.match(/^description\s+(.+)$/i))) exp.set(`desc|${p}`, m[1].trim());
      else if (/^no\s+description$/i.test(l)) exp.set(`desc|${p}`, '');
      else if ((m = l.match(/^vlan\s+access\s+(\d+)$/i))) exp.set(`vlan|${p}`, m[1]);
    }
  }
  return [...exp];
}
function expectOk([key, val], since) {
  const [k, id] = key.split('|');
  const p = (S.ports || []).find((x) => x.port === id), v = (S.vlans || []).find((x) => String(x.id) === id);
  const same = (got, want) => got === want || (want.length > 12 && got.length >= 8 && want.startsWith(got)); // texte parfois tronqué par le switch
  if (k === 'en') return p?.enabled === val;
  if (k === 'vlan') return p?.vlan === val;
  if (k === 'desc') return Boolean(p) && same(p.desc || '', val);
  if (k === 'vex') return Boolean(v) === val;
  if (k === 'vname') return Boolean(v) && same(v.name || '', val);
  if (k === 'saved') return DIAG?.t > since && DIAG.saved === true;
  return true;
}
function expectText([key, val]) {
  const [k, id] = key.split('|'), n = id.startsWith('1/1/') ? portNum(id) : id;
  return { en: `port ${n} ${val ? 'activé' : 'désactivé'}`, vlan: `port ${n} sur le VLAN ${val}`, desc: `description du port ${n}`,
    vex: `VLAN ${n} ${val ? 'présent' : 'supprimé'}`, vname: `VLAN ${n} nommé ${val}`, saved: 'configuration sauvegardée' }[k];
}
const listText = (exps) => (exps.length > 3 ? `${exps.slice(0, 3).map(expectText).join(', ')} et ${exps.length - 3} autre(s)` : exps.map(expectText).join(', '));
function runVerify() {
  if (!S) return;
  for (const [id, v] of Object.entries(VERIFY)) {
    const bad = (S.received || 0) > v.since ? v.exp.filter((e) => !expectOk(e, v.since)) : null;
    if (bad && !bad.length) { toast(v.name, { id, type: 'success', sub: `Vérifié sur le switch : ${listText(v.exp)}.`, timeout: 6000 }); delete VERIFY[id]; continue; }
    const age = NOW - v.since, waitDiag = v.exp.some(([k]) => k === 'saved|');
    if (bad && age > (waitDiag ? 90 : 60) && S.received - v.since > 15) {
      toast(v.name, { id, type: 'warn', sub: `Pas visible sur le switch : ${listText(bad)}. Vérifie dans la console ou relance la commande.`, timeout: 15000 });
      delete VERIFY[id];
    } else if (age > 300) {
      toast(v.name, { id, type: 'warn', sub: 'Impossible de vérifier le résultat : l’agent n’envoie plus l’état du switch.', timeout: 10000 });
      delete VERIFY[id];
    }
  }
}

// ================================================================ menus déroulants personnalisés
// Remplace l'affichage des <select> natifs (impossibles à styler) tout en les gardant pour la valeur et les événements.
const DD_CHEV = icon('expand_more', { cls: 'chev' });
const DD_CHECK = icon('check', { cls: 'ck' });
let ddOpen = null, ddSeq = 0, ddType = '', ddTypeT = 0;
function ddSync(wrap) {
  const sel = wrap.querySelector('select'), o = sel.selectedOptions[0];
  wrap.querySelector('.dd-label').textContent = o ? o.textContent : '-';
}
function ddSyncAll() { document.querySelectorAll('.dd').forEach(ddSync); }
function enhanceSelects(root = document) {
  root.querySelectorAll('select:not([data-dd])').forEach((sel) => {
    sel.dataset.dd = '1';
    const wrap = document.createElement('span');
    wrap.className = 'dd' + (sel.classList.contains('compact') ? ' compact' : '');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'dd-btn'; btn.id = `dd-${++ddSeq}`;
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const lbl = sel.id && document.querySelector(`label[for="${sel.id}"]`);
    if (lbl) lbl.htmlFor = btn.id;
    btn.setAttribute('aria-label', sel.getAttribute('aria-label') || lbl?.textContent || 'Choisir');
    btn.innerHTML = `<span class="dd-label"></span>${DD_CHEV}`;
    wrap.appendChild(btn);
    ddSync(wrap);
    sel.addEventListener('change', () => ddSync(wrap));
    new MutationObserver(() => ddSync(wrap)).observe(sel, { childList: true, subtree: true, attributes: true });
    btn.addEventListener('click', () => (ddOpen === wrap ? ddClose() : ddOpenMenu(wrap)));
    btn.addEventListener('keydown', (e) => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); ddOpenMenu(wrap); } });
  });
}
function ddActive(menu, i) {
  const opts = [...menu.children];
  i = Math.max(0, Math.min(opts.length - 1, i));
  opts.forEach((o, k) => o.classList.toggle('active', k === i));
  menu.dataset.active = i;
  menu.setAttribute('aria-activedescendant', opts[i]?.id || '');
  const o = opts[i];
  if (o) { if (o.offsetTop < menu.scrollTop) menu.scrollTop = o.offsetTop - 4; else if (o.offsetTop + o.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = o.offsetTop + o.offsetHeight - menu.clientHeight + 4; }
}
function ddOpenMenu(wrap) {
  ddClose();
  const sel = wrap.querySelector('select'), btn = wrap.querySelector('.dd-btn');
  const menu = document.createElement('div');
  menu.className = 'dd-menu'; menu.setAttribute('role', 'listbox'); menu.tabIndex = -1;
  [...sel.options].forEach((o, i) => {
    const d = document.createElement('div');
    d.className = 'dd-opt'; d.id = `${btn.id}-o${i}`; d.dataset.i = i;
    d.setAttribute('role', 'option'); d.setAttribute('aria-selected', String(o.selected));
    d.innerHTML = `${DD_CHECK}<span></span>`; d.lastChild.textContent = o.textContent;
    menu.appendChild(d);
  });
  wrap.appendChild(menu);
  wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); ddOpen = wrap;
  ddPlace(wrap);
  menu.addEventListener('click', (e) => { const o = e.target.closest('.dd-opt'); if (o) ddPick(wrap, Number(o.dataset.i)); });
  menu.addEventListener('mousemove', (e) => { const o = e.target.closest('.dd-opt'); if (o && Number(menu.dataset.active) !== Number(o.dataset.i)) ddActive(menu, Number(o.dataset.i)); });
  menu.addEventListener('keydown', (e) => {
    const n = menu.children.length, a = Number(menu.dataset.active) || 0;
    if (e.key === 'ArrowDown') { e.preventDefault(); ddActive(menu, a + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ddActive(menu, a - 1); }
    else if (e.key === 'Home' || e.key === 'PageUp') { e.preventDefault(); ddActive(menu, 0); }
    else if (e.key === 'End' || e.key === 'PageDown') { e.preventDefault(); ddActive(menu, n - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ddPick(wrap, a); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ddClose(); btn.focus(); }
    else if (e.key === 'Tab') ddClose();
    else if (e.key.length === 1) { // saisie au clavier : va à l'option qui commence par les lettres tapées
      clearTimeout(ddTypeT); ddType += e.key.toLowerCase(); ddTypeT = setTimeout(() => (ddType = ''), 700);
      const k = [...menu.children].findIndex((o) => o.textContent.trim().toLowerCase().startsWith(ddType));
      if (k >= 0) ddActive(menu, k);
    }
  });
  ddActive(menu, Math.max(0, sel.selectedIndex));
  menu.focus({ preventScroll: true });
}
// Position « fixed » : le menu n'est pas coupé par une fenêtre ou un panneau qui défile, et suit le bouton.
function ddPlace(wrap) {
  const btn = wrap.querySelector('.dd-btn'), menu = wrap.querySelector('.dd-menu');
  if (!menu) return;
  const r = btn.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return ddClose();
  menu.style.minWidth = `${r.width}px`;
  const h = menu.offsetHeight, w = Math.max(menu.offsetWidth, r.width);
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 6 + h > innerHeight - 8 && r.top - 6 - h > 8 ? r.top - 6 - h : r.bottom + 6}px`;
}
function ddPick(wrap, i) {
  const sel = wrap.querySelector('select');
  ddClose();
  if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  ddSync(wrap);
  wrap.querySelector('.dd-btn').focus();
}
function ddClose() {
  if (!ddOpen) return;
  ddOpen.querySelector('.dd-menu')?.remove();
  ddOpen.classList.remove('open');
  ddOpen.querySelector('.dd-btn').setAttribute('aria-expanded', 'false');
  ddOpen = null;
}
document.addEventListener('pointerdown', (e) => { if (ddOpen && !ddOpen.contains(e.target)) ddClose(); }, true);
document.addEventListener('scroll', (e) => { if (ddOpen && !ddOpen.querySelector('.dd-menu')?.contains(e.target)) ddPlace(ddOpen); }, true);
addEventListener('resize', ddClose);
enhanceSelects();

// ================================================================ relevés du switch (sans modifier l'agent)
// Le dashboard envoie lui-même des commandes en lecture seule et analyse les réponses.
const DIAG_CMD = ['show interface link-status', 'show spanning-tree', 'checkpoint diff startup-config running-config',
  'show logging -r -n 80', 'show ip interface vlan1', 'show system'].join('\n');
const DIAG_EVERY = 300;
const diagEvery = () => (ROLE === 'viewer' ? 2 * DIAG_EVERY : DIAG_EVERY); // écran lecture seule : toutes les 10 min
const isAuto = (c) => /^(auto|probe)/.test(c.kind || '');
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const STP_FR = { Root: 'racine', Designated: 'désigné', Alternate: 'alternatif', Backup: 'secours', Disabled: 'inactif',
  Forwarding: 'transmet', Blocking: 'BLOQUÉ', Discarding: 'BLOQUÉ', Learning: 'apprentissage', Listening: 'écoute', Down: 'coupé' };
let DIAG = null, diagAsked = 0, logFilter = 'all', BCAST = null, bcastPrev = null;
let AGENT_DIAG = { h: '', t: 0, out: '' }, diagFetching = false, DIAG_HIST = [];

const stpBlocked = (p) => p.up && /Blocking|Discarding/i.test(DIAG?.ports[p.port]?.stp?.state || '');
function sinceText(p) {
  const t = DIAG?.ports[p.port]?.last;
  if (!t) return '';
  const s = Math.max(0, NOW - t);
  return `depuis ${s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} j`}`;
}
function flapCell(p, long) {
  const t = DIAG?.ports[p.port]?.transitions, f = DIAG?.flaps?.[p.port] || 0;
  if (t == null) return '<span class="muted">-</span>';
  return `${nf0.format(t)}${f >= 4 ? ' <span class="badge amber" title="coupures récentes">instable</span>' : ''}${long ? ' <span class="muted">depuis le démarrage du switch</span>' : ''}`;
}
function latestDiag() { return LOG.find((c) => c.kind === 'auto:diag'); }
// Relevés automatiques ratés (connexion SSH refusée par le switch, agent ancien…) : nouvel essai après 1, 2, 5, 10, puis
// 15 min au plus. Compté d'après le journal des commandes, partagé par toutes les pages et relu au rechargement : une page
// rechargée ne relance pas tout de suite, et le premier relevé réussi remet l'attente à zéro.
const AUTO_RETRY = [60, 120, 300, 600, 900];
const retryWait = (n) => AUTO_RETRY[Math.min(n, AUTO_RETRY.length) - 1];
const autoLost = (c) => ['pending', 'running'].includes(c.status) && NOW - c.created >= 180; // jamais exécuté par l'agent
// Échecs consécutifs d'un relevé automatique (kind), du plus récent au plus ancien, jusqu'au premier réussi (ok). Un relevé
// en cours est sauté ; une sortie pas encore lue arrête le compte.
function autoFails(kind, ok) {
  const out = [];
  for (const c of LOG) {
    if (c.kind !== kind) continue;
    if (ok(c)) break;
    if (autoLost(c) || c.status === 'error' || (c.status === 'done' && OUT[c.id] !== undefined)) out.push(c);
    else if (!['pending', 'running'].includes(c.status)) break;
  }
  return out;
}
// Relevés de la page ratés à la suite. Avec un agent qui fait lui-même le relevé (1.3.0 et plus), un essai raté (bouton
// « Actualiser ») plus ancien que son dernier relevé ne compte plus : le relevé affiché est le sien, et il est frais.
function diagFails() {
  const fails = autoFails('auto:diag', diagUsable);
  const agentT = S?.diag?.h ? Math.max(S.diag.t || 0, DIAG?.src === 'agent' ? DIAG.t : 0) : 0;
  return agentT ? fails.filter((c) => (c.finished || c.created) > agentT) : fails;
}
const diagRunning = () => { const c = latestDiag(); return Boolean(c && ['pending', 'running'].includes(c.status) && NOW - c.created < 180); };
const agentQuiet = () => !S?.received || NOW - S.received > 90; // agent muet : un relevé resterait dans la file
// Heure du prochain relevé automatique : diagEvery() après un relevé réussi, attente croissante après des échecs.
function diagNext() {
  const last = latestDiag();
  if (!last) return NOW;
  const n = diagFails().length;
  return (last.finished || last.created) + (n ? retryWait(n) : diagEvery());
}
// Relevé du switch par la page (agent sans relevé intégré) : 'sent' (mis en file), 'running' (déjà en cours) ou rien.
// manual : bouton « Actualiser », essai immédiat même pendant l'attente après des échecs.
async function maybeDiag(force, manual) {
  if (!S || $('#app').hidden || document.hidden) return;
  if (S.diag?.h && !manual) return; // l'agent 1.3.0 fait lui-même le relevé, à son rythme
  if (diagRunning()) return 'running';
  if (!manual && agentQuiet()) return; // il partira au retour de l'agent, au lieu de s'empiler dans la file
  if (!force && NOW < diagNext()) return;
  if (Date.now() / 1000 - diagAsked < (force ? 5 : 60)) return;
  diagAsked = Date.now() / 1000;
  try { await api('/api/command', { cmd: DIAG_CMD, label: 'Relevé automatique', kind: 'auto:diag' }); setTimeout(poll, 800); return 'sent'; } catch {}
}
$('#diagRefresh').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const r = await maybeDiag(true, true);
  if (r === 'running') toast('Relevé déjà en cours', { sub: 'Résultat dans quelques secondes.' });
  else if (r === 'sent') toast('Relevé demandé au switch', { sub: agentQuiet() ? 'L’agent ne répond pas pour l’instant : le relevé partira à son retour.' : 'Résultat dans quelques secondes.' });
}));
// État des relevés en clair (carte Switch, journal du switch). Textes : espace insécable (\u00a0) dans « » et avant « : ».
const diagHM = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtEvery = (x) => (x < 60 ? `${x} s` : `${Math.round(x / 60)} min`);
// Prochain essai, en une phrase : la page relance (attente croissante après des échecs), ou l'agent refait son relevé.
function diagNextText() {
  if (agentQuiet()) return 'Prochain essai dès que l’agent répondra.';
  if (S?.diag?.h) return `Nouvel essai au prochain relevé de l’agent${S.diag.every ? ` (toutes les ${fmtEvery(S.diag.every)})` : ''}.`; // la page ne relance pas
  const t = diagNext();
  return `Prochain essai ${t - NOW < 45 ? 'dans moins d’une minute' : `vers ${new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`}.`;
}
const nbsp = (s) => String(s).replace(/ ([:;!?»])/g, '\u00a0$1').replace(/« /g, '«\u00a0'); // texte reçu (message de l'agent)
const quote = (s) => `«\u00a0${nbsp(s)}\u00a0»`;
// Causes connues d'un relevé raté, dites en clair ; le message réel reste affiché en « Détail technique ».
const DIAG_CAUSES = [
  [/mot de passe SSH refusé|Authentication failed|AuthenticationException/i, 'le switch refuse le mot de passe SSH de l’agent'],
  [/protocol banner|reset by peer|connection reset|EOFError|socket is closed|session not active/i, 'le switch a refusé ou coupé la connexion SSH de l’agent'],
  [/timed? ?out|No route to host|unreachable|Unable to connect|WinError 10060/i, 'le switch ne répond pas à l’agent (adresse, câble ou réseau)'],
  [/Connection refused|WinError 10061/i, 'le switch refuse la connexion SSH de l’agent'],
  [/^% ?Invalid|Invalid input/i, 'le switch n’a pas reconnu une commande du relevé'],
];
// Relevé raté : cause en clair (why, sans point final) et ligne réelle de l'agent ou du switch (raw).
function diagFail(c) {
  if (OUT[c.id] === undefined) return { why: 'détail en cours de lecture' };
  const lines = String(OUT[c.id]).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('» '));
  const raw = (lines.find((x) => /^(%|Erreur|Error|ERROR|Invalid)/.test(x)) || lines[0] || '').slice(0, 240);
  if (!raw) return { why: 'le switch n’a renvoyé aucune réponse' };
  return { why: DIAG_CAUSES.find(([re]) => re.test(raw))?.[1] || '', raw };
}
// Où en sont les relevés. k : 'running', 'quiet' (agent muet : PC éteint, agent arrêté), 'fail' (relevés ratés, n de
// suite, le plus récent c), 'lost' (relevés jamais exécutés par l'agent), '' (rien à signaler).
function diagState() {
  if (!S) return { k: '' };
  if (diagRunning()) return { k: 'running' };
  const fails = diagFails(), real = fails.filter((c) => !autoLost(c)), lost = fails.filter(autoLost);
  if (agentQuiet() && (fails.length || (!DIAG && !S.diag?.h))) return { k: 'quiet', lost, age: NOW - (S.received || S.updated || NOW) };
  if (real.length) return { k: 'fail', c: real[0], n: real.length, lost, ...diagFail(real[0]) };
  if (lost.length) return { k: 'lost', lost };
  return { k: '' };
}
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const lostText = (lost) => `${plural(lost.length, 'relevé en attente', 'relevés en attente')} depuis ${diagHM(lost.at(-1).created)}`;
// Agent d'avant 1.3.0 dont les relevés échouent : encadré « mets-le à jour » au-dessus du journal du switch, et une ligne
// sous la note de la carte Switch. Le lien mène tout droit à la marche à suivre (deux lignes à coller dans PowerShell).
const AGENT_GUIDE = 'https://github.com/ethanfrq/ArubaDashboardSwitch/blob/main/agent/INSTALLATION-WINDOWS.md#passer-dune-ancienne-version-avant-130';
const guideLink = (text) => `<a href="${AGENT_GUIDE}" target="_blank" rel="noopener">${text}${icon('open_in_new', { size: 14 })}<span class="sr"> (marche à suivre sur GitHub, nouvel onglet)</span></a>`;
function agentOldBox() {
  const av = S?.agent?.version, ver = agentSemver(av) ? `version ${av}` : 'version antérieure à 1.3.0';
  return `<div class="alert amber diag-agent">${icon('warning', { size: 16 })}<div><b>L’agent installé sur le PC est ancien\u00a0: mets-le à jour.</b>
    <span>Les relevés du switch échouent avec lui (${esc(ver)}, dernière version ${AGENT_LATEST}). Depuis la version 1.3.0, l’agent fait lui-même le relevé et rouvre sa connexion SSH quand le switch l’a fermée. Une seule mise à jour à la main suffit (deux lignes à coller dans PowerShell, configuration et mot de passe conservés)\u00a0; ensuite, il se met à jour tout seul.</span>
    ${guideLink('Mettre à jour l’agent')}</div></div>`;
}

function sections(out) {
  const sec = {}; let cur = null;
  for (const l of String(out || '').split('\n')) {
    const m = l.match(/^» (.*)$/);
    if (m) { cur = m[1].trim(); sec[cur] = []; } else if (cur) sec[cur].push(l);
  }
  return sec;
}
function frLog(msg) {
  return msg
    .replace(/^Link status for interface 1\/1\/(\d+) is (up|down).*$/i, (m, n, st) => `Port ${n} : lien ${st === 'up' ? 'établi' : 'coupé'}`)
    .replace(/^User (\S+) logged in from (\S+) through (\S+) session\.?$/i, 'Connexion de $1 depuis $2 ($3)')
    .replace(/^User (\S+) logged out of (\S+) session from (\S+?)\.?$/i, 'Déconnexion de $1 ($2, $3)')
    .replace(/^User (\S+) login from (\S+) for (\S+) session (?:has )?failed.*$/i, 'Échec de connexion de $1 depuis $2 ($3)')
    .replace(/^Port 1\/1\/(\d+) blocked on CIST.*$/i, 'Port $1 bloqué par le spanning-tree')
    .replace(/^CIST - Topology Change generated on port 1\/1\/(\d+).*$/i, 'Changement de topologie spanning-tree (port $1)');
}
function parseDiag(out, t, id, h = '') {
  const sec = sections(out);
  const d = { id, src: id === 'agent' ? 'agent' : 'cmd', h, t, ports: {}, logs: [], flaps: {} };
  for (const l of sec['show interface link-status'] || []) {
    const m = l.match(/^(1\/1\/\d+)\s+\S+\s+(up|down)\s+(.+?)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const dm = m[5].match(/\(\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) \S+ (\d{4})\)/);
    d.ports[m[1]] = { transitions: Number(m[4]), last: dm ? new Date(+dm[6], MONTHS[dm[1]], +dm[2], +dm[3], +dm[4], +dm[5]).getTime() / 1000 : null };
  }
  const stpTxt = (sec['show spanning-tree'] || []).join('\n');
  const rootMac = (stpTxt.match(/Root ID[\s\S]*?MAC-Address:\s*(\S+)/) || [])[1];
  const brMac = (stpTxt.match(/Bridge ID[\s\S]*?MAC-Address:\s*(\S+)/) || [])[1];
  for (const l of sec['show spanning-tree'] || []) {
    const m = l.match(/^(1\/1\/\d+)\s+(\S+)\s+(\S+)\s+\d+/);
    if (m) (d.ports[m[1]] ||= {}).stp = { role: m[2], state: m[3] };
  }
  d.stp = { enabled: /status\s*:\s*Enabled/i.test(stpTxt), protocol: (stpTxt.match(/Protocol:\s*(\S+)/) || [])[1], rootMac, isRoot: Boolean(rootMac && rootMac === brMac),
    rootPort: Object.entries(d.ports).find(([, v]) => v.stp?.role === 'Root')?.[0] };
  const diff = (sec['checkpoint diff startup-config running-config'] || []).join('\n');
  d.saved = /No difference/i.test(diff) ? true : /^[+-]|differ/im.test(diff) ? false : null;
  for (const l of sec[Object.keys(sec).find((k) => k.startsWith('show logging')) || ''] || []) {
    const m = l.match(/^(\d{4}-\d\d-\d\dT[\d:.]+[+-]\d\d:\d\d)\s+\S+\s+([\w.-]+)\[\d+\]:\s*(?:Event\|\d+\|(LOG_\w+)\|[^|]*\|[^|]*\|)?(.*)$/);
    if (!m) continue;
    const lvl = /ERR|CRIT|ALERT|EMERG/.test(m[3] || '') ? 'err' : /WARN/.test(m[3] || '') ? 'warn' : 'info';
    d.logs.push({ t: Date.parse(m[1]) / 1000, src: m[2], lvl, raw: m[4].trim(), msg: frLog(m[4].trim()), port: /interface 1\/1\/|port 1\/1\//i.test(m[4]) });
  }
  d.ip = ((sec['show ip interface vlan1'] || []).join('\n').match(/IPv4 address\s+(\S+)/) || [])[1];
  const bm = (sec['show system'] || []).join('\n').match(/Base MAC Address\s*:\s*([0-9a-f]{6})-([0-9a-f]{6})/i);
  d.mac = bm ? (bm[1] + bm[2]).match(/../g).join(':') : null;
  DIAG = d;
}
// Instabilité : coupures de chaque port pendant les 10 dernières minutes, d'après les relevés successifs.
function trackFlaps() {
  if (!DIAG) return;
  const snap = Object.fromEntries(Object.entries(DIAG.ports).map(([p, v]) => [p, v.transitions]));
  if (DIAG_HIST.at(-1)?.t !== DIAG.t) DIAG_HIST.push({ t: DIAG.t, ports: snap });
  DIAG_HIST = DIAG_HIST.filter((x) => DIAG.t - x.t <= 600);
  const base = DIAG_HIST[0];
  DIAG.flaps = {};
  for (const [port, n] of Object.entries(snap)) if (base?.ports[port] != null && n != null) DIAG.flaps[port] = n - base.ports[port];
}
async function fetchAgentDiag() {
  diagFetching = true;
  try {
    const { diag } = await api('/api/output?diag=1');
    if (diag?.out) { AGENT_DIAG = diag; render(); }
  } catch {} finally { diagFetching = false; }
}
// Relevé exploitable : terminé (même avec une erreur sur une commande) et contenant l'état des ports.
// Un relevé raté (session SSH coupée par le switch après une longue inactivité…) n'efface pas le précédent.
const diagUsable = (x) => ['done', 'error'].includes(x.status) && /^1\/1\/\d+\s/m.test(OUT[x.id] || '');
function updateDiag() {
  const ad = S?.diag;
  if (ad?.h && ad.h !== AGENT_DIAG.h && !diagFetching) fetchAgentDiag(); // l'agent a vu un changement
  const c = LOG.find((x) => x.kind === 'auto:diag' && diagUsable(x));
  const cmdT = c ? c.finished || c.created : 0;
  const agentT = AGENT_DIAG.out ? Math.max(AGENT_DIAG.t, ad?.h === AGENT_DIAG.h ? ad.t : 0) : 0;
  if (agentT && agentT >= cmdT) {
    if (DIAG?.src !== 'agent' || DIAG.h !== AGENT_DIAG.h) parseDiag(AGENT_DIAG.out, agentT, 'agent', AGENT_DIAG.h);
    else DIAG.t = agentT; // relevé refait par l'agent, rien n'a changé
  } else if (c && DIAG?.id !== c.id) parseDiag(OUT[c.id], cmdT, c.id);
  trackFlaps();
}
function updateBcast() {
  if (!S?.ports || S.updated === bcastPrev?.t) return;
  const cur = { t: S.updated, v: Object.fromEntries(S.ports.map((p) => [p.port, (p.rx_bcast || 0) + (p.rx_mcast || 0)])) };
  if (bcastPrev && cur.t > bcastPrev.t) {
    const dt = cur.t - bcastPrev.t, rates = Object.entries(cur.v).map(([k, v]) => [k, Math.max(0, v - (bcastPrev.v[k] ?? v)) / dt]);
    rates.sort((a, b) => b[1] - a[1]);
    BCAST = { total: rates.reduce((a, r) => a + r[1], 0), top: rates[0] };
  }
  bcastPrev = cur;
}
function renderSwitch() {
  const d = DIAG, t = (S.temps || []).reduce((a, b) => (!a || b.temp > a.temp ? b : a), null);
  const blocked = (S.ports || []).filter(stpBlocked).map((p) => portNum(p.port));
  const rows = [
    ['IP de gestion', esc(d?.ip?.replace(/\/\d+$/, '') || S.mgmt_ip || '-')],
    ['Adresse MAC', `<span class="mono">${esc(d?.mac || S.base_mac || '-')}</span>`],
    ['N° de série', `<span class="mono">${esc(S.serial || '-')}</span>`],
    ['Firmware', esc(S.version ? `AOS-CX ${S.version}` : '-')],
    ['Configuration', !d || d.saved == null ? '<span class="muted">-</span>' : d.saved ? `<span class="good">${icon('check_circle', { size: 16 })} sauvegardée</span>`
      : `<span class="warn">${icon('warning', { size: 16 })} non sauvegardée</span> <button class="btn small admin-only" data-save>Sauvegarder</button>`],
    ['Spanning-tree', !d ? '-' : !d.stp.enabled ? '<span class="warn">désactivé</span>'
      : `${esc(d.stp.protocol || '')} · ${d.stp.isRoot ? 'ce switch est la racine' : `racine : autre switch${d.stp.rootPort ? ` (via port ${portNum(d.stp.rootPort)})` : ''}`}`
        + (blocked.length ? `<br><span class="bad">port${blocked.length > 1 ? 's' : ''} bloqué${blocked.length > 1 ? 's' : ''} : ${blocked.join(', ')}</span>` : '')],
    ['Broadcast reçu', !BCAST ? '<span class="muted">calcul en cours…</span>' : `<span class="${BCAST.total > 500 ? 'bad' : ''}">${nf0.format(BCAST.total)} paquets/s</span>`
      + (BCAST.total > 500 ? `<br><span class="bad">possible boucle réseau (surtout port ${portNum(BCAST.top[0])})</span>` : '')],
    ['Température', t ? `${nf.format(t.temp)} °C <span class="muted">(${(S.temps || []).length} capteurs, ${(S.temps || []).every((x) => x.status === 'normal') ? 'tous normaux' : 'alerte'})</span>` : '-'],
  ];
  setHTML($('#swInfo'), rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(''));
  const ds = diagState(), every = S.diag?.every, last = d ? `Dernier relevé réussi ${ago(NOW - d.t)}. ` : '';
  const lostN = ds.lost?.length, notYet = lostN > 1 ? 'ne les a pas encore exécutés' : 'ne l’a pas encore exécuté';
  $('#diagNote').textContent = ds.k === 'running' ? 'Relevé du switch en cours…'
    : ds.k === 'quiet' ? `${last}L’agent ne répond plus depuis ${fmtDur(ds.age)}\u00a0: vérifie que le PC est allumé. Le relevé partira à son retour.`
    : ds.k === 'fail' ? `${last}Relevé impossible\u00a0: ${ds.why || quote(ds.raw)} (dernier essai ${diagHM(ds.c.finished || ds.c.created)}${ds.n > 1 ? `, ${ds.n} échecs de suite` : ''}).${d ? '' : ' Configuration et spanning-tree indisponibles.'} ${diagNextText()}`
    : ds.k === 'lost' ? `${lostText(ds.lost)}\u00a0: l’agent ${notYet}. ${diagNextText()}`
    : d ? `Relevé ${ago(NOW - d.t)} · ${every ? `refait par l’agent toutes les ${fmtEvery(every)}` : `actualisé toutes les ${diagEvery() / 60} min quand le dashboard est ouvert`}.`
    : S.diag?.h ? 'Lecture du relevé de l’agent…' : `Premier relevé en attente. ${diagNextText()}`;
  // agent d'avant 1.3.0 : une ligne sous la note (l'encadré complet est au-dessus du journal du switch)
  setHTML($('#diagWarn'), ds.k === 'fail' && agentPre13() ? `<p class="note diag-agent-line">${icon('warning', { size: 16, cls: 'ic-warn' })}<span>L’agent du PC est ancien\u00a0: ${guideLink('mets-le à jour')}</span></p>` : '');
  $('#unsavedPill').hidden = !(d && d.saved === false);
}
$('#swInfo').addEventListener('click', (e) => { if (e.target.closest('[data-save]')) $('#unsavedPill').click(); });
const saveText = (t) => [ADMIN.saveWarning?.(), t].filter(Boolean).join(' '); // avertit pendant un délai d'annulation automatique
$('#unsavedPill').addEventListener('click', () => canOperate() && confirmCmd('Sauvegarder la configuration ?', saveText('Les changements en cours deviennent la configuration chargée au démarrage du switch.'), 'write memory', 'Configuration sauvegardée'));
// Journal du switch : en attente de l'agent ou du premier relevé, relevé en cours, agent muet, relevé impossible, relevés
// jamais exécutés, aucun événement, ou les événements. Un agent d'avant 1.3.0 dont les relevés échouent est signalé
// au-dessus (#logWarn), hors de la liste qui défile.
function renderLogs() {
  const d = DIAG, ds = diagState();
  setHTML($('#logWarn'), ds.k === 'fail' && agentPre13() ? agentOldBox() : '');
  // état : icône, titre éventuel, puis une ligne par élément (texte, ou HTML déjà composé commençant par « < »)
  const state = (ic, title, ...lines) => `<div class="empty diag-state">${ic}${title ? `<b>${title}</b>` : ''}${lines.filter(Boolean).map((l) => (l.startsWith('<') ? l : `<span>${l}</span>`)).join('')}</div>`;
  $('#logCount').textContent = d?.logs.length ? plural(d.logs.length, 'dernier événement', 'derniers événements') : '';
  let body;
  if (!S) body = state(icon('hourglass_empty', { size: 18 }), '', 'En attente de l’agent\u00a0: le journal du switch s’affichera après son premier envoi.');
  else if (!d) {
    const n = ds.lost?.length, next = diagNextText();
    body = ds.k === 'running' ? state('<span class="spinner"></span>', '', 'Relevé du switch en cours…')
      : ds.k === 'quiet' ? state(icon('power_settings_new', { size: 18, cls: 'ic-warn' }), `L’agent ne répond plus depuis ${fmtDur(ds.age)}`,
        'Vérifie que le PC de l’agent est allumé et relié au réseau, et que l’agent tourne\u00a0: le relevé du switch partira à son retour.',
        n && `${lostText(ds.lost)}, pas encore exécuté${n > 1 ? 's' : ''}.`)
      : ds.k === 'fail' ? state(icon('error', { size: 18, cls: 'ic-bad' }), 'Relevé impossible',
        ds.why && `${ds.why[0].toUpperCase()}${ds.why.slice(1)}.`,
        ds.raw && `<span class="diag-err">Détail technique\u00a0: <span class="mono">${esc(quote(ds.raw))}</span></span>`,
        'Sans relevé, le journal du switch, l’état de la configuration et le spanning-tree ne s’affichent pas.',
        `Dernier essai\u00a0: ${diagHM(ds.c.finished || ds.c.created)}${ds.n > 1 ? ` (${ds.n} échecs de suite)` : ''}. ${next}`,
        n && `${lostText(ds.lost)}, pas encore exécuté${n > 1 ? 's' : ''}.`)
      : ds.k === 'lost' ? state(icon('hourglass_top', { size: 18 }), 'Relevé en attente',
        `${lostText(ds.lost)}\u00a0: l’agent ${n > 1 ? 'ne les a pas encore exécutés' : 'ne l’a pas encore exécuté'}.`, next)
      : S.diag?.h ? state('<span class="spinner"></span>', '', 'Lecture du relevé de l’agent…')
      : state(icon('hourglass_empty', { size: 18 }), '', `Premier relevé en attente. ${diagNextText()}`);
  } else if (!d.logs.length) body = '<div class="empty">Aucun événement dans le journal du switch.</div>';
  else {
    const list = d.logs.filter((l) => logFilter === 'all' || (logFilter === 'warn' ? l.lvl !== 'info' : l.port));
    body = list.length ? list.map((l) => `<div class="log-item ${l.lvl}" title="${esc(l.raw)}"><span class="when">${new Date(l.t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
    <div><span class="msg">${esc(l.msg)}</span> <span class="src">${esc(l.src)}</span></div></div>`).join('') : '<div class="empty">Aucun événement pour ce filtre.</div>';
  }
  setHTML($('#logList'), body);
}
$('#logFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  logFilter = b.dataset.f; [...$('#logFilter').children].forEach((x) => x.classList.toggle('on', x === b)); renderLogs();
});

// ================================================================ rendu
function render() {
  renderAgent();
  if (!S) { $('#hostname').textContent = 'En attente de l’agent'; $('#subtitle').textContent = 'Aucune donnée reçue pour l’instant.'; renderTerm(); renderAlerts(); renderLogs(); return; }
  $('#hostname').textContent = $('#conHost').textContent = S.hostname || 'Switch';
  $('#subtitle').textContent = $('#subtitle').title = [DIAG?.ip?.replace(/\/\d+$/, '') || S.mgmt_ip, S.model, S.location && `Emplacement ${S.location}`, S.version && `AOS-CX ${S.version}`, S.uptime && `allumé depuis ${S.uptime.replace(/weeks?/, 'sem.').replace(/days?/, 'j').replace(/hours?/, 'h').replace(/minutes?/, 'min')}`].filter(Boolean).join(' · ');
  updateDiag(); updateBcast();
  renderKpis(); renderFaceplate(); renderPorts(); renderChart(); renderPanel(); renderVlans(); renderTerm(); renderAlerts(); fillPortSelect(); renderSwitch(); renderLogs(); ddSyncAll();
  const site = SETTINGS?.siteName;
  document.title = `${site || 'My Aruba Manager'} · ${S.hostname || 'switch'}`;
  hook('render');
}

function renderAgent() {
  const pill = $('#agentPill');
  const av = S?.agent?.version;
  const maj = S?.agent?.maj, older = agentOlder();
  setHTML($('#agentVersion'), !S?.agent ? '' : esc(agentSemver(av) ? `agent v${av}` : 'agent : version antérieure à 1.3.0')
    + (maj ? ` · mise à jour auto ${maj.ok ? icon('check_circle', { size: 14, label: 'réussie', cls: 'ic-good' }) : icon('warning', { size: 14, label: 'en échec', cls: 'ic-warn' })}`
      : older ? ` · v${AGENT_LATEST} disponible${agentPre13() ? `, ${guideLink('mettre à jour l’agent')}` : ''}` : '')); // même marche à suivre que l'encadré du journal
  $('#agentVersion').title = maj ? `${maj.msg || ''} (vérifié ${ago(NOW - (maj.t || 0))})` : older && !agentPre13() ? 'L’agent se met à jour tout seul dans les minutes qui viennent.' : '';
  if (!S) { pill.className = 'pill ko'; pill.lastElementChild.textContent = 'Agent jamais connecté'; $('#conMode').textContent = 'L’agent ne s’est encore jamais connecté : les commandes attendront son premier envoi.'; return; }
  const age = NOW - (S.received || S.updated);
  const every = S.agent?.sync || 10;
  const online = age < Math.max(45, every * 2.5);
  const working = !online && age < 600 && LOG.some((c) => c.status === 'running');
  pill.className = 'pill ' + (online ? 'ok' : working ? '' : 'ko');
  pill.lastElementChild.textContent = online ? `Agent en ligne · ${ago(age)}` : working ? 'Agent occupé : commande longue en cours…' : `Agent hors ligne · ${ago(age)}`;
  pill.title = `${S.agent?.host ? `Agent sur ${S.agent.host}. ` : ''}Envoi toutes les ${every} s (${SETTINGS?.agent?.hot ?? 10} s quand le dashboard est ouvert, ${SETTINGS?.agent?.warm ?? 30} s pour un écran lecture seule, ${SETTINGS?.agent?.idle ?? 60} s sinon).`;
  const hotEvery = SETTINGS?.agent?.hot ?? 10, idleEvery = SETTINGS?.agent?.idle ?? 60;
  const realtime = online && every <= hotEvery * 2, soon = idleEvery <= 60 ? 'moins d’une minute' : `moins de ${Math.ceil(idleEvery / 60)} min`;
  $('#termMode').textContent = realtime ? 'temps réel : exécution en 1 à 5 s' : `l’agent passe en temps réel dans ${soon}`;
  $('#conMode').textContent = realtime ? 'Agent en ligne : exécution en 1 à 5 s.' : online ? `Agent en ligne : il passe en temps réel dans ${soon}.`
    : working ? 'Agent occupé par une commande longue : la suivante attendra la fin.' : `Agent hors ligne (${ago(age)}) : les commandes partiront à son retour.`;
}

function renderKpis() {
  const ports = S.ports || [];
  const up = ports.filter((p) => p.up).length;
  const usable = ports.filter((p) => p.enabled && p.reason !== 'No XCVR installed').length;
  $('#kPorts').innerHTML = `${up} <small>/ ${usable}</small>`;
  const idle = ports.filter((p) => pState(p) === 'idle').length, slow = ports.filter(isSlow).length;
  const off = ports.filter((p) => !p.enabled).map((p) => portNum(p.port));
  $('#kPortsHint').textContent = [idle && `${idle} sans trafic`, slow && `${slow} lent${slow > 1 ? 's' : ''}`, off.length && `désactivé : ${off.join(', ')}`].filter(Boolean).join(' · ') || 'tout est normal';
  const last = (S.history || []).at(-1);
  $('#kRx').textContent = last ? fmtBps(last[1]) : '-';
  $('#kTx').textContent = last ? fmtBps(last[2]) : '-';
  const macs = S.macs || [], ips = S.ips || {};
  $('#kDev').textContent = nf0.format(macs.length);
  const withIp = macs.filter((m) => ips[m.mac]).length;
  $('#kDevHint').textContent = S.agent?.scan ? `${withIp} avec IP connue` : 'adresses MAC apprises';
  $('#kCpu').innerHTML = `${esc(S.cpu ?? '-')} % <small>· ${esc(S.mem ?? '-')} %</small>`;
  $('#kCpuBar').style.width = `${Math.min(100, S.cpu || 0)}%`;
  const temps = S.temps || [];
  if (temps.length) {
    const max = temps.reduce((a, b) => (b.temp > a.temp ? b : a));
    const bad = temps.filter((t) => t.status !== 'normal');
    $('#kTemp').textContent = `${nf.format(max.temp)} °C`;
    setHTML($('#kTempHint'), bad.length ? `${icon('warning', { size: 14, cls: 'ic-warn' })} ${bad.length} capteur(s) en alerte` : `tous normaux · air ${nf.format(temps.find((t) => /Inlet/.test(t.sensor))?.temp ?? 0)} °C`);
  }
}

// ---------------------------------------------------------------- façade
const meterPct = (bps) => (bps > 0 ? Math.min(100, Math.max(6, (Math.log10(bps) / 9) * 100)) : 0);
function renderFaceplate() {
  const ports = Object.fromEntries((S.ports || []).map((p) => [portNum(p.port), p]));
  const jack = (n, sfp) => {
    const p = ports[n]; if (!p) return '<span></span>';
    const st = pState(p), bps = (p.rx_bps || 0) + (p.tx_bps || 0);
    const empty = sfp && p.reason === 'No XCVR installed';
    const cab = st === 'down' ? cableOf(p.port) : null;
    const cabCls = cab && cab.kind !== 'empty' ? (cab.kind === 'fault' ? 'fault' : 'cable') : null;
    const cabWarn = cab?.kind === 'partial';
    const unk = st === 'down' && !cab ? cableUnknown(p) : null;
    const up = isUplink(p), slow = isSlow(p);
    const meta = st === 'off' ? 'désactivé' : empty ? 'vide'
      : st === 'down' ? (cabCls ? `${cab.len} m` : unk ? 'à vérifier' : 'libre')
      : st === 'idle' ? durShort(quietFor(p)) : fmtBps(bps).replace(' ', ' ');
    const metaIc = st === 'idle' && !empty ? icon('hourglass_empty', { size: 11 }) : '';
    const tip = [`Port ${n}`, stInfo(p).label, unk && unkText(p, unk), p.speed && `${p.speed} Mb/s${slow ? ' (lent)' : ''}`, up && 'lien vers un autre switch',
      p.vlan !== '1' && `VLAN ${p.vlan}`, st === 'idle' && `aucun paquet reçu depuis ${fmtDur(quietFor(p))}`,
      cab && { partial: `test câble : paire${cab.open?.length > 1 ? 's' : ''} ${(cab.open || []).join(', ')} ouverte${cab.open?.length > 1 ? 's' : ''}, autres bonnes (${cab.len} m)`, empty: 'test câble : rien de branché', open: `test câble : câble ${cab.len} m, rien au bout`, good: `test câble : câble ${cab.len} m en bon état, appareil éteint`, fault: `test câble : DÉFAUT vers ${cab.len} m` }[cab.kind], st === 'up' && `${fmtBps(bps)} (charge ${fmtPct(loadPct(Math.max(p.rx_bps || 0, p.tx_bps || 0), p))})`, p.desc, sinceText(p) && `changé ${sinceText(p)}`, DIAG?.ports[p.port]?.transitions != null && `${DIAG.ports[p.port].transitions} coupures depuis le démarrage`, stpBlocked(p) && 'BLOQUÉ par le spanning-tree'].filter(Boolean).join(' · ');
    const cls = ['jack', sfp && 'sfp', empty ? 'nomod' : cabCls || (unk ? 'unk' : st), selected === p.port && 'sel', pendingFor(p.port) && 'busy'].filter(Boolean).join(' ');
    const tags = (cabCls ? `<span class="tag${cabCls === 'fault' || cabWarn ? ' slow' : ''}">${cabCls === 'fault' || cabWarn ? icon('warning', { size: 12 }) : `${icon('settings_ethernet', { size: 12 })}${cab.kind === 'good' ? 'ok' : ''}`}</span>` : unk ? `<span class="tag">${icon('question_mark', { size: 12 })}</span>` : '')
      + (stpBlocked(p) ? '<span class="tag stp">STP</span>' : '') + (up ? `<span class="tag">${icon('swap_vert', { size: 12 })}</span>` : '') + (p.vlan !== '1' ? `<span class="tag">V${esc(p.vlan)}</span>` : '')
      + (p.up && p.speed ? `<span class="tag${slow ? ' slow' : ''}">${speedTag(Number(p.speed))}</span>` : '');
    return `<button class="${cls}" data-port="${esc(p.port)}" title="${esc(tip)}" aria-label="${esc(tip)}" aria-pressed="${selected === p.port}">
      <span class="top"><span class="led"></span><span class="n">${n}</span>${tags}</span>
      <span><span class="meta">${metaIc}${esc(meta)}</span><span class="meter"><i style="width:${st === 'up' ? meterPct(bps) : 0}%"></i></span></span>
    </button>`;
  };
  let html = `<div class="fp-brand"><b>aruba</b>${esc((S.model || '').replace(/^\S+\s/, '').replace(/\s*Swch$/, ''))}</div>`;
  for (const [a, b] of [[1, 12], [13, 24]]) { html += '<div class="fp-group">'; for (let n = a; n <= b; n += 2) html += jack(n) + jack(n + 1); html += '</div>'; }
  html += '<div class="fp-group fp-sfp">' + jack(25, 1) + jack(26, 1) + jack(27, 1) + jack(28, 1) + '</div>';
  setHTML($('#faceplate'), html);
  hook('faceplate');
  const downs = (S.ports || []).filter((p) => pState(p) === 'down').map((p) => cableOf(p.port)).filter(Boolean);
  const cabled = downs.filter((c) => ['open', 'good'].includes(c.kind)), partial = downs.filter((c) => c.kind === 'partial'), faulty = downs.filter((c) => c.kind === 'fault');
  const unknown = (S.ports || []).filter((p) => pState(p) === 'down' && !cableOf(p.port) && cableUnknown(p)).length;
  const checking = LOG.some((c) => c.kind === 'auto:cable' && ['pending', 'running'].includes(c.status));
  const all = S.ports || [], count = (s) => all.filter((p) => pState(p) === s).length, slow = all.filter(isSlow).length, up = all.filter((p) => p.up).length;
  $('#fpCount').textContent = `${up} branché${up > 1 ? 's' : ''}`;
  $('#fpLegend').innerHTML = `
    <span><i class="sw" style="background:#1f6b34"></i>Actif <b>${count('up')}</b></span>
    <span><i class="sw" style="background:#6e5313"></i>${icon('hourglass_empty', { size: 14 })}Lien établi, aucun paquet <b>${count('idle')}</b></span>
    <span><i class="sw" style="background:#3a3a38"></i>Libre <b>${count('down') - cabled.length - partial.length - faulty.length - unknown}</b></span>
    ${unknown ? `<span title="Pas de test de câble valable : jamais testé, ou branché ou débranché depuis le dernier test"><i class="sw" style="background:#32312d;box-shadow:inset 0 0 0 2px rgb(217 180 90 / .6)"></i>${icon('question_mark', { size: 14 })}À vérifier <b>${unknown}</b>${checking ? ' <span class="spinner" aria-label="vérification en cours"></span>' : ''}</span>` : ''}
    <span><i class="sw" style="background:#2c3a4a"></i>${icon('settings_ethernet', { size: 14 })}Câble branché, pas de lien <b>${cabled.length}</b></span>
    ${partial.length ? `<span title="Test de câble : une ou plusieurs paires coupées, les autres bonnes"><i class="sw" style="background:#2c3a4a"></i>${icon('warning', { size: 14, cls: 'ic-warn' })}Paires ouvertes <b>${partial.length}</b></span>` : ''}
    ${faulty.length ? `<span><i class="sw" style="background:#4a2626;box-shadow:inset 0 0 0 2px #c9302c"></i>${icon('warning', { size: 14, cls: 'ic-warn' })}Câble en défaut <b>${faulty.length}</b></span>` : ''}
    <span><i class="sw" style="background:repeating-linear-gradient(135deg,#5a2422 0 3px,#4a1d1b 3px 6px)"></i>Désactivé <b>${count('off')}</b></span>
    ${slow ? `<span><span class="speed-slow mono">10M/100M</span>Vitesse réduite <b>${slow}</b></span>` : ''}
    <span>${icon('swap_vert', { size: 14 })}Lien vers un autre switch</span><span><span class="mono">V10</span>VLAN autre que 1</span>`;
}
onPick($('#faceplate'));

// Test de câble sur tous les ports sans lien (ne coupe rien : ces ports n'ont pas de lien).
$('#scanCables').addEventListener('click', () => {
  const ports = (S?.ports || []).filter((p) => p.enabled && !p.up && p.type === '1GbT').map((p) => p.port);
  if (!ports.length) return toast('Aucun port libre à tester', { type: 'warn' });
  const cmd = ['diagnostics', ...ports.flatMap((p) => [`diag cable-diagnostic test ${p}`, 'y', `diag cable-diagnostic show ${p}`])].join('\n');
  confirmCmd(`Scanner ${ports.length} port(s) libre(s) ?`,
    `Ports ${ports.map(portNum).join(', ')}. Pour chacun : y a-t-il un câble, sa longueur, et est-il en bon état ? Aucun appareil n’est coupé. Durée : environ ${Math.ceil(ports.length * 8 / 60)} min.`,
    cmd, `Scan câbles (${ports.length} ports)`, { ports, kind: 'cablescan' });
});

// Sélection / désélection d'un port
function onPick(root) {
  root.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; const b = e.target.closest('[data-port]'); if (b) togglePort(b.dataset.port); });
  root.addEventListener('click', (e) => { if (e.detail !== 0) return; const b = e.target.closest('[data-port]'); if (b) togglePort(b.dataset.port); });
}
function togglePort(p) { if (selected === p) closePanel(); else selectPort(p); }
function selectPort(p) { selected = p; $('#portPanel').hidden = false; $('#ppBody').innerHTML = ''; renderFaceplate(); renderPorts(); renderPanel(true); }
function closePanel() { if (!selected) return; selected = null; $('#portPanel').hidden = true; renderFaceplate(); renderPorts(); }
$('#ppClose').addEventListener('click', closePanel);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected && !ddOpen && !document.querySelector('dialog[open]')) closePanel(); });
document.addEventListener('pointerdown', (e) => {
  if (!selected || $('#portPanel').contains(e.target) || e.target.closest('[data-port],dialog,.toasts')) return;
  closePanel();
});

// ---------------------------------------------------------------- ports et appareils
let portSort = { key: 'port', dir: 1 }, showFree = false, portQuery = '';
const PORT_COLS = [
  ['port', 'Port'], ['state', 'État'], ['speed', 'Vitesse'], ['vlan', 'VLAN'], ['device', 'Appareil'], ['ip', 'IP'], ['mac', 'MAC'],
  ['rx', 'Entrant', 'r'], ['tx', 'Sortant', 'r'], ['total', 'Total reçu', 'r'], ['flaps', 'Coupures', 'r'], ['errs', 'Erreurs', 'r'],
];
const STATE_ORDER = { up: 0, idle: 1, off: 2, down: 3 };
const ipNum = (ip) => (ip ? ip.split('.').reduce((a, x) => a * 256 + Number(x), 0) : Infinity);
const isMacLike = (x) => /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(x || '');

// Ce qui est branché sur un port : switch voisin (LLDP), sinon le ou les appareils (MAC, IP, nom).
function portInfo(p) {
  const ips = S.ips || {};
  const macs = (S.macs || []).filter((m) => m.port === p.port).map((m) => m.mac);
  const lldp = (S.lldp || []).filter((l) => l.port === p.port);
  const sw = lldp.find((l) => l.name);
  const named = lldp.find((l) => !l.name && !isMacLike(l.chassis));
  const withIp = macs.filter((m) => ips[m]);
  let name = '', sub = '';
  if (sw) { name = `Switch ${sw.name}`; sub = `son port ${sw.port_id}${macs.length > 1 ? ` · ${macs.length} appareils derrière` : ''}`; }
  else if (named) name = named.chassis;
  else if (withIp.length && ips[withIp[0]].name) name = ips[withIp[0]].name;
  else if (macs.length) name = macs.length > 1 ? `${macs.length} appareils` : 'Appareil sans nom';
  // Sans lien, le voisin LLDP reste parfois affiché par le switch : ce n'est plus l'appareil branché.
  if (!p.up && name) { sub = [`dernier appareil vu : ${name}`, sub].filter(Boolean).join(' · '); name = ''; }
  const cab = pState(p) === 'down' ? cableOf(p.port) : null, unk = pState(p) === 'down' && !cab ? cableUnknown(p) : null;
  if (cab && (cab.kind !== 'empty' || sub)) name = { empty: 'Rien de branché', open: `Câble ${cab.len} m, rien au bout`, good: `Câble ${cab.len} m, appareil éteint`, partial: `Câble ${cab.len} m, paire ouverte`, fault: `Câble en défaut (~${cab.len} m)` }[cab.kind];
  if (unk) { name = 'Câble à vérifier'; sub = [unkText(p, unk), sub].filter(Boolean).join(' · '); }
  const ip = withIp.length ? ips[withIp[0]].ip : '';
  for (const o of hook('portName', p, { name, sub, macs, lldp })) if (o) { if (o.name !== undefined) name = o.name; if (o.sub !== undefined) sub = o.sub; }
  return { name, sub: [sub, p.desc].filter(Boolean).join(' · '), ip, ipMore: Math.max(0, withIp.length - 1), mac: macs[0] || '', macMore: Math.max(0, macs.length - 1),
    text: [p.port, portNum(p.port), name, sub, p.desc, ...macs, ...withIp.map((m) => ips[m].ip), ...withIp.map((m) => ips[m].name || '')].join(' ').toLowerCase() };
}
function sortVal(p, info, key) {
  switch (key) {
    case 'port': return portNum(p.port);
    case 'state': return STATE_ORDER[pState(p)];
    case 'speed': return -(Number(p.speed) || 0);
    case 'vlan': return Number(p.vlan) || 0;
    case 'device': return info.name ? info.name.toLowerCase() : '￿';
    case 'ip': return ipNum(info.ip);
    case 'mac': return info.mac || '￿';
    case 'rx': return -(p.rx_bps || 0);
    case 'tx': return -(p.tx_bps || 0);
    case 'total': return -(p.rx_bytes || 0);
    case 'flaps': return -(DIAG?.ports[p.port]?.transitions ?? -1);
    case 'errs': return -((p.rx_errors || 0) + (p.tx_errors || 0) + (p.rx_drops || 0) + (p.tx_drops || 0));
  }
  return 0;
}
function renderPortHead() {
  setHTML($('#portHead'), PORT_COLS.map(([k, label, cls]) => {
    const on = portSort.key === k;
    return `<th data-sort="${k}" class="${cls || ''}" aria-sort="${on ? (portSort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-sort" title="Trier par ${label.toLowerCase()}">${label}${on ? icon(portSort.dir > 0 ? 'arrow_drop_up' : 'arrow_drop_down', { size: 16, cls: 'arrow' }) : ''}</button></th>`;
  }).join(''));
}
$('#portHead').addEventListener('click', (e) => {
  const th = e.target.closest('[data-sort]'); if (!th) return;
  portSort = portSort.key === th.dataset.sort ? { key: th.dataset.sort, dir: -portSort.dir } : { key: th.dataset.sort, dir: 1 };
  renderPorts();
});
$('#portSearch').addEventListener('input', (e) => { portQuery = e.target.value.trim().toLowerCase(); renderPorts(); });

function portRow(p, info) {
  const st = pState(p), errs = (p.rx_errors || 0) + (p.tx_errors || 0) + (p.rx_drops || 0) + (p.tx_drops || 0);
  const dash = '<span class="muted">-</span>';
  return `<tr class="click${selected === p.port ? ' sel' : ''}${stInfo(p).cls === 'down' && !info.mac ? ' is-free' : ''}" data-port="${esc(p.port)}">
    <td class="mono">${portNum(p.port)}</td>
    <td>${stpBlocked(p) ? '<span class="status blocked">Bloqué (STP)</span>' : `<span class="status ${stInfo(p).cls}">${stInfo(p).label}</span>`}${st === 'idle' ? ` <span class="muted">${fmtDur(quietFor(p))}</span>` : sinceText(p) ? ` <span class="muted">${sinceText(p)}</span>` : ''}</td>
    <td class="num">${p.speed ? `<span class="${isSlow(p) ? 'speed-slow' : ''}">${esc(p.speed)} Mb/s</span>` : (p.reason === 'No XCVR installed' ? '<span class="muted">pas de module</span>' : dash)}</td>
    <td class="num">${esc(p.vlan)}${p.mode === 'trunk' ? ' <span class="badge">trunk</span>' : ''}</td>
    <td class="dev">${info.name ? esc(info.name) : dash}${isUplink(p) ? ` <span class="badge">${icon('swap_vert', { size: 12 })}switch</span>` : ''}${info.sub ? `<span class="sub">${esc(info.sub)}</span>` : ''}</td>
    <td class="mono">${info.ip ? esc(info.ip) + (info.ipMore ? ` <span class="muted">+${info.ipMore}</span>` : '') : dash}</td>
    <td class="mono">${info.mac ? esc(info.mac) + (info.macMore ? ` <span class="muted">+${info.macMore}</span>` : '') : dash}</td>
    <td class="r num">${p.up ? fmtBps(p.rx_bps) : dash}</td>
    <td class="r num">${p.up ? fmtBps(p.tx_bps) : dash}</td>
    <td class="r num">${fmtBytes(p.rx_bytes)}</td>
    <td class="r num">${flapCell(p)}</td>
    <td class="r num">${errs ? `<span style="color:var(--warn)" title="erreurs ${nf0.format(Number(p.rx_errors || 0) + Number(p.tx_errors || 0))} · CRC ${nf0.format(Number(p.crc || 0))} · pertes ${nf0.format(Number(p.rx_drops || 0) + Number(p.tx_drops || 0))}">${nf0.format(errs)}</span>` : '<span class="muted">0</span>'}</td>
  </tr>`;
}
function renderPorts() {
  // Au clavier, le focus reste sur l'en-tête ou sur « ports libres » quand le tableau est redessiné.
  const had = document.activeElement?.closest?.('#portHead [data-sort], #portRows [data-free]');
  const back = had && (had.dataset.sort ? `#portHead [data-sort="${had.dataset.sort}"] button` : '#portRows [data-free] button');
  renderPortHead();
  const rows = (S.ports || []).map((p) => ({ p, info: portInfo(p) }));
  const hit = rows.filter((r) => !portQuery || r.info.text.includes(portQuery));
  hit.sort((x, y) => { const a = sortVal(x.p, x.info, portSort.key), b = sortVal(y.p, y.info, portSort.key);
    return (a < b ? -1 : a > b ? 1 : portNum(x.p.port) - portNum(y.p.port)) * (a === b ? 1 : portSort.dir); });
  // ports libres repliés, sauf pendant une recherche. Libre = sans lien ni appareil, et sans câble d'après
  // un test récent : les ports à vérifier et ceux avec un câble restent visibles.
  const isFree = (r) => pState(r.p) === 'down' && !r.info.mac && (r.p.type !== '1GbT' || cableOf(r.p.port)?.kind === 'empty');
  const main = portQuery || showFree ? hit : hit.filter((r) => !isFree(r));
  const free = hit.filter(isFree);
  let html = main.map((r) => portRow(r.p, r.info)).join('');
  if (!portQuery && free.length) html += `<tr class="free-toggle" data-free><td colspan="${PORT_COLS.length}"><button type="button" aria-expanded="${showFree}">${showFree ? `${icon('expand_less', { size: 15 })}Replier les ports libres` : `${icon('expand_more', { size: 15 })}${free.length} port${free.length > 1 ? 's' : ''} libre${free.length > 1 ? 's' : ''} · afficher`}</button></td></tr>`;
  if (!html) html = `<tr><td colspan="${PORT_COLS.length}" class="empty">Aucun résultat pour « ${esc(portQuery)} ».</td></tr>`;
  setHTML($('#portRows'), html);
  if (back && document.activeElement === document.body) $(back)?.focus();
  const used = rows.filter((r) => !isFree(r)).length;
  const toCheck = rows.filter((r) => stInfo(r.p).cls === 'unk').length;
  $('#portCount').textContent = portQuery ? `${hit.length} résultat${hit.length > 1 ? 's' : ''}` : `${used - toCheck} utilisés · ${rows.length - used} libres${toCheck ? ` · ${toCheck} à vérifier` : ''}`;
  // appareils vus sur le réseau mais pas branchés directement sur ce switch
  const onSwitch = new Set((S.macs || []).map((m) => m.mac));
  const elsewhere = Object.entries(S.ips || {}).filter(([mac, v]) => !onSwitch.has(mac) && v.ip !== S.mgmt_ip && v.ip !== DIAG?.ip?.replace(/\/\d+$/, '')).map(([, v]) => v.ip).sort((a, b) => ipNum(a) - ipNum(b));
  $('#ipNote').textContent = S.agent?.scan
    ? `IP trouvées par l’agent sur ${S.agent.scan} (toutes les 5 min).${elsewhere.length ? ` Vus sur le réseau mais pas branchés directement ici : ${elsewhere.join(', ')}.` : ''}`
    : 'Les IP s’afficheront quand l’agent tournera sur un PC du même réseau (le switch, lui, ne voit que les adresses MAC).';
}
onPick($('#portRows'));
$('#portRows').addEventListener('click', (e) => { if (e.target.closest('[data-free]')) { showFree = !showFree; renderPorts(); } });

// ---------------------------------------------------------------- VLANs
function parsePorts(txt) {
  const out = new Set();
  for (const part of String(txt).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(?:1\/1\/)?(\d{1,2})(?:-(?:1\/1\/)?(\d{1,2}))?$/);
    if (!m) throw new Error(`« ${part} » n’est pas un port valide.`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    if (a < 1 || b > 28 || b < a) throw new Error(`Plage « ${part} » invalide (ports 1 à 28).`);
    for (let n = a; n <= b; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}
function ranges(nums) {
  const r = []; let s = null, p = null;
  for (const n of nums) { if (s === null) s = p = n; else if (n === p + 1) p = n; else { r.push([s, p]); s = p = n; } }
  if (s !== null) r.push([s, p]);
  return r.map(([a, b]) => (a === b ? `1/1/${a}` : `1/1/${a}-1/1/${b}`));
}
// Une ligne « interface » par port : l'invite des plages (config-if-<1/1/3-1/1/8>) n'est pas reconnue par l'agent 1.0.0.
function vlanAssignCmd(nums, vid) {
  return ['configure terminal', ...nums.flatMap((n) => [`interface 1/1/${n}`, `vlan access ${vid}`, 'exit']), 'end'].join('\n');
}
const ICON_EDIT = icon('edit'), ICON_TRASH = icon('delete'); // boutons « Renommer », « Modifier », « Supprimer » (aussi profiles.js, schedule.js)
function renderVlans() {
  const v = S.vlans || [];
  $('#vlanCount').textContent = `${v.length}`;
  setHTML($('#vlanList'), v.map((x) => {
    const ports = (S.ports || []).filter((p) => p.vlan === String(x.id) && p.mode === 'access').map((p) => portNum(p.port));
    const set = new Set(ports);
    let mini = '';
    for (let n = 1; n <= 28; n++) mini += `<i class="${set.has(n) ? 'on' : ''}${n === 25 ? ' gap' : ''}" title="Port ${n}${set.has(n) ? ` · VLAN ${esc(x.id)}` : ''}"></i>`;
    return `<div class="vlan-item">
      <div class="vlan-top"><span class="vid">${esc(x.id)}</span><b>${esc(x.name)}</b><span class="status ${x.up ? 'up' : 'down'}">${x.up ? 'Actif' : 'Inactif'}</span><span class="grow"></span>
        ${x.id === 1 ? '<span class="note">par défaut</span>' : `<button class="btn icon admin-only manage-only" data-vren="${esc(x.id)}" title="Renommer" aria-label="Renommer le VLAN ${esc(x.id)}">${ICON_EDIT}</button><button class="btn icon danger admin-only manage-only" data-vdel="${esc(x.id)}" title="Supprimer" aria-label="Supprimer le VLAN ${esc(x.id)}">${ICON_TRASH}</button>`}</div>
      <div class="vlan-ports"><span class="mini" aria-hidden="true">${mini}</span><span class="note">${ports.length ? `${ports.length} port${ports.length > 1 ? 's' : ''} · ${esc(ranges(ports).map((r) => r.replace(/1\/1\//g, '')).join(', '))}` : 'aucun port'}</span></div>
    </div>`;
  }).join(''));
  const sel = $('#vlanTarget'), cur = sel.value;
  const opts = v.map((x) => `<option value="${esc(x.id)}">VLAN ${esc(x.id)} · ${esc(x.name)}</option>`).join('');
  if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; if (cur && v.some((x) => String(x.id) === cur)) sel.value = cur; }
}
$('#vlanList').addEventListener('click', (e) => {
  const ren = e.target.closest('[data-vren]'), del = e.target.closest('[data-vdel]');
  if (ren) openVlanDialog(Number(ren.dataset.vren));
  if (del) {
    const id = Number(del.dataset.vdel);
    const ports = (S.ports || []).filter((p) => p.vlan === String(id) && p.mode === 'access').map((p) => portNum(p.port));
    const cmd = ports.length ? vlanAssignCmd(ports, 1).replace(/\nend$/, `\nno vlan ${id}\nend`) : `configure terminal\nno vlan ${id}\nend`;
    confirmCmd(`Supprimer le VLAN ${id} ?`, ports.length ? `Les ports ${ports.join(', ')} seront d’abord remis dans le VLAN 1.` : 'Aucun port n’utilise ce VLAN.', cmd, `Suppression VLAN ${id}`, { ports: ports.map((n) => `1/1/${n}`) });
  }
});
$('#vlanAssignOpen').addEventListener('click', () => { if (!canAdmin()) return; $('#vlanAssignDialog').showModal(); $('#vlanPorts').focus(); });
$('#vaNo').addEventListener('click', () => $('#vlanAssignDialog').close());
let vlanEdit = null;
function openVlanDialog(id) {
  vlanEdit = id || null;
  $('#vdTitle').textContent = id ? `Renommer le VLAN ${id}` : 'Nouveau VLAN';
  $('#vdId').value = id || ''; $('#vdId').disabled = Boolean(id);
  $('#vdName').value = id ? (S.vlans.find((v) => v.id === id)?.name || '') : '';
  $('#vdErr').textContent = ''; $('#vlanDialog').showModal(); (id ? $('#vdName') : $('#vdId')).focus();
}
$('#vlanNew').addEventListener('click', () => canAdmin() && openVlanDialog());
$('#vdNo').addEventListener('click', () => $('#vlanDialog').close());
$('#vdYes').addEventListener('click', () => {
  const id = Number($('#vdId').value), name = $('#vdName').value.trim().replace(/\s+/g, '_');
  if (!(id >= 2 && id <= 4094)) return ($('#vdErr').textContent = 'Numéro entre 2 et 4094.');
  if (!vlanEdit && (S.vlans || []).some((v) => v.id === id)) return ($('#vdErr').textContent = `Le VLAN ${id} existe déjà.`);
  if (name && !/^[\w.-]{1,32}$/.test(name)) return ($('#vdErr').textContent = 'Nom : lettres, chiffres, - _ . (32 max).');
  $('#vlanDialog').close();
  confirmCmd(vlanEdit ? `Renommer le VLAN ${id}` : `Créer le VLAN ${id}`, '', `configure terminal\nvlan ${id}\n${name ? `name ${name}` : 'no name'}\nend`, vlanEdit ? `VLAN ${id} renommé` : `VLAN ${id} créé`);
});
$('#vlanAssign').addEventListener('click', () => {
  let nums; try { nums = parsePorts($('#vlanPorts').value); } catch (e) { return toast(e.message, { type: 'error' }); }
  if (!nums.length) return toast('Indique au moins un port, ex. 3-8, 12', { type: 'warn' });
  const vid = Number($('#vlanTarget').value);
  $('#vlanAssignDialog').close();
  const uplinks = nums.filter((n) => { const p = S.ports.find((x) => portNum(x.port) === n); return p && isUplink(p); });
  confirmCmd(`Mettre ${nums.length} port(s) dans le VLAN ${vid} ?`,
    uplinks.length ? { warn: `Les ports ${uplinks.join(', ')} relient d’autres switches : les changer peut couper le réseau.` } : 'Les appareils branchés changeront de réseau (ils devront parfois renouveler leur IP).',
    vlanAssignCmd(nums, vid), `Ports ${nums.join(', ')} dans le VLAN ${vid}`, { ports: nums.map((n) => `1/1/${n}`) });
});

// ---------------------------------------------------------------- tiroir du port
const CABLE_FR = { good: 'bon', open: 'circuit ouvert', intra_short: 'court-circuit (même paire)', inter_short: 'court-circuit (entre paires)', high_imp: 'impédance trop haute', low_imp: 'impédance trop basse', unknown: 'indéterminé' };
function parseCable(out) {
  const rows = [];
  for (const m of String(out || '').matchAll(/(\d-\d)\s+(good|open|intra_short|inter_short|high_imp|low_imp|unknown)\s+(\S+)\s+((?:[\d.]+\s*\+\/-\s*[\d.]+)|--|\S+)/g)) rows.push({ pair: m[1], status: m[2], imp: m[3], dist: m[4] });
  return rows;
}
// Résume un test de câble : vide, câble sans rien au bout, câble bon (appareil éteint), ou défaut.
function cableKind(rows) {
  if (!rows?.length) return null;
  const dist = rows.map((r) => parseFloat(r.dist)).filter((x) => !isNaN(x));
  const len = dist.length ? Math.round(Math.max(...dist)) : null;
  const bad = rows.filter((r) => r.status !== 'good');
  if (bad.every((r) => r.status === 'open') && bad.length === rows.length) return { kind: len !== null && len <= 2 ? 'empty' : 'open', len };
  if (bad.length && bad.every((r) => r.status === 'open')) return { kind: 'partial', len, open: bad.map((r) => r.pair) };
  return { kind: bad.length ? 'fault' : 'good', len };
}
// Un test devient périmé si le port a changé d'état (branché, débranché) plus d'une minute après lui.
// La minute de marge couvre la coupure provoquée par le test lui-même.
function cableStale(port, t) {
  const last = DIAG?.ports?.[port]?.last;
  return Boolean(last && t && last > t + 60);
}
const CABLE_MAX_AGE = 7 * 86400;
function cableOf(port) {
  const c = S?.cables?.[port];
  return c?.rows?.length && NOW - c.t < CABLE_MAX_AGE && !cableStale(port, c.t) ? { ...c, ...cableKind(c.rows) } : null;
}
// Port sans lien sans test valable : impossible de dire s'il est libre. Renvoie la raison, ou null.
function cableUnknown(p) {
  if (pState(p) !== 'down' || p.type !== '1GbT' || cableOf(p.port)) return null;
  const c = S?.cables?.[p.port];
  if (!c?.rows?.length) return { why: 'never' };
  return { why: cableStale(p.port, c.t) ? 'stale' : 'old', prev: { ...c, ...cableKind(c.rows) } };
}
const CABLE_TXT = { empty: 'rien de branché', open: 'câble ~{len} m', good: 'câble ~{len} m', partial: 'câble ~{len} m', fault: 'câble en défaut' };
function unkText(p, u) {
  const when = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const prev = u.prev && CABLE_TXT[u.prev.kind].replace('{len}', u.prev.len ?? '?');
  const txt = u.why === 'never' ? 'jamais testé'
    : u.why === 'stale' ? `${prev} au test du ${when(u.prev.t)}, mais le port a changé d’état depuis`
    : `dernier test trop ancien (${when(u.prev.t)})`;
  return txt + (pendingFor(p.port) ? ' · vérification en cours' : SETTINGS?.autoCable !== false ? ' · vérification automatique' : '');
}

// Vérification automatique des câbles, par petits lots, quand le dashboard est ouvert :
// d'abord les ports sans test valable (jamais testés, branchés ou débranchés depuis), puis une revérification
// toutes les 2 h des autres (un câble branché sans rien au bout ne provoque aucun événement sur le switch).
// Sans risque : ces ports n'ont pas de lien, le test ne coupe rien. Désactivable dans les réglages.
const CABLE_RECHECK = 2 * 3600, CABLE_RETRY = 600, CABLE_BATCH = 4;
let cableAsked = 0;
function cablePorts(c) { // ports testés par une commande
  return [...String(c.cmd || '').matchAll(/^diag cable-diagnostic test (\S+)$/gm)].map((m) => m[1]);
}
async function maybeCableCheck() {
  if (!S || !DIAG || !SETTINGS || SETTINGS.autoCable === false || $('#app').hidden || document.hidden) return;
  if (NOW - (S.received || 0) > 90 || NOW - DIAG.t > 900) return; // agent muet ou relevé trop ancien pour juger
  // jamais devant une commande de l'utilisateur, et un seul lot à la fois
  if (LOG.some((c) => ['pending', 'running', 'confirm'].includes(c.status) && (!isAuto(c) || c.kind === 'auto:cable'))) return;
  if (Date.now() / 1000 - cableAsked < 60) return;
  // lots ratés à la suite (switch injoignable…) : attente croissante avant le suivant, comme les relevés (1 à 15 min)
  const fails = autoFails('auto:cable', (c) => c.status === 'done');
  if (fails.length && NOW < (fails[0].finished || fails[0].created) + retryWait(fails.length)) return;
  const tried = {}; // dernier test lancé sur chaque port, toutes pages confondues (le journal est partagé)
  for (const c of LOG) for (const port of cablePorts(c)) tried[port] = Math.max(tried[port] || 0, c.created);
  const todo = (S.ports || []).filter((p) => pState(p) === 'down' && p.type === '1GbT' && !isUplink(p) && !ADMIN.portGuard?.(p))
    .map((p) => ({ port: p.port, unk: Boolean(cableUnknown(p)), age: S.cables?.[p.port]?.t ? NOW - S.cables[p.port].t : Infinity }))
    .filter((x) => (x.unk || x.age > CABLE_RECHECK) && NOW - (tried[x.port] || 0) > CABLE_RETRY)
    .sort((a, b) => b.unk - a.unk || b.age - a.age)
    .slice(0, CABLE_BATCH).map((x) => x.port);
  if (!todo.length) return;
  cableAsked = Date.now() / 1000;
  const cmd = ['diagnostics', ...todo.flatMap((p) => [`diag cable-diagnostic test ${p}`, 'y', `diag cable-diagnostic show ${p}`])].join('\n');
  try { await api('/api/command', { cmd, label: `Vérification des câbles (ports ${todo.map(portNum).join(', ')})`, kind: 'auto:cable' }); setTimeout(poll, 800); } catch {}
}
function cableVerdict(rows, p) {
  if (!rows.length) return null;
  const k = cableKind(rows);
  if (k.kind === 'empty') return ['green', 'Aucun câble branché sur ce port.'];
  if (k.kind === 'good' && !p.up) return ['amber', `Câble en bon état (environ ${k.len} m) mais pas de lien : l’appareil au bout est éteint, en veille profonde ou sa carte réseau est désactivée.`];
  const bad = rows.filter((r) => r.status !== 'good');
  const dist = rows.map((r) => parseFloat(r.dist)).filter((x) => !isNaN(x));
  const len = dist.length ? Math.round(Math.max(...dist)) : null;
  if (!bad.length) return ['green', `Câble en bon état${len ? ` · environ ${len} m` : ''}.`];
  if (bad.every((r) => r.status === 'open') && bad.length === rows.length) return ['amber', `Câble d’environ ${len ?? '?'} m branché, mais rien au bout : prise murale vide, appareil débranché, ou brassage manquant.`];
  if (k.kind === 'partial') return ['amber', `Paire${bad.length > 1 ? 's' : ''} ${bad.map((r) => `${r.pair} ouverte à ${r.dist} m`).join(', ')}, les autres sont bonnes (environ ${len} m). Normal si l’appareil est en 10/100 Mb/s (il n’utilise que 2 paires). Sinon, un fil est coupé : refais la prise ou change le câble, sans quoi le lien ne montera pas à 1 Gb/s.`];
  return ['red', `Défaut détecté : ${bad.map((r) => `${r.pair} ${CABLE_FR[r.status]} à ${r.dist} m`).join(', ')}.`];
}
const RXTX = `${icon('arrow_downward', { size: 14, label: 'entrant' })} / ${icon('arrow_upward', { size: 14, label: 'sortant' })}`; // en-têtes « entrant / sortant » du volet
function renderPanel(force) {
  const p = (S?.ports || []).find((x) => x.port === selected);
  if (!p || $('#portPanel').hidden) return;
  if (!force && $('#portPanel').contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  const n = portNum(p.port), st = pState(p), uplink = isUplink(p);
  const lldp = (S.lldp || []).filter((l) => l.port === p.port);
  const macs = (S.macs || []).filter((m) => m.port === p.port), ips = S.ips || {};
  const cableRun = LOG.find((c) => c.kind === `cable:${p.port}` || (['cablescan', 'auto:cable'].includes(c.kind) && (c.ports || []).includes(p.port)));
  const stored = S.cables?.[p.port];
  const runT = cableRun && (cableRun.finished || cableRun.created);
  const staleT = stored?.rows?.length ? (cableStale(p.port, stored.t) ? stored.t : null) : (runT && cableStale(p.port, runT) ? runT : null);
  const cableRows = staleT ? [] : stored?.rows?.length ? stored.rows : (cableRun && cableRun.status === 'done' ? parseCable(OUT[cableRun.id]) : []);
  const fmtHM = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const autoNote = SETTINGS?.autoCable !== false && st === 'down' && !uplink ? ' La vérification automatique va le refaire dans quelques instants.' : ' Relance le test pour un résultat à jour.';
  const unk = cableUnknown(p);
  const staleNote = staleT ? `<div class="alert amber" style="margin:0">Le dernier test (${fmtHM(staleT)}) date d’avant le dernier changement du port (${fmtHM(DIAG.ports[p.port].last)}) : il n’est plus valable${st === 'down' ? ', on ne sait pas si un câble est branché' : ''}.${st === 'down' ? autoNote : ''}</div>`
    : unk?.why === 'never' && !cableRows.length ? `<div class="alert amber" style="margin:0">Ce port n’a jamais été testé : sans lien, impossible de savoir s’il y a un câble.${autoNote}</div>`
    : unk?.why === 'old' ? `<div class="alert amber" style="margin:0">Le dernier test (${fmtHM(unk.prev.t)}) est trop ancien pour être fiable.${autoNote}</div>` : '';
  const verdict = cableVerdict(cableRows, p);
  const alerts = [
    st === 'idle' && `<div class="alert amber"><b>Câble branché mais aucun paquet reçu depuis ${fmtDur(quietFor(p))}.</b><br>L’appareil est sans doute éteint ou en veille, sa carte réseau est désactivée, ou le câble ne mène nulle part.</div>`,
    stpBlocked(p) && `<div class="alert red"><b>Port bloqué par le spanning-tree.</b><br>Le switch coupe ce port pour éviter une boucle réseau : deux câbles relient probablement les mêmes équipements. Vérifie le câblage.</div>`,
    (DIAG?.flaps?.[p.port] || 0) >= 4 && `<div class="alert amber"><b>Port instable : ${DIAG.flaps[p.port]} coupures en quelques minutes.</b><br>Câble ou prise défectueux, ou appareil qui redémarre en boucle.</div>`,
    isSlow(p) && `<div class="alert amber"><b>Lien négocié à ${esc(p.speed)} Mb/s au lieu de 1000.</b><br>Souvent, le PC est simplement en veille (sa carte réseau descend à 10 ou 100 Mb/s). S’il est allumé : câble abîmé, prise murale ou carte réseau ancienne. Lance un test de câble ci-dessous.</div>`,
  ].filter(Boolean).join('');
  setHTML($('#ppTitle'), `Port ${n} <span class="status ${stInfo(p).cls}" style="font-size:12px">${stInfo(p).label}</span>`);
  if (!$('#ppInfo')) $('#ppBody').innerHTML = '<div id="ppInfo"></div><div id="ppActions"></div><div id="ppExt"></div>';
  setHTML($('#ppInfo'), `${alerts}
    <dl>
      <dt>Interface</dt><dd class="mono">${esc(p.port)}</dd>
      <dt>Type</dt><dd>${esc(p.type === '--' ? 'SFP (vide)' : p.type)}</dd>
      <dt>VLAN</dt><dd>${esc(p.vlan)} <span class="muted">(${esc(p.mode)})</span></dd>
      <dt>Vitesse</dt><dd class="num">${p.speed ? esc(p.speed) + ' Mb/s' : '-'}</dd>
      <dt>État détaillé</dt><dd>${esc(p.reason || (p.up ? 'Lien établi' : '-'))}</dd>
      <dt>Dernier changement</dt><dd>${DIAG?.ports[p.port]?.last ? `${esc(sinceText(p).replace(/^depuis /, 'il y a '))} <span class="muted">(${new Date(DIAG.ports[p.port].last * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})</span>` : '-'}</dd>
      <dt>Coupures</dt><dd>${flapCell(p, true)}</dd>
      <dt>Spanning-tree</dt><dd>${DIAG?.ports[p.port]?.stp ? `${esc(STP_FR[DIAG.ports[p.port].stp.role] || DIAG.ports[p.port].stp.role)} · ${esc(STP_FR[DIAG.ports[p.port].stp.state] || DIAG.ports[p.port].stp.state)}` : '-'}</dd>
      <dt>Débit ${RXTX}</dt><dd class="num">${fmtBps(p.rx_bps)} / ${fmtBps(p.tx_bps)}</dd>
      <dt>Charge du lien ${RXTX}</dt><dd class="num">${fmtPct(loadPct(p.rx_bps, p))} / ${fmtPct(loadPct(p.tx_bps, p))}</dd>
      <dt>Total ${RXTX}</dt><dd class="num">${fmtBytes(p.rx_bytes)} / ${fmtBytes(p.tx_bytes)}</dd>
      <dt>Erreurs · CRC</dt><dd class="num">${nf0.format((p.rx_errors || 0) + (p.tx_errors || 0))} · ${nf0.format(p.crc || 0)}</dd>
      <dt>Pertes ${RXTX}</dt><dd class="num">${nf0.format(p.rx_drops || 0)} / ${nf0.format(p.tx_drops || 0)}</dd>
      <dt>Appareils</dt><dd>${macs.length ? macs.map((m) => `<span class="mono">${esc(m.mac)}</span>${ips[m.mac] ? ` · <b class="mono">${esc(ips[m.mac].ip)}</b>${ips[m.mac].name ? ` (${esc(ips[m.mac].name)})` : ''}` : ''}`).join('<br>') : '-'}</dd>
      ${lldp.length ? `<dt>${p.up ? 'LLDP' : 'Dernier vu (LLDP)'}</dt><dd>${lldp.map((l) => esc(l.name || l.chassis)).join('<br>')}</dd>` : ''}
    </dl>
    <button class="btn small" id="ppHist">Voir l’historique de ce port</button>`);
  const techUplink = ROLE === 'tech' && uplink;
  const admin = canOperate() && !techUplink;
  setHTML($('#ppActions'), `${ROLE === 'viewer' ? '<p class="note">Lecture seule : aucune action possible sur le switch.</p>' : ''}
    ${techUplink && !MONITOR ? '<p class="note">Ce port relie un autre switch : seul un administrateur peut agir dessus.</p>' : ''}
    ${admin ? `<div class="section">
      <h3>Actions</h3>
      ${uplink ? '<div class="alert amber" style="margin:0">Ce port relie un autre switch. Le couper ou le changer de VLAN coupe tout ce qui passe par ce lien.</div>' : ''}
      <div class="row">
        ${p.enabled ? `<button class="btn danger" data-act="shut">Désactiver</button>` : `<button class="btn primary" data-act="noshut">Activer</button>`}
        <button class="btn" data-act="bounce" ${p.enabled ? '' : 'disabled'} title="Coupe puis réactive le port">Redémarrer</button>
      </div>
      <div class="field" style="margin:0"><label for="ppDesc">Description</label>
        <div class="row"><input id="ppDesc" type="text" maxlength="64" value="${esc(p.desc)}" placeholder="ex. PC accueil"><button class="btn" data-act="desc">Enregistrer</button></div></div>
      <div class="field" style="margin:0"><label for="ppVlan">VLAN (mode access)</label>
        <div class="row"><select id="ppVlan">${(S.vlans || []).map((v) => `<option value="${esc(v.id)}" ${String(v.id) === p.vlan ? 'selected' : ''}>VLAN ${esc(v.id)} · ${esc(v.name)}</option>`).join('')}</select><button class="btn" data-act="vlan">Appliquer</button></div></div>
    </div>` : ''}
    <div class="section">
      <h3>Test du câble</h3>
      ${admin ? `<p class="note" style="margin:0">Mesure chaque paire du câble (longueur, coupure, court-circuit). Le port est coupé pendant 5 à 10 secondes.</p>` : ''}
      ${cableRun && ['pending', 'running', 'confirm'].includes(cableRun.status) ? '<div class="alert amber" style="margin:0"><span class="spinner"></span> Test en cours…</div>' : ''}
      ${verdict ? `<div class="alert ${verdict[0]}" style="margin:0">${esc(verdict[1])}</div>
        <table class="cable"><thead><tr><th>Paire</th><th>État</th><th>Impédance</th><th>Distance</th></tr></thead><tbody>
        ${cableRows.map((r) => `<tr><td class="mono">${esc(r.pair)}</td><td>${esc(CABLE_FR[r.status] || r.status)}</td><td class="mono">${esc(r.imp)} Ω</td><td class="mono">${esc(r.dist)} m</td></tr>`).join('')}</tbody></table>
        <span class="note">Test du ${new Date((stored?.t || cableRun?.finished || cableRun?.created) * 1000).toLocaleString('fr-FR')}</span>` : ''}
      ${staleNote}
      ${cableRun && cableRun.status === 'error' && !staleT ? '<div class="alert red" style="margin:0">Le test a échoué. Détail dans la console.</div>' : ''}
      ${cableRun && cableRun.status === 'done' && OUT[cableRun.id] !== undefined && !cableRows.length && !staleT ? '<div class="alert amber" style="margin:0">Le switch n’a pas encore donné de résultat. Relance le test dans quelques secondes.</div>' : ''}
      ${admin ? `<button class="btn" data-act="cable" ${p.type !== '1GbT' ? 'disabled title="Test impossible sur un port SFP"' : ''}>Tester le câble</button>`
        : !verdict && !staleNote ? '<p class="note" style="margin:0">Aucun test de câble pour ce port.</p>' : ''}
    </div>
    ${admin ? '<p class="note">Les changements s’appliquent tout de suite. Pense à « Sauvegarder la config » pour qu’ils survivent à un redémarrage.</p>' : ''}`);
  enhanceSelects($('#ppActions'));
  const ext = $('#ppExt'), parts = hook('panel', p);
  while (ext.children.length < parts.length) ext.appendChild(document.createElement('div'));
  parts.forEach((h, i) => setHTML(ext.children[i], h || ''));
  enhanceSelects(ext);
}
// Ne touche au DOM que si le contenu a changé (évite de perdre un clic pendant le rafraîchissement).
function setHTML(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
$('#ppBody').addEventListener('click', (e) => {
  if (e.target.id === 'ppHist') { $('#chartPort').value = selected; ddSyncAll(); if (chartRange === '1h') setRange('24h'); else loadChart(); $('#chart').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const p = S.ports.find((x) => x.port === selected), n = portNum(p.port), base = `configure terminal\ninterface ${p.port}\n`, opt = { ports: [p.port] };
  const warn = isUplink(p) ? { warn: 'Ce port relie un autre switch : tout ce qui passe par lui sera coupé.' } : '';
  if (b.dataset.act === 'shut') confirmCmd(`Désactiver le port ${n} ?`, [warn, 'L’appareil branché perdra le réseau.'], base + 'shutdown\nend', `Port ${n} désactivé`, opt);
  if (b.dataset.act === 'noshut') confirmCmd(`Activer le port ${n} ?`, '', base + 'no shutdown\nend', `Port ${n} activé`, opt);
  if (b.dataset.act === 'bounce') confirmCmd(`Redémarrer le port ${n} ?`, [warn, 'Coupure d’environ 3 secondes.'], base + 'shutdown\nno shutdown\nend', `Port ${n} redémarré`, opt);
  if (b.dataset.act === 'desc') {
    const d = $('#ppDesc').value.trim().replace(/[\r\n]/g, ' ');
    confirmCmd(`Description du port ${n}`, '', base + (d ? `description ${d}` : 'no description') + '\nend', `Description port ${n}`, opt);
  }
  if (b.dataset.act === 'vlan') { const vid = $('#ppVlan').value; confirmCmd(`Mettre le port ${n} dans le VLAN ${vid} ?`, [warn, 'L’appareil branché changera de réseau.'], base + `vlan access ${vid}\nend`, `Port ${n} dans le VLAN ${vid}`, opt); }
  if (b.dataset.act === 'cable') confirmCmd(`Tester le câble du port ${n} ?`, [warn, 'Le port sera coupé 5 à 10 secondes pendant la mesure.'],
    `diagnostics\ndiag cable-diagnostic test ${p.port}\ny\ndiag cable-diagnostic show ${p.port}`, `Test câble port ${n}`, { ...opt, kind: `cable:${p.port}` });
});

// ================================================================ commandes
let pendingConfirm = null;
function dangerStage(on) {
  $('#cfDanger').hidden = !on;
  $('#cfYes').textContent = on ? 'Exécuter quand même' : 'Envoyer au switch';
  $('#cfYes').classList.toggle('dangerous', on); $('#cfYes').classList.toggle('primary', !on);
  $('#cfWord').value = '';
  $('#cfYes').dataset.lock = on ? '1' : '';
  $('#cfYes').disabled = on;
}
// Texte d'une confirmation : une chaîne, ou une liste de morceaux (chaînes, et { warn: '…' } précédé de l'icône
// « warning »). Tout est échappé ; les morceaux vides sont ignorés.
const richText = (t) => (Array.isArray(t) ? t : [t]).filter(Boolean)
  .map((x) => (typeof x === 'object' ? `${icon('warning', { size: 15, label: 'Attention', cls: 'ic-warn' })} ${esc(x.warn)}` : esc(x))).join(' ');
function confirmCmd(title, text, cmd, label, opts = {}) {
  if (!canOperate()) return toast(ROLE === 'viewer' ? 'Lecture seule' : 'Vue monitoring', { type: 'warn', sub: ROLE === 'viewer' ? 'Ce compte ne peut rien modifier.' : 'Repasse en vue normale pour agir sur le switch.' });
  $('#cfTitle').textContent = title; $('#cfText').innerHTML = richText(text); $('#cfCmd').textContent = cmd;
  pendingConfirm = { cmd, label, ...opts }; dangerStage(false);
  if (!$('#confirm').open) $('#confirm').showModal();
}
// Seconde étape : le serveur a refusé une commande sensible et demande une confirmation explicite.
function openDanger(cmd, label, opts, info, expired) {
  if (!$('#confirm').open) confirmCmd('Commande sensible', '', cmd, label, opts);
  pendingConfirm = { cmd, label, ...opts, danger_token: info.token };
  $('#cfTitle').textContent = 'Seconde confirmation';
  $('#cfReasons').innerHTML = arr(info.reasons).map((r) => `<li>${esc(r)}</li>`).join('');
  dangerStage(true);
  if (expired) toast('Délai de confirmation dépassé', { type: 'warn', sub: 'Tape à nouveau CONFIRMER.' });
  setTimeout(() => $('#cfWord').focus(), 50);
}
$('#cfWord').addEventListener('input', () => {
  const ok = $('#cfWord').value.trim().toUpperCase() === 'CONFIRMER';
  $('#cfYes').dataset.lock = ok ? '' : '1'; $('#cfYes').disabled = !ok;
});
$('#cfWord').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#cfYes').disabled) { e.preventDefault(); $('#cfYes').click(); } });
$('#cfNo').addEventListener('click', () => $('#confirm').close());
$('#cfYes').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  if (!pendingConfirm) return;
  const p = pendingConfirm;
  const extra = p.danger_token ? { danger_token: p.danger_token, confirm: 'CONFIRMER' } : {};
  const r = await send(p.cmd, p.label, { ...p, ...extra }).catch(() => null);
  if (r?.danger) return; // la fenêtre reste ouverte sur la seconde étape
  $('#confirm').close();
}));

async function send(cmd, label = '', opts = {}) {
  const tid = toast(label || cmd.split('\n')[0], { sub: 'Envoi au dashboard…', spinner: true, timeout: 0 });
  try {
    let rec;
    try {
      rec = await api('/api/command', { cmd, label, kind: opts.kind || '', danger_token: opts.danger_token, confirm: opts.confirm });
    } catch (e) {
      if (e.status === 409 && e.data?.danger) { dropToast(tid); openDanger(cmd, label, opts, e.data, Boolean(opts.danger_token)); return { danger: true }; }
      throw e;
    }
    rec.ports = opts.ports || [];
    dropToast(tid);
    toast(label || cmd.split('\n')[0], { id: rec.id, sub: 'En attente de l’agent…', spinner: true, timeout: 0 });
    SEEN[rec.id] = 'pending';
    LOG = [rec, ...LOG.filter((c) => c.id !== rec.id)];
    PORTS_OF[rec.id] = rec.ports;
    renderTerm(true); if (S) { renderFaceplate(); renderPanel(); }
    lastTouch = 0; setTimeout(poll, 600);
    return rec;
  } catch (e) {
    if (e.message !== '401') toast('Échec de l’envoi', { id: tid, type: 'error', sub: e.message, timeout: 8000 });
    throw e;
  }
}
const PORTS_OF = {};
const _track = trackCommands;
trackCommands = (log) => { for (const c of log) c.ports = PORTS_OF[c.id] || (c.ports?.length ? c.ports : cablePorts(c)); _track(log); };

const answer = (id, a, btn) => busy(btn, async () => {
  try {
    await api('/api/command', { answer_to: id, answer: a });
    toast(a === 'y' ? 'Confirmation envoyée' : 'Refus envoyé', { id, sub: 'Le switch continue…', spinner: true, timeout: 0 });
    SEEN[id] = 'running'; lastTouch = 0; setTimeout(poll, 500);
    // les boutons vont disparaître : le focus reste dans la console (sa sortie), au lieu de repartir du haut de la page
    const t = TERMS.find((x) => x.log.contains(btn)), f = document.activeElement;
    if (t && (f === btn || f === document.body || !f)) t.log.focus({ preventScroll: true });
  } catch (e) { if (e.message !== '401') toast('Échec', { type: 'error', sub: e.message }); }
});
// Boutons Oui / Non d'une question du switch (notification et console) : un seul écouteur, pas de code dans le HTML.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-answer]');
  if (b) answer(b.dataset.answerId, b.dataset.answer, b);
});

// ---------------------------------------------------------------- consoles
// Deux consoles, mêmes données (LOG, OUT) et même envoi : la carte du tableau de bord et la page Console (#console,
// administrateur). La page peut en plus montrer les relevés automatiques, copier une sortie et vider son affichage
// (sur cette page seulement : rien n'est effacé du journal des commandes).
const CONFIG_RE = /^(conf|configure|write|copy|erase|reload|boot|no |interface|vlan|shutdown|diag|user |aaa|ssh |https-server|spanning-tree|checkpoint|zeroize|ip |lag|vrf)/im;
const TERMS = [
  { log: $('#termLog'), form: $('#termForm'), input: $('#termInput'), btn: $('#termSend'), chips: $('#chips'), max: 140 },
  { log: $('#conLog'), form: $('#conForm'), input: $('#conInput'), btn: $('#conSend'), chips: $('#conChips'), max: 220, page: true },
];
const CON = TERMS[1];
let conAuto = false; // page : relevés automatiques affichés (mémorisé dans ce navigateur)
try { conAuto = localStorage.getItem('aruba-console-auto') === '1'; } catch {}
$('#conAuto').checked = conAuto;
const conHidden = new Set(); // page : commandes retirées de l'affichage par « Vider l'affichage »
const TYPED = []; // commandes tapées dans les deux consoles, la plus récente à la fin
const autoGrow = (t) => { t.input.style.height = 'auto'; t.input.style.height = Math.min(t.max, t.input.scrollHeight) + 'px'; };
function submitTerm(t) {
  const cmd = t.input.value.trim(); if (!cmd) return;
  if (TYPED.at(-1) !== cmd) { TYPED.push(cmd); if (TYPED.length > 50) TYPED.shift(); }
  t.at = -1;
  if (CONFIG_RE.test(cmd)) confirmCmd('Commande de configuration', 'Cette commande modifie le switch.', cmd, '');
  else busy(t.btn, () => send(cmd).catch(() => {}));
  t.input.value = ''; autoGrow(t);
}
// Flèches haut et bas : commandes tapées plus tôt, quand le champ est vide, le curseur au tout début, ou la commande
// rappelée pas encore modifiée. Après la plus récente, la saisie en cours revient.
function browseTyped(t, e) {
  const el = t.input, up = e.key === 'ArrowUp';
  const free = !el.value || (el.selectionStart === 0 && el.selectionEnd === 0) || (t.at >= 0 && el.value === TYPED[t.at]);
  if (!free || !TYPED.length || (!up && !(t.at >= 0))) return;
  e.preventDefault();
  if (up) {
    if (!(t.at >= 0)) { t.draft = el.value; t.at = TYPED.length; }
    t.at = Math.max(0, t.at - 1); el.value = TYPED[t.at];
  } else if (++t.at >= TYPED.length) { t.at = -1; el.value = t.draft || ''; }
  else el.value = TYPED[t.at];
  autoGrow(t);
  el.setSelectionRange(el.value.length, el.value.length);
}
// Déconnexion (showLogin) : historique des commandes tapées, saisies en cours et affichage vidé sont oubliés : le compte
// suivant, dans le même onglet, ne les retrouve pas.
function forgetTyped() {
  TYPED.length = 0; conHidden.clear();
  for (const t of TERMS) { t.at = -1; t.draft = ''; t.input.value = ''; t.input.style.height = ''; t.key = null; }
}

const CHIPS = [['show interface brief'], ['show mac-address-table'], ['show lldp neighbor-info'], ['show vlan'], ['show running-config'], ['show logging -r'], ['show system'], ['write memory', 'Sauvegarder la config', 'save']];
for (const t of TERMS) {
  t.form.addEventListener('submit', (e) => { e.preventDefault(); submitTerm(t); });
  t.input.addEventListener('input', () => { if (t.at >= 0 && t.input.value !== TYPED[t.at]) t.at = -1; autoGrow(t); });
  t.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); t.form.requestSubmit(); }
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) browseTyped(t, e);
  });
  t.chips.innerHTML = (t.page ? [CHIPS.at(-1), ...CHIPS.slice(0, -1)] : CHIPS).map(([c, l, cls]) => `<button class="chip ${cls || ''}" data-cmd="${esc(c)}">${esc(l || c)}</button>`).join('');
  t.chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]'); if (!b) return;
    if (b.dataset.cmd === 'write memory') confirmCmd('Sauvegarder la configuration ?', saveText('La configuration actuelle devient celle chargée au démarrage du switch.'), 'write memory', 'Configuration sauvegardée');
    else busy(b, () => send(b.dataset.cmd).catch(() => {}));
  });
}

const TERM_ST = { pending: 'en attente', running: 'en cours', done: 'ok', error: 'erreur', confirm: 'question' };
function termEntry(c, page) {
  const st = Object.hasOwn(TERM_ST, c.status), out = OUT[c.id];
  return `<div class="term-cmd"><span class="st ${st ? c.status : ''}">${['pending', 'running'].includes(c.status) ? '<span class="spinner" style="width:9px;height:9px;border-width:1.5px"></span>' : ''}${st ? TERM_ST[c.status] : esc(c.status)}</span><span>${esc(c.label ? `${c.label} : ` : '')}${String(c.cmd).split('\n').map(esc).join(` ${icon('keyboard_return', { size: 13, label: 'puis' })} `)}</span>${page && out ? `<button type="button" class="term-copy" data-copy-out="${esc(c.id)}" aria-label="Copier la sortie : ${esc(cmdName(c))}">${icon('content_copy', { size: 14 })}Copier</button>` : ''}</div>
      ${out ? `<div class="term-out">${esc(out)}</div>` : ''}
      ${c.status === 'confirm' ? `<div class="term-ask">${esc(c.question || 'Confirmer ?')} <button class="btn small primary" data-answer="y" data-answer-id="${esc(c.id)}">Oui</button><button class="btn small" data-answer="n" data-answer-id="${esc(c.id)}">Non</button></div>` : ''}`;
}
// Les deux consoles d'un coup. force : après un envoi, ou à l'ouverture de la page (descend en bas).
function renderTerm(force) { for (const t of TERMS) drawTerm(t, force); }
// Une entrée par commande, mise à jour sur place : un bouton garde le focus, et le défilement ne suit que si l'on était
// déjà en bas. Sur la page, une ligne courte est annoncée quand une commande se termine (sayDone).
function drawTerm(t, force) {
  const box = t.log;
  const items = LOG.filter((c) => (t.page ? (conAuto || !isAuto(c)) && !conHidden.has(c.id) : !isAuto(c))).reverse();
  const key = `${t.page ? `${conAuto}|${conHidden.size}|` : ''}${items.map((c) => c.id + c.status + (OUT[c.id] || '').length).join()}`;
  if (key === t.key && !force) return;
  t.key = key;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (!items.length) {
    t.nodes = null;
    setHTML(box, t.page && conHidden.size ? '<div class="muted">Affichage vidé : les nouvelles commandes s’afficheront ici. <button type="button" class="btn small" data-con-all>Tout réafficher</button></div>'
      : '<div class="muted">Aucune commande pour l’instant. Les sorties s’afficheront ici.</div>');
  } else {
    if (!t.nodes) { box.textContent = ''; box._html = null; t.nodes = new Map(); }
    const keep = new Set(items.map((c) => c.id));
    for (const [id, n] of t.nodes) if (!keep.has(id)) { n.remove(); t.nodes.delete(id); }
    let prev = null;
    for (const c of items) {
      let n = t.nodes.get(c.id);
      if (!n) { n = document.createElement('div'); n.className = 'term-entry'; t.nodes.set(c.id, n); }
      const had = n.contains(document.activeElement) && document.activeElement.matches('[data-copy-out]');
      setHTML(n, termEntry(c, t.page));
      if (had && !n.contains(document.activeElement)) n.querySelector('[data-copy-out]')?.focus({ preventScroll: true });
      const want = prev ? prev.nextSibling : box.firstChild;
      if (n !== want) box.insertBefore(n, want);
      prev = n;
    }
  }
  if (t.page) sayDone(t, items);
  if (atBottom || force) box.scrollTop = box.scrollHeight;
}
// Page Console, lecteur d'écran : la sortie elle-même n'est pas lue (aria-live="off" : une configuration complète ferait
// plus de cent lignes) ; #conSay annonce « show vlan : terminé, 6 lignes ». Rien pour les commandes déjà là à l'ouverture.
function sayDone(t, items) {
  const first = !t.said; let msg = '';
  t.said ||= new Map();
  for (const c of items) {
    const k = OUT[c.id] !== undefined && ['done', 'error'].includes(c.status) ? c.status : '';
    if (t.said.get(c.id) === k) continue;
    t.said.set(c.id, k);
    if (!k || first || window.NAV?.current !== 'console') continue;
    const n = String(OUT[c.id]).split('\n').filter((l) => l.trim()).length;
    msg = `${cmdName(c)}\u00a0: ${k === 'done' ? 'terminé' : 'erreur'}, ${plural(n, 'ligne', 'lignes')}`;
  }
  if (!msg) return;
  const say = $('#conSay');
  say.textContent = ''; setTimeout(() => { say.textContent = msg; }, 60); // même texte deux fois de suite : relu quand même
}

// Page Console : hauteur de l'écran, relevés automatiques, copie d'une sortie, affichage vidé.
function fitConsole() {
  if ($('#view-console').hidden) return;
  const term = $('#conTerm'), r = term.getBoundingClientRect(), top = r.top + scrollY, foot = $('#foot');
  // sous la console : aide, bas de la carte, marge du bas de la page, bas de page
  const below = $('#conCard').getBoundingClientRect().bottom - r.bottom + parseFloat(getComputedStyle($('#appMain')).paddingBottom)
    + (foot.hidden ? 0 : foot.getBoundingClientRect().height);
  // Tout tient dans l'écran (ordinateur). Sinon (téléphone), la console s'arrête au bas de l'écran, champ de saisie
  // compris, et l'aide se lit en défilant ; 240 px au moins.
  const all = Math.floor(innerHeight - top - below);
  term.style.height = `${all >= 320 ? all : Math.max(240, Math.floor(innerHeight - top - 8))}px`;
}
// Téléphone : les commandes rapides tiennent sur une ligne qui défile ; bord droit estompé tant qu'il en reste à voir.
const chipsEdge = () => { const c = CON.chips; c.classList.toggle('more', c.scrollLeft + c.clientWidth < c.scrollWidth - 2); };
CON.chips.addEventListener('scroll', chipsEdge, { passive: true });
function openConsole() { fitConsole(); chipsEdge(); drawTerm(CON, true); } // account.js, à l'ouverture de la page
addEventListener('resize', () => { if (window.NAV?.current === 'console') { fitConsole(); chipsEdge(); } });
$('#conAuto').addEventListener('change', (e) => {
  conAuto = e.target.checked;
  try { localStorage.setItem('aruba-console-auto', conAuto ? '1' : '0'); } catch {}
  drawTerm(CON, true);
});
$('#conClear').addEventListener('click', () => {
  for (const c of LOG) if (!['pending', 'running', 'confirm'].includes(c.status)) conHidden.add(c.id); // une commande en cours reste
  drawTerm(CON, true);
});
$('#conLog').addEventListener('click', async (e) => {
  if (e.target.closest('[data-con-all]')) { conHidden.clear(); drawTerm(CON, true); CON.log.focus(); return; }
  const b = e.target.closest('[data-copy-out]'); if (!b) return;
  const id = b.dataset.copyOut, text = Object.hasOwn(OUT, id) ? String(OUT[id]) : '';
  try { await navigator.clipboard.writeText(text); toast('Sortie copiée', { type: 'success', timeout: 2000 }); }
  catch {
    const out = b.closest('.term-entry')?.querySelector('.term-out');
    if (out) getSelection().selectAllChildren(out);
    toast('Copie impossible', { type: 'warn', sub: 'La sortie est sélectionnée : Ctrl+C ou Cmd+C.' });
  }
});

// ================================================================ réglages (page de l'administrateur) et alertes
// Page #view-settings (ancre #reglages) : où et quand prévenir, ports surveillés, site, rythme de l'agent.
// SAVED garde les réglages tels qu'affichés au dernier remplissage : la barre d'enregistrement n'apparaît que s'il reste
// des changements, et account.js (NAV.leave) demande confirmation avant de quitter la page sans enregistrer.
let SETTINGS = null, EMAIL_OK = false, watchSel = null, CRON = null, SAVED = null;
async function loadSettings(report = false) {
  try {
    const d = await api('/api/settings'); SETTINGS = d.settings; EMAIL_OK = d.emailAvailable; CRON = d.cron || null;
    fillSettings(); renderAlerts();
  } catch (err) { if (report && err.message !== '401') toast('Réglages indisponibles', { type: 'error', sub: err.message }); }
}
function autoWatch() { return (S?.ports || []).filter((p) => isUplink(p) || p.desc).map((p) => p.port); }

// Valeurs de la page, dans la forme attendue par POST /api/settings.
function settingsBody() {
  const v = (s) => $(s).value, on = (s) => $(s).checked;
  return {
    email: v('#alEmail'), webhook: v('#alHook'), tempMax: v('#alTempMax'),
    watchPorts: watchSel ? [...watchSel].sort((a, b) => portNum(a) - portNum(b)) : null, autoCable: on('#alAutoCable'),
    siteName: v('#alSite'), tz: v('#alTz'),
    agent: { hot: v('#alHot'), warm: v('#alWarm'), idle: v('#alIdleSync') },
    notify: { portDown: on('#alPortDown'), temp: on('#alTemp'), agentOffline: on('#alAgent'), slowLink: on('#alSlow'), idleLink: on('#alIdle'), newDevice: on('#alNewDev') },
  };
}
function settingsDirty() { return SAVED !== null && JSON.stringify(settingsBody()) !== SAVED; }

// Remplit la page. Une saisie en cours n'est pas écrasée par une relecture, sauf force (enregistrement, annulation,
// départ de la page sans enregistrer).
function fillSettings(force = false) {
  const c = $('#alCron'); c.hidden = !(CRON && !CRON.ok);
  if (!c.hidden) c.textContent = `La vérification toutes les 5\u00a0minutes n’a pas pu être programmée dans Supabase (${CRON.error || 'erreur inconnue'}) : alerte «\u00a0agent hors ligne\u00a0», actions planifiées et sauvegardes automatiques ne fonctionnent pas. Active les extensions pg_cron et pg_net dans Supabase (Database > Extensions), puis recharge le dashboard.`;
  $('#alEmail').disabled = !EMAIL_OK;
  $('#alEmailNote').textContent = EMAIL_OK ? 'Sans domaine vérifié chez Resend, les e-mails partent de onboarding@resend.dev et ne peuvent aller qu’à l’adresse du compte Resend.' : 'E-mail indisponible : l’intégration Resend n’est pas encore activée sur Vercel.';
  const s = SETTINGS;
  if (!s || (!force && settingsDirty())) return syncSettings();
  putSettings(s);
  document.querySelectorAll('#alertForm [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
  $('#alErr').textContent = '';
  renderWatch();
  SAVED = JSON.stringify(settingsBody());
  syncSettings();
}
// Écrit des réglages dans les champs : ceux du serveur, ou une saisie gardée (même forme, celle de settingsBody()).
function putSettings(s) {
  $('#alEmail').value = s.email || '';
  $('#alHook').value = s.webhook || '';
  $('#alPortDown').checked = s.notify.portDown; $('#alTemp').checked = s.notify.temp; $('#alAgent').checked = s.notify.agentOffline;
  $('#alSlow').checked = s.notify.slowLink; $('#alIdle').checked = s.notify.idleLink; $('#alNewDev').checked = Boolean(s.notify.newDevice);
  $('#alTempMax').value = s.tempMax; $('#alTempMax').disabled = !s.notify.temp;
  $('#alAutoCable').checked = s.autoCable !== false;
  $('#alSite').value = s.siteName || ''; $('#alTz').value = s.tz || 'Europe/Paris';
  $('#alHot').value = s.agent?.hot ?? 10; $('#alWarm').value = s.agent?.warm ?? 30; $('#alIdleSync').value = s.agent?.idle ?? 60;
  watchSel = s.watchPorts?.length ? new Set(s.watchPorts) : null; // liste vide = mode Auto, comme l'agent
}
// Session expirée avec des changements non enregistrés (showLogin) : la saisie est gardée, puis remise si le même compte
// se reconnecte ; un autre compte retrouve les réglages enregistrés.
let KEPT = null;
function keepSettings() { KEPT = SAVED !== null && settingsDirty() ? { login: String(ME?.login || '').toLowerCase(), body: settingsBody() } : null; }
function restoreSettings(login) {
  const k = KEPT; KEPT = null;
  if (!k || k.login !== String(login || '').trim().toLowerCase() || SAVED === null) return;
  putSettings(k.body); renderWatch(); syncSettings();
}
// Barre d'enregistrement et test : le test part avec les réglages enregistrés, pas avec la saisie en cours.
function syncSettings() {
  const dirty = settingsDirty(), t = $('#alertTest'), bar = $('#alBar'), appear = dirty && bar.hidden;
  bar.hidden = !dirty;
  if (!dirty) $('#alErr').textContent = ''; // erreur d'un envoi précédent : plus d'actualité
  if (appear) { // la barre arrive par-dessus la page : la case ou le champ en cours reste visible au-dessus d'elle
    fitBar();
    const el = document.activeElement;
    if (el && el !== document.body && !bar.contains(el)) el.scrollIntoView({ block: 'nearest' });
  }
  t.dataset.lock = dirty ? '1' : '';
  if (!t.classList.contains('loading')) t.disabled = dirty;
  $('#alTestNote').textContent = dirty ? 'Enregistre d’abord tes modifications : le test part avec les réglages enregistrés.'
    : 'Envoie une notification de test aux adresses et au webhook enregistrés.';
}

// Ports surveillés, comme la façade : impairs en haut, pairs en bas ; 1 à 12, 13 à 24, puis les SFP 25 à 28.
$('#alPorts').innerHTML = [[1, 12, 'Ports 1 à 12'], [13, 24, 'Ports 13 à 24'], [25, 28, 'Ports SFP 25 à 28']].map(([a, b, label], i) =>
  `<div class="wp-g${i === 2 ? ' sfp' : ''}" role="group" aria-label="${label}">${Array.from({ length: b - a + 1 }, (_, k) =>
    `<button type="button" class="wp" data-wp="1/1/${a + k}" aria-pressed="false">${a + k}</button>`).join('')}</div>`).join('');
function renderWatch() {
  const auto = autoWatch(), cur = watchSel || new Set(auto);
  const ports = Object.fromEntries((S?.ports || []).map((p) => [p.port, p]));
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; }; // relu à chaque mise à jour : pas de nouvelle annonce
  for (const b of document.querySelectorAll('#alPorts [data-wp]')) {
    const p = ports[b.dataset.wp], on = String(cur.has(b.dataset.wp));
    if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
    const label = [`Port ${portNum(b.dataset.wp)}`, p?.desc, p && isUplink(p) && 'lien vers un autre switch'].filter(Boolean).join(', ');
    if (b.title !== label) { b.title = label; b.setAttribute('aria-label', label); }
  }
  for (const b of document.querySelectorAll('#alMode [data-mode]')) {
    const on = (b.dataset.mode === 'manual') === Boolean(watchSel);
    b.classList.toggle('on', on); if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
  }
  setText($('#alPortsCount'), String(cur.size));
  const name = `Ports du switch, ${cur.size} surveillé${cur.size > 1 ? 's' : ''}`;
  if ($('#alPorts').getAttribute('aria-label') !== name) $('#alPorts').setAttribute('aria-label', name);
  setText($('#alPortsNote'), !watchSel
    ? `Les liens vers d’autres switches et les ports qui ont une description${auto.length ? ` : en ce moment ${auto.map(portNum).join(', ')}` : ' (aucun pour l’instant)'}. Clique sur un port pour choisir à la main.`
    : watchSel.size ? 'Clique sur un port pour l’ajouter ou le retirer.' : 'Aucun port choisi : à l’enregistrement, le choix automatique reprend.');
}
$('#alPorts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-wp]'); if (!b) return;
  watchSel = watchSel || new Set(autoWatch());
  watchSel.has(b.dataset.wp) ? watchSel.delete(b.dataset.wp) : watchSel.add(b.dataset.wp);
  renderWatch(); syncSettings();
});
$('#alMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  watchSel = b.dataset.mode === 'auto' ? null : watchSel || new Set(autoWatch());
  renderWatch(); syncSettings();
});
$('#alertForm').addEventListener('input', (e) => {
  if (e.target.getAttribute?.('aria-invalid')) { e.target.removeAttribute('aria-invalid'); $('#alErr').textContent = ''; } // champ en cours de correction
  syncSettings();
});
$('#alertForm').addEventListener('change', (e) => {
  if (e.target.id === 'alTemp') {
    const t = $('#alTempMax');
    // alerte décochée avec un seuil faux ou vide : le champ grisé échapperait à la vérification, la valeur enregistrée revient
    if (!e.target.checked && !t.checkValidity()) { t.value = SETTINGS?.tempMax ?? 70; t.removeAttribute('aria-invalid'); }
    t.disabled = !e.target.checked;
  }
  syncSettings();
});
// Barre collée en bas : la page garde sa hauteur en réserve, un champ atteint au clavier ne passe pas dessous (WCAG 2.4.11).
function fitBar() {
  const h = $('#alBar').offsetHeight; // 0 quand la barre (ou la page) est cachée
  document.documentElement.style.scrollPaddingBottom = h ? `${h + 24}px` : '';
}
const barSize = 'ResizeObserver' in window ? new ResizeObserver(fitBar) : null; // barre affichée, cachée, agrandie par un message
barSize?.observe($('#alBar'));

const tzOk = (z) => { try { new Intl.DateTimeFormat('fr-FR', { timeZone: z }); return Boolean(z); } catch { return false; } };
const SET_NUMS = [['#alTempMax', 'Seuil de température', '°C'], ['#alHot', 'Dashboard ouvert', 's'], ['#alWarm', 'Écran lecture seule', 's'], ['#alIdleSync', 'Aucune page ouverte', 's']];
$('#alertForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!settingsDirty()) return;
  const bad = (el, msg) => { el.setAttribute('aria-invalid', 'true'); $('#alErr').textContent = msg; fitBar(); el.focus(); }; // barre agrandie par le message : réserve à jour avant le focus
  $('#alErr').textContent = '';
  for (const [sel, name, unit] of SET_NUMS) {
    const el = $(sel);
    if (!el.disabled && !el.checkValidity()) return bad(el, `${name} : un nombre entier de ${el.min} à ${el.max}\u00a0${unit}.`);
  }
  if (!tzOk($('#alTz').value.trim())) return bad($('#alTz'), 'Fuseau horaire inconnu : choisis-en un dans la liste, par exemple Europe/Paris.');
  const body = settingsBody(), sent = JSON.stringify(body);
  busy($('#alSave'), async () => {
    try {
      const d = await api('/api/settings', body);
      SETTINGS = d.settings;
      if (JSON.stringify(settingsBody()) === sent) fillSettings(true);
      else { SAVED = sent; syncSettings(); } // saisie faite pendant l'enregistrement : gardée, encore à enregistrer
      renderAlerts();
      if (S) document.title = `${SETTINGS.siteName || 'My Aruba Manager'} · ${S.hostname || 'switch'}`;
      if ($('#alBar').hidden) $('#setTitle').focus({ preventScroll: true }); // la barre (et son bouton) disparaît : le focus revient au titre
      toast('Réglages enregistrés', { type: 'success', sub: 'L’agent applique les alertes à sa prochaine mise à jour.' });
    } catch (err) {
      if (err.message === '401') return;
      $('#alErr').textContent = err.message;
      const field = /e-mail/i.test(err.message) ? '#alEmail' : /webhook/i.test(err.message) ? '#alHook' : null;
      if (field) $(field).setAttribute('aria-invalid', 'true');
    }
  });
});
$('#alReset').addEventListener('click', () => {
  fillSettings(true); $('#setTitle').focus({ preventScroll: true });
  toast('Modifications annulées', { timeout: 2500 });
  loadSettings(); // et relecture des réglages du serveur (un autre administrateur a pu les changer)
});
$('#alertTest').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  if (settingsDirty()) return;
  try { const r = await api('/api/alerts/test', {}); toast('Notification de test envoyée', { type: 'success', sub: `Via : ${r.sent.join(' + ')}` }); setTimeout(poll, 800); }
  catch (err) { if (err.message !== '401') toast('Le test a échoué', { type: 'error', sub: err.message, timeout: 9000 }); }
}));
// Ouvre la page Réglages (bouton de la carte Alertes récentes, assistant de démarrage).
function openAlertSettings(e) {
  e?.preventDefault?.();
  if (!canAdmin() || !window.NAV) return;
  history.replaceState(null, '', '#reglages');
  NAV.show('settings', { focus: true });
}
$('#alertSettingsBtn').addEventListener('click', openAlertSettings);
$('#alertChannels').addEventListener('click', (e) => { if (e.target.closest('[data-go-settings]')) openAlertSettings(e); });
// Fermer l'onglet ou recharger avec des changements non enregistrés : le navigateur demande confirmation.
addEventListener('beforeunload', (e) => { if (window.NAV?.current === 'settings' && settingsDirty()) { e.preventDefault(); e.returnValue = ''; } });
$('#bellBtn').addEventListener('click', async () => {
  if (window.NAV) { if (!(await NAV.leave('dashboard'))) return; history.replaceState(null, '', '#alertes'); NAV.show('dashboard'); } // rechargement : même carte
  const sec = $('#sec-alertes'); sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
  sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash');
  try { localStorage.setItem('alertsSeen', String(Date.now() / 1000)); } catch (e) {}
  renderAlerts();
});
// Niveau d'une alerte en toutes lettres pour les lecteurs d'écran (la pastille n'est que couleur et forme), mêmes
// mots que les e-mails et webhooks (lib/notify.js).
const ALERT_LVL = { critical: 'Critique', warning: 'Attention', ok: 'Rétabli', info: 'Info' };
function renderAlerts() {
  let seen = 0; try { seen = Number(localStorage.getItem('alertsSeen')) || 0; } catch (e) {}
  const fresh = ALERTS.filter((a) => a.t > seen && a.t > NOW - 86400 && ['critical', 'warning'].includes(a.level)).length;
  $('#bellCount').hidden = !fresh; $('#bellCount').textContent = fresh > 9 ? '9+' : String(fresh);
  $('#bellBtn').title = fresh ? `${fresh} nouvelle(s) alerte(s)` : 'Alertes récentes';
  $('#bellBtn').setAttribute('aria-label', $('#bellBtn').title);
  $('#navAlertCount').hidden = !fresh; $('#navAlertCount').textContent = $('#bellCount').textContent;
  $('#alertCount').textContent = ALERTS.length ? `${ALERTS.length}` : '';
  setHTML($('#alertList'), ALERTS.length ? ALERTS.slice(0, 12).map((a) => `<div class="alert-item"><span class="lvl ${esc(a.level)}">${Object.hasOwn(ALERT_LVL, a.level) ? `<span class="sr">${ALERT_LVL[a.level]} : </span>` : ''}</span>
    <div>${esc(a.text)}<div class="ch">${arr(a.sent).length ? `envoyé par ${esc(arr(a.sent).join(' + '))}` : 'non envoyé'}${arr(a.errors).length ? ` · ${icon('warning', { size: 13, label: 'Erreur d’envoi', cls: 'ic-warn' })} ${esc(arr(a.errors).join(' · '))}` : ''}</div></div>
    <span class="when">${new Date(a.t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div>`).join('')
    : '<div class="empty" style="padding:16px 0">Aucune alerte pour l’instant.</div>');
  const ch = SETTINGS ? [SETTINGS.email && 'e-mail', SETTINGS.webhook && 'webhook'].filter(Boolean) : null;
  setHTML($('#alertChannels'), !ch ? '' : ch.length ? `Envoi par ${ch.join(' et ')}.` : `<span style="color:var(--warn)">Aucun canal configuré : les alertes ne sont envoyées nulle part.</span> ${canAdmin()
    ? '<a href="#reglages" data-go-settings>Ajoute un e-mail ou un webhook dans Réglages</a>.' : 'Un administrateur peut en ajouter dans Réglages.'}`);
  if (SETTINGS && !watchSel) renderWatch(); // mode Auto : la liste suit les descriptions et les liens du switch
}

// ================================================================ graphique
let chartRange = '1h', chartData = null, chartKey = '';
function fillPortSelect() {
  const sel = $('#chartPort'), cur = sel.value;
  const opts = '<option value="">Tous les ports</option>' + (S.ports || []).filter((p) => p.type === '1GbT' || p.up).map((p) => `<option value="${esc(p.port)}">Port ${portNum(p.port)}${p.desc ? ` · ${esc(p.desc)}` : ''}</option>`).join('');
  if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; sel.value = cur; }
}
function setRange(r) { chartRange = r; [...$('#chartRange').children].forEach((x) => x.classList.toggle('on', x.dataset.r === r)); loadChart(); }
$('#chartRange').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setRange(b.dataset.r); });
$('#chartPort').addEventListener('change', () => loadChart());
async function loadChart() {
  const port = $('#chartPort').value;
  $('#chartTitle').textContent = port ? `port ${portNum(port)}` : 'total';
  if (chartRange === '1h' && !port) { chartData = null; renderChart(); return; }
  const key = `${chartRange}|${port}`;
  chartKey = key;
  $('#chart').innerHTML = '<div class="empty"><span class="spinner"></span> Chargement de l’historique…</div>';
  try {
    const d = await api(`/api/history?range=${chartRange}&port=${encodeURIComponent(port)}`);
    if (chartKey === key) { chartData = d.points; renderChart(); }
  } catch (e) { if (e.message !== '401') $('#chart').innerHTML = `<div class="empty">Historique indisponible : ${esc(e.message)}</div>`; }
}
function renderChart() {
  const live = chartRange === '1h' && !$('#chartPort').value;
  const h = live ? (S?.history || []) : (chartData || []);
  const el = $('#chart');
  if (!live && chartData === null) return;
  if (h.length < 2) { el.innerHTML = `<div class="empty">${live ? 'Le graphique se remplit après quelques relevés de l’agent.' : 'Pas encore assez d’historique : un point est enregistré toutes les 5 min (24 h), 30 min (7 j) ou 2 h (30 j).'}</div>`; return; }
  const W = el.clientWidth || 800, H = 220, L = 64, R = 8, T = 10, B = 24;
  const t0 = h[0][0], t1 = h.at(-1)[0];
  const maxV = Math.max(1000, ...h.map((d) => Math.max(d[1], d[2])));
  const step = niceStep(maxV / 4), top = Math.ceil(maxV / step) * step;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const line = (i) => h.map((d, k) => `${k ? 'L' : 'M'}${x(d[0]).toFixed(1)},${y(d[i]).toFixed(1)}`).join('');
  const span = t1 - t0;
  const tfmt = (t) => { const d = new Date(t * 1000); return span > 3 * 86400 ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : span > 86400 ? d.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit' }) + 'h' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
  let g = '';
  for (let v = 0; v <= top + 1; v += step) g += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtBps(v)}</text>`;
  for (let i = 0; i <= 5; i++) { const t = t0 + (span * i) / 5; g += `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}">${tfmt(t)}</text>`; }
  const area = (i) => `${line(i)}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Débit entrant et sortant">${g}
    <path d="${area(1)}" fill="var(--rx)" opacity=".08"/><path d="${area(2)}" fill="var(--tx)" opacity=".08"/>
    <path d="${line(1)}" fill="none" stroke="var(--rx)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line(2)}" fill="none" stroke="var(--tx)" stroke-width="2" stroke-linejoin="round"/>
    <g id="hover" visibility="hidden"><line id="hl" y1="${T}" y2="${H - B}" stroke="var(--text-3)" stroke-dasharray="3 3"/>
      <circle id="h1" r="4" fill="var(--rx)" stroke="var(--surface)" stroke-width="2"/><circle id="h2" r="4" fill="var(--tx)" stroke="var(--surface)" stroke-width="2"/></g>
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="hit"/></svg><div class="tip" id="tip" hidden></div>`;
  const hit = el.querySelector('#hit'), hov = el.querySelector('#hover'), tip = el.querySelector('#tip');
  hit.addEventListener('pointermove', (e) => {
    const r = el.querySelector('svg').getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    let best = h[0]; for (const d of h) if (Math.abs(x(d[0]) - px) < Math.abs(x(best[0]) - px)) best = d;
    const bx = x(best[0]);
    hov.setAttribute('visibility', 'visible');
    for (const [id, a, v] of [['#hl', 'x1', bx], ['#hl', 'x2', bx], ['#h1', 'cx', bx], ['#h1', 'cy', y(best[1])], ['#h2', 'cx', bx], ['#h2', 'cy', y(best[2])]]) el.querySelector(id).setAttribute(a, v);
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max((bx / W) * r.width, 90), r.width - 90)}px`;
    tip.style.top = `${(y(Math.max(best[1], best[2])) / H) * r.height - 10}px`;
    tip.innerHTML = `<b>${new Date(best[0] * 1000).toLocaleString('fr-FR', { weekday: span > 86400 ? 'short' : undefined, hour: '2-digit', minute: '2-digit', second: live ? '2-digit' : undefined })}</b>
      <div><i class="sw" style="background:var(--rx);height:2px"></i>Entrant <span class="num" style="margin-left:auto;padding-left:12px">${fmtBps(best[1])}</span></div>
      <div><i class="sw" style="background:var(--tx);height:2px"></i>Sortant <span class="num" style="margin-left:auto;padding-left:12px">${fmtBps(best[2])}</span></div>`;
  });
  hit.addEventListener('pointerleave', () => { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}
function niceStep(v) { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => S && renderChart(), 150); });
setInterval(() => { if (!document.hidden && chartRange !== '1h' && !$('#app').hidden) loadChart(); }, 5 * 60 * 1000);

// Lien d'invitation ou de nouveau mot de passe : account.js affiche le formulaire, pas le dashboard.
if (new URLSearchParams(location.search).has('invite')) showLogin(); else poll();
