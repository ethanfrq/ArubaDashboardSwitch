// Actions planifiées (Administration > Planification) : couper, rallumer ou redémarrer des ports, allumer les PC
// à heure fixe. Le serveur les exécute lui-même (passage toutes les 5 min), même si personne n'a le dashboard ouvert.
// Données : X.schedules (administrateur seulement). Enregistrement : POST /api/settings { action: 'schedules-save' }.
// Couper ou redémarrer 8 ports ou plus : le serveur répond 409 et demande CONFIRMER (seconde confirmation).
(() => {
  'use strict';
  const ACT = { shutdown: 'Couper les ports', noshutdown: 'Rallumer les ports', bounce: 'Redémarrer les ports', wol: 'Allumer les PC (Wake-on-LAN)' };
  const TAG = { shutdown: 'Coupure', noshutdown: 'Remise en service', bounce: 'Redémarrage', wol: 'Wake-on-LAN' };
  const HELP = {
    shutdown: 'Les ports choisis sont désactivés : les appareils branchés perdent le réseau. La configuration n’est pas sauvegardée, un redémarrage du switch les réactive.',
    noshutdown: 'Les ports choisis sont réactivés.',
    bounce: 'Chaque port est coupé puis réactivé aussitôt (quelques secondes sans réseau). Un port désactivé reste désactivé.',
    wol: 'Un paquet Wake-on-LAN est envoyé au dernier appareil vu sur chaque port. Le Wake-on-LAN doit être activé dans le BIOS des PC, et un PC doit avoir été allumé une fois sur son port pour que son adresse soit connue.',
  };
  const DAY_L = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  const DAY_S = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
  const DAY_F = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const MAX = 30, TIME = /^([01]\d|2[0-3]):[0-5]\d$/, PORT = /^1\/1\/([1-9]|1\d|2[0-8])$/;
  const BULK = 8; // couper ou redémarrer autant de ports d'un coup : seconde confirmation (même seuil que lib/danger.js)
  const ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  let dlg = null, body = null, view = 'list', draft = null, delAsk = null, delTimer = 0, skew = 0, dropNote = '', listError = '';
  let pressing = 0, cf = null; // pressing : heure (ms) de l'appui en cours dans la fenêtre, 0 si aucun

  const css = document.createElement('style');
  css.textContent = `
.sched-dlg { width: min(640px, calc(100% - 24px)); }
.sched-dlg h3 { overflow-wrap: anywhere; }
.sched-list { display: grid; max-height: min(52vh, 460px); overflow: auto; margin: 0 -4px; padding: 0 4px; }
.sched-item { padding: 10px 0; border-bottom: 1px solid var(--border); display: grid; gap: 3px; }
.sched-item:last-child { border-bottom: 0; }
.sched-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sched-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.sched-top .btn.icon { width: 28px; height: 26px; flex-shrink: 0; }
.sched-top .btn.icon svg { width: 14px; height: 14px; }
.sched-meta, .sched-last { font-size: 12.5px; color: var(--text-2); padding-left: 44px; overflow-wrap: anywhere; }
.sched-last { font-size: 12px; color: var(--text-3); }
.sched-item.off .sched-name, .sched-item.off .sched-meta { color: var(--text-3); }
.sched-last.ok { color: var(--good); } .sched-last.bad { color: var(--bad); } .sched-last.warn { color: var(--warn); } .sched-last.run { color: var(--info); }
.sched-sw { position: relative; width: 36px; height: 20px; border-radius: 999px; border: 0; padding: 0; background: var(--border); cursor: pointer; flex-shrink: 0; transition: background .15s; }
.sched-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .3); transition: transform .15s; }
.sched-sw[aria-checked="true"] { background: var(--good); }
.sched-sw[aria-checked="true"]::after { transform: translateX(16px); }
.sched-sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sched-sw:disabled { opacity: .55; cursor: default; }
.sched-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 0 10px; }
.sched-dlg input[type=time] { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); outline: none; font-family: var(--mono); }
.sched-dlg input[type=time]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgb(255 131 0 / .18); }
.sched-dlg .field > .label { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.sched-short { display: inline-flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.sched-days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; max-width: 380px; }
.sched-days .chip { text-align: center; padding: 6px 0; font: 600 12.5px system-ui, sans-serif; }
.sched-dlg .portpick .chip.sched-lock { opacity: .4; cursor: not-allowed; text-decoration: line-through; }
.sched-dlg .alert { margin: 0 0 8px; }
.sched-pp { display: grid; gap: 1px; font-size: 13px; }
.sched-pp.off { color: var(--text-3); }
@media (max-width: 480px) { .sched-grid { grid-template-columns: minmax(0, 1fr); } .sched-meta, .sched-last { padding-left: 0; } .sched-short { margin-left: 0; } }
@media (prefers-reduced-motion: reduce) { .sched-sw, .sched-sw::after { transition: none; } }`;
  document.head.append(css);

  // ---------------------------------------------------------------- fuseau horaire (même calcul que le serveur)
  const FMT = new Map();
  function fmt(z) {
    let f = FMT.get(z);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      FMT.set(z, f);
    }
    return f;
  }
  const zoneOk = (z) => { if (!z || typeof z !== 'string') return false; try { fmt(z); return true; } catch { return false; } };
  const tz = () => (zoneOk(SETTINGS?.tz) ? SETTINGS.tz : 'Europe/Paris');
  function parts(ms, z) {
    const o = {};
    for (const p of fmt(z).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
    return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
  }
  function offsetAt(ms, z) {
    const t = Math.floor(ms / 1000) * 1000, p = parts(t, z);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
  }
  // Heure locale du fuseau -> instant (s) ; heure inexistante (heure d'été) décalée, heure double : la première.
  function zonedEpoch(y, m, d, h, mi, z) {
    const local = Date.UTC(y, m - 1, d, h, mi);
    const before = offsetAt(local - 86400000, z), after = offsetAt(local + 86400000, z);
    const ok = [local - before, local - after].filter((t) => offsetAt(t, z) === local - t);
    return (ok.length ? Math.min(...ok) : local - before) / 1000;
  }
  function shiftDay(y, m, d, k) {
    const t = new Date(Date.UTC(y, m - 1, d + k));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: ((t.getUTCDay() + 6) % 7) + 1 };
  }
  const nowS = () => Date.now() / 1000 + skew; // heure du serveur (écart mesuré à chaque lecture de l'état)
  // Prochaine heure prévue (s) après « now », ou null (le serveur l'exécute au passage suivant, à 5 min près).
  function nextRun(s, now = nowS()) {
    const days = arr(s?.days);
    if (!TIME.test(s?.time || '') || !days.length) return null;
    const z = tz(), [hh, mm] = s.time.split(':').map(Number), p = parts(now * 1000, z);
    for (let k = 0; k <= 8; k++) {
      const day = shiftDay(p.y, p.m, p.d, k);
      if (!days.includes(day.dow)) continue;
      const t = zonedEpoch(day.y, day.m, day.d, hh, mm, z);
      if (t > now) return t;
    }
    return null;
  }

  // Dernière heure prévue (s) avant « now » (7 jours au plus), ou null.
  function prevRun(s, now = nowS()) {
    const days = arr(s?.days);
    if (!TIME.test(s?.time || '') || !days.length) return null;
    const z = tz(), [hh, mm] = s.time.split(':').map(Number), p = parts(now * 1000, z);
    for (let k = 0; k >= -7; k--) {
      const day = shiftDay(p.y, p.m, p.d, k);
      if (!days.includes(day.dow)) continue;
      const t = zonedEpoch(day.y, day.m, day.d, hh, mm, z);
      if (t <= now) return t;
    }
    return null;
  }

  // ---------------------------------------------------------------- textes
  const pad = (n) => String(n).padStart(2, '0');
  function whenText(t) {
    const z = tz(), p = parts(t * 1000, z), n = parts(nowS() * 1000, z);
    const diff = (Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(n.y, n.m - 1, n.d)) / 86400000;
    const day = diff === 0 ? 'aujourd’hui' : diff === 1 ? 'demain' : `${DAY_F[shiftDay(p.y, p.m, p.d, 0).dow - 1]} ${pad(p.d)}/${pad(p.m)}`;
    return `${day} à ${pad(p.h)}:${pad(p.mi)}`;
  }
  function inText(sec) {
    if (sec < 60) return 'dans moins d’une minute';
    if (sec < 3600) return `dans ${Math.floor(sec / 60)} min`;
    if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return `dans ${h} h${m ? ` ${pad(m)}` : ''}`; }
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
    return `dans ${d} j${h ? ` ${h} h` : ''}`;
  }
  function daysText(days) {
    const d = [...new Set(arr(days))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 7).sort((a, b) => a - b);
    return { 1234567: 'tous les jours', 12345: 'du lundi au vendredi', 123456: 'du lundi au samedi', 67: 'le week-end' }[d.join('')]
      || (d.length === 1 ? `le ${DAY_F[d[0] - 1]}` : d.length ? d.map((n) => DAY_S[n - 1]).join(' ') : 'aucun jour');
  }
  const nums = (ports) => [...new Set(arr(ports).filter((p) => PORT.test(p)).map(portNum))].sort((a, b) => a - b);
  const fmtPorts = (ports) => ranges(nums(ports)).map((x) => x.replace(/1\/1\//g, '')).join(', '); // « 1-12, 14 »
  function portsText(ports) {
    const n = nums(ports);
    return n.length ? `${n.length > 1 ? 'ports' : 'port'} ${fmtPorts(ports)}` : 'aucun port';
  }
  // Seconde confirmation : même signature que le serveur (confirmSig), gardée tant que l'action et les ports restent.
  const isBulk = (action, ports) => (action === 'shutdown' || action === 'bounce') && nums(ports).length >= BULK;
  const sigOf = (action, ports) => `${action} ${fmtPorts(ports)}`;
  const unconfirmed = (s) => isBulk(s.action, s.ports) && s.confirmed !== sigOf(s.action, s.ports);
  // Même nettoyage que le serveur : une ligne, sans caractère de contrôle ni « # » en tête, 60 caractères.
  const cleanName = (s) => String(s ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, 60).trim();

  // ---------------------------------------------------------------- données
  const list = () => arr(X.schedules).filter((s) => s && typeof s === 'object' && typeof s.id === 'string');
  const strip = (s) => ({ id: s.id, name: s.name, enabled: s.enabled !== false, days: arr(s.days), time: s.time, action: s.action, ports: arr(s.ports) });
  const portOf = (port) => arr(S?.ports).find((x) => x?.port === port);
  const uplink = (port) => { const p = portOf(port); return Boolean(p && isUplink(p)); };
  // Port du PC qui fait tourner l'agent (même règle que lib/danger.js).
  function agentPorts() {
    const host = String(S?.agent?.host || '').split('.')[0].toLowerCase();
    if (!host) return new Set();
    return new Set(arr(S?.lldp).filter((l) => String(l?.chassis || '').toLowerCase() === host || String(l?.name || '').toLowerCase() === host).map((l) => l.port));
  }
  // Ports refusés par le serveur pour cette action (affichés grisés).
  function lockOf(action, port, agent = agentPorts()) {
    if (action === 'noshutdown') return '';
    if (uplink(port)) return 'relie un autre switch';
    if (action !== 'wol' && agent.has(port)) return 'PC de l’agent';
    return '';
  }
  // Ports d'élèves : cuivre, hors liens vers d'autres switches et port du PC de l'agent.
  function studentPorts(action) {
    const agent = agentPorts();
    const known = arr(S?.ports).filter((p) => p?.type === '1GbT' && !isUplink(p) && !agent.has(p.port)).map((p) => p.port);
    return known.length ? known : Array.from({ length: 24 }, (_, i) => `1/1/${i + 1}`).filter((p) => !lockOf(action, p, agent));
  }
  // Même règle que le serveur (offlineAfter) : 3 min sans nouvelles, ou le rythme d'envoi le plus lent de l'agent
  // (réglages, 300 s au plus) plus 2 min.
  function offlineAfter() {
    const a = SETTINGS?.agent || {};
    const slow = Math.max(0, ...['hot', 'warm', 'idle'].map((k) => Number(a[k])).filter(Number.isFinite));
    return Math.max(180, Math.min(300, slow) + 120);
  }
  const agentOffline = () => Boolean(S?.received) && nowS() - S.received > offlineAfter();
  function newId() {
    let id;
    do id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.replace(/[^a-z0-9]/g, '').slice(0, 20);
    while (list().some((s) => s.id === id));
    return id;
  }

  // ---------------------------------------------------------------- liste
  function lastHtml(s) {
    const run = arr(LOG).find((c) => c?.kind === 'sched' && c.meta?.sched === s.id && ['pending', 'running', 'confirm'].includes(c.status));
    if (run) return '<div class="sched-last run"><span class="spinner" style="width:9px;height:9px;border-width:1.5px"></span> En cours d’exécution par l’agent…</div>';
    if (!s.last) return '<div class="sched-last">Jamais exécutée pour l’instant.</div>';
    const CLS = { ok: 'ok', error: 'bad', skipped: 'warn', late: 'warn', queued: 'run' };
    const cls = Object.hasOwn(CLS, s.lastStatus) ? CLS[s.lastStatus] : ''; // valeur du serveur : jamais une clé héritée dans la classe
    return `<div class="sched-last ${cls}">Dernière fois ${esc(ago(nowS() - Number(s.last)))} : ${esc(s.lastResult || '-')}</div>`;
  }
  // Heure passée depuis plus de 15 min sans aucune trace d'exécution : le passage toutes les 5 min ne tourne pas ?
  function missed(s) {
    if (s.enabled === false) return false;
    const pv = prevRun(s), now = nowS();
    return Boolean(pv) && pv > (Number(s.since) || 0) && now - pv > 900 && !(Number(s.last) >= pv);
  }
  function itemHtml(s) {
    const on = s.enabled !== false, nx = on ? nextRun(s) : null, id = esc(s.id), name = esc(s.name);
    return `<div class="sched-item${on ? '' : ' off'}">
      <div class="sched-top">
        <button type="button" class="sched-sw" role="switch" aria-checked="${on}" data-sched="toggle" data-id="${id}" title="${on ? 'Active : clique pour la suspendre' : 'Suspendue : clique pour la réactiver'}" aria-label="${on ? 'Suspendre' : 'Réactiver'} « ${name} »"></button>
        <span class="sched-name" title="${name}">${name}</span>
        <button type="button" class="btn icon" data-sched="edit" data-id="${id}" title="Modifier" aria-label="Modifier « ${name} »">${ICON_EDIT}</button>
        ${delAsk === s.id ? `<button type="button" class="btn small dangerous" data-sched="del" data-id="${id}">Supprimer ?</button>`
          : `<button type="button" class="btn icon danger" data-sched="del" data-id="${id}" title="Supprimer" aria-label="Supprimer « ${name} »">${ICON_TRASH}</button>`}
      </div>
      <div class="sched-meta"><b>${esc(TAG[s.action] || s.action)}</b> à <span class="mono">${esc(s.time)}</span>, ${esc(daysText(s.days))} · ${esc(portsText(s.ports))}</div>
      <div class="sched-meta">${!on ? 'Suspendue : ne s’exécute pas.' : nx ? `Prochaine : <b>${esc(whenText(nx))}</b> <span class="muted">(${esc(inText(nx - nowS()))})</span>` : 'Aucune exécution prévue.'}</div>
      ${on && s.action === 'wol' && !agentHas('wol') ? '<div class="sched-meta" style="color:var(--warn)">⚠ L’agent actuel ne sait pas allumer les PC : nécessite l’agent 1.4.0.</div>' : ''}
      ${on && unconfirmed(s) ? `<div class="sched-meta" style="color:var(--warn)">⚠ ${nums(s.ports).length} ports d’un coup sans seconde confirmation : elle ne sera pas exécutée. Modifie-la et enregistre-la en tapant CONFIRMER.</div>` : ''}
      ${missed(s) ? `<div class="sched-meta" style="color:var(--warn)">⚠ Pas exécutée à l’heure prévue (${esc(whenText(prevRun(s)))}). Si cela se répète, vérifie que le passage automatique du serveur (QStash, toutes les 5 min) fonctionne.</div>` : ''}
      ${lastHtml(s)}
    </div>`;
  }
  function listHtml() {
    const l = list().sort((a, b) => String(a.time).localeCompare(String(b.time)) || String(a.name).localeCompare(String(b.name), 'fr'));
    const z = tz();
    let local = ''; try { local = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    return `<p class="note" style="margin:0 0 10px">Exécutées à 5 minutes près, par le serveur, même si personne n’a le dashboard ouvert${z !== local ? ` (heures de ${esc(z)})` : ''}. Si l’agent est hors ligne à l’heure prévue, l’action n’est pas faite et une alerte te prévient.</p>
      ${agentOffline() && l.some((s) => s.enabled !== false) ? '<div class="alert amber">L’agent est hors ligne en ce moment : les actions prévues ne seront pas exécutées tant qu’il ne répond pas.</div>' : ''}
      ${l.length ? `<div class="sched-list">${l.map(itemHtml).join('')}</div>`
        : '<div class="empty" style="padding:18px 0">Aucune action planifiée. Exemple : couper les ports des élèves à 18:00 et les rallumer à 07:45, du lundi au vendredi.</div>'}
      ${listError ? `<div class="alert red" style="margin:10px 0 0"><b>Refusé par le serveur.</b> ${esc(listError)}</div>` : ''}
      <div class="actions"><span class="note" style="margin-right:auto;align-self:center">${l.length} / ${MAX}</span>
        <button type="button" class="btn" data-sched="close">Fermer</button>
        <button type="button" class="btn primary" data-sched="new"${l.length >= MAX ? ' disabled title="30 planifications au maximum"' : ''}>+ Nouvelle</button></div>`;
  }
  // Redessinée aussi à chaque lecture de l'état (passive : « dans N min » change chaque minute), mais jamais pendant un
  // appui (le clic serait perdu ; 5 s au plus si le relâchement n'est pas vu). Le bouton qui avait le focus le retrouve.
  function renderList(passive) {
    if (!dlg?.open || view !== 'list' || (passive && Date.now() - pressing < 5000)) return;
    const f = document.activeElement, a = f && body.contains(f) ? f.dataset?.sched : '', id = a ? f.dataset.id : '';
    setHTML(body, listHtml());
    const n = a ? body.querySelector(id ? `[data-sched="${a}"][data-id="${CSS.escape(id)}"]` : `[data-sched="${a}"]`) : null;
    if (n && n !== f) n.focus();
  }
  function showList() {
    view = 'list'; draft = null; dropNote = '';
    dlg.querySelector('#schTitle').textContent = 'Actions planifiées';
    body._html = null; setHTML(body, listHtml());
  }

  // ---------------------------------------------------------------- éditeur
  function blank(preset) {
    const d = { id: newId(), name: '', enabled: true, days: new Set([1, 2, 3, 4, 5]), time: '18:00', action: 'shutdown', ports: new Set(), isNew: true };
    if (!preset || typeof preset !== 'object') return d;
    if (typeof preset.name === 'string') d.name = cleanName(preset.name);
    if (Object.hasOwn(ACT, preset.action)) d.action = preset.action;
    if (TIME.test(preset.time || '')) d.time = preset.time;
    if (Array.isArray(preset.days)) d.days = new Set(preset.days.filter((n) => Number.isInteger(n) && n >= 1 && n <= 7));
    if (Array.isArray(preset.ports)) {
      d.ports = new Set(preset.ports.map((p) => (typeof p === 'number' ? `1/1/${p}` : String(p))).filter((p) => PORT.test(p) && !lockOf(d.action, p)));
    }
    return d;
  }
  function editorShell() {
    return `<div class="field"><label for="schName">Nom</label><input id="schName" type="text" maxlength="60" autocomplete="off" placeholder="ex. Coupure du soir"></div>
      <div class="sched-grid">
        <div class="field"><label for="schAction">Action</label><select id="schAction">${Object.entries(ACT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div class="field"><label for="schTime">Heure</label><input id="schTime" type="time" step="60" required></div>
      </div>
      <div class="field"><span class="label">Jours<span class="sched-short"><button type="button" class="btn small" data-sched="weekdays">Jours de semaine</button><button type="button" class="btn small" data-sched="alldays">Tous les jours</button></span></span>
        <div class="sched-days" id="schDays" role="group" aria-label="Jours"></div></div>
      <div class="field"><span class="label">Ports<span class="sched-short"><button type="button" class="btn small" data-sched="students" title="Ports cuivre, hors liens vers d’autres switches et port du PC de l’agent">Ports d’élèves</button><button type="button" class="btn small" data-sched="noports">Aucun</button></span></span>
        <div class="portpick" id="schPorts" role="group" aria-label="Ports"></div>
        <span class="note" id="schPortsNote"></span></div>
      <label class="check" style="margin-bottom:10px"><input type="checkbox" id="schOn"> Active (décoche pour la suspendre sans la supprimer)</label>
      <div id="schInfo"></div>
      <div class="alert red" id="schErr" hidden></div>
      <div class="actions"><button type="button" class="btn" data-sched="back">Retour</button><button type="button" class="btn primary" data-sched="save">Enregistrer</button></div>`;
  }
  function edit(id, preset) {
    const s = id ? list().find((x) => x.id === id) : null;
    if (id && !s) return showList(); // supprimée entre-temps
    draft = s ? { id: s.id, name: String(s.name || ''), enabled: s.enabled !== false, days: new Set(arr(s.days)), time: TIME.test(s.time || '') ? s.time : '18:00',
      action: Object.hasOwn(ACT, s.action) ? s.action : 'shutdown', ports: new Set(arr(s.ports).filter((p) => PORT.test(p))), isNew: false, confirmed: s.confirmed } : blank(preset);
    view = 'edit'; dropNote = '';
    dlg.querySelector('#schTitle').textContent = s ? `Modifier « ${s.name} »` : 'Nouvelle action planifiée';
    body.innerHTML = editorShell(); body._html = null;
    const q = (sel) => body.querySelector(sel);
    q('#schName').value = draft.name; q('#schTime').value = draft.time; q('#schAction').value = draft.action; q('#schOn').checked = draft.enabled;
    enhanceSelects(body);
    renderDraft();
    setTimeout(() => { if (view === 'edit') q('#schName')?.focus(); }, 30);
  }
  // Un port choisi qui devient interdit (autre action, ou état du switch qui change) est retiré, avec une note.
  function dropLocked(agent) {
    const gone = [...draft.ports].filter((p) => lockOf(draft.action, p, agent));
    if (!gone.length) return;
    gone.forEach((p) => draft.ports.delete(p));
    dropNote = `Retiré${gone.length > 1 ? 's' : ''} : ${gone.map((p) => `${portNum(p)} (${lockOf(draft.action, p, agent)})`).join(', ')}.`;
  }
  function renderDraft() {
    if (view !== 'edit' || !draft || !body) return;
    const q = (sel) => body.querySelector(sel), agent = agentPorts();
    dropLocked(agent);
    setHTML(q('#schDays'), DAY_L.map((l, i) => {
      const on = draft.days.has(i + 1);
      return `<button type="button" class="chip${on ? ' on' : ''}" data-sday="${i + 1}" aria-pressed="${on}" title="${DAY_F[i]}" aria-label="${DAY_F[i]}">${l}</button>`;
    }).join(''));
    const locked = [];
    setHTML(q('#schPorts'), Array.from({ length: 28 }, (_, i) => {
      const p = `1/1/${i + 1}`, lock = lockOf(draft.action, p, agent), on = draft.ports.has(p);
      if (lock) locked.push(`${i + 1} (${lock})`);
      const tip = [`Port ${i + 1}`, portOf(p)?.desc, lock].filter(Boolean).join(' · ');
      return `<button type="button" class="chip${on ? ' on' : ''}${lock ? ' sched-lock' : ''}" data-sport="${p}" aria-pressed="${on}" title="${esc(tip)}"${lock ? ' disabled' : ''}>${i + 1}</button>`;
    }).join(''));
    const sel = [...draft.ports];
    let known = '';
    if (draft.action === 'wol' && sel.length) {
      const has = sel.filter((p) => (typeof ADMIN.lastMac === 'function' && ADMIN.lastMac(p)) || arr(S?.macs).some((m) => m?.port === p)).length;
      known = ` Adresse connue pour ${has} sur ${sel.length}.`;
    }
    setHTML(q('#schPortsNote'), esc(`${sel.length ? `${sel.length} choisi${sel.length > 1 ? 's' : ''} : ${portsText(sel)}.` : 'Aucun port choisi.'}${known}${locked.length ? ` Grisés : ${locked.join(', ')}.` : ''}${dropNote ? ` ${dropNote}` : ''}`));
    const nx = draft.days.size && TIME.test(draft.time) ? nextRun({ time: draft.time, days: [...draft.days] }) : null;
    const ask = isBulk(draft.action, sel) && draft.confirmed !== sigOf(draft.action, sel);
    setHTML(q('#schInfo'), `<p class="note" style="margin:0 0 8px">${esc(HELP[draft.action])}</p>
      ${ask ? `<div class="alert amber">${sel.length} ports ${draft.action === 'bounce' ? 'redémarrés' : 'coupés'} d’un coup : l’enregistrement demandera une seconde confirmation (tape CONFIRMER).</div>` : ''}
      ${draft.action === 'wol' && !agentHas('wol') ? '<div class="alert amber">L’agent actuel ne sait pas allumer les PC : le Wake-on-LAN nécessite l’agent 1.4.0. Mets-le à jour, sinon l’action ne sera pas exécutée (une alerte te le signalera).</div>' : ''}
      <div class="alert ${nx ? 'green' : 'amber'}">${nx ? `${draft.enabled ? 'Prochaine exécution' : 'Serait exécutée'} : <b>${esc(whenText(nx))}</b> (${esc(inText(nx - nowS()))}), à 5 minutes près, par le serveur, même si personne n’a le dashboard ouvert.`
        : 'Choisis une heure et au moins un jour.'}</div>`);
  }
  function setAction(a) {
    if (!draft || !Object.hasOwn(ACT, a)) return;
    draft.action = a; dropNote = '';
    renderDraft();
  }
  function showErr(msg) {
    const el = body?.querySelector('#schErr'); if (!el) return;
    el.hidden = !msg; el.innerHTML = msg ? `<b>Impossible d’enregistrer.</b> ${esc(msg)}` : '';
    if (msg) el.scrollIntoView({ block: 'nearest' });
  }
  function check(d) {
    if (!cleanName(d.name)) return ['Donne un nom à cette planification (ex. Coupure du soir).', '#schName'];
    if (!TIME.test(d.time)) return ['Choisis une heure (format HH:MM, ex. 07:45).', '#schTime'];
    if (!d.days.size) return ['Choisis au moins un jour.'];
    if (!d.ports.size) return ['Choisis au moins un port.'];
    if (d.isNew && list().length >= MAX) return [`${MAX} planifications au maximum : supprime-en une d’abord.`];
    return null;
  }

  // ---------------------------------------------------------------- seconde confirmation (8 ports ou plus)
  // Fenêtre posée sur celle des planifications : raisons données par le serveur, saisie de CONFIRMER.
  // Promesse : true si l'administrateur confirme, false s'il annule (bouton, Échap).
  function askDanger(reasons, expired) {
    if (!cf) {
      cf = document.createElement('dialog');
      cf.className = 'sched-cf';
      cf.setAttribute('aria-labelledby', 'schCfTitle');
      cf.innerHTML = `<h3 id="schCfTitle">Seconde confirmation</h3>
        <p class="note" style="margin:0">L’action sera faite par le serveur à l’heure prévue, sans autre confirmation, même si personne ne regarde le dashboard.</p>
        <div class="danger"><div class="danger-head">⚠ Planification sensible : seconde confirmation obligatoire</div>
          <ul id="schCfReasons"></ul>
          <label for="schCfWord">Pour l’enregistrer quand même, tape <b>CONFIRMER</b> :</label>
          <input id="schCfWord" type="text" autocomplete="off" spellcheck="false" autocapitalize="characters"></div>
        <div class="actions"><button type="button" class="btn" data-cf="no">Annuler</button><button type="button" class="btn dangerous" data-cf="yes" disabled>Enregistrer quand même</button></div>`;
      document.body.append(cf);
      const yes = cf.querySelector('[data-cf="yes"]'), word = cf.querySelector('#schCfWord');
      word.addEventListener('input', () => { yes.disabled = word.value.trim().toUpperCase() !== 'CONFIRMER'; });
      word.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !yes.disabled) { e.preventDefault(); yes.click(); } });
      cf.addEventListener('click', (e) => { const b = e.target.closest('[data-cf]'); if (b && !b.disabled) { cf._ok = b.dataset.cf === 'yes'; cf.close(); } });
      cf.addEventListener('close', () => { const done = cf._done; cf._done = null; done?.(cf._ok === true); });
    }
    const word = cf.querySelector('#schCfWord');
    cf.querySelector('#schCfReasons').innerHTML = arr(reasons).map((r) => `<li>${esc(r)}</li>`).join('');
    word.value = ''; cf.querySelector('[data-cf="yes"]').disabled = true; cf._ok = false;
    if (expired) toast('Délai de confirmation dépassé', { type: 'warn', sub: 'Tape à nouveau CONFIRMER.' });
    return new Promise((resolve) => { cf._done = resolve; if (!cf.open) cf.showModal(); setTimeout(() => word.focus(), 30); });
  }

  // ---------------------------------------------------------------- enregistrement (toute la liste)
  async function commit(all, btn, onErr) {
    return busy(btn, async () => {
      let extra = {};
      for (let i = 0; i < 4; i++) {
        try {
          const d = await api('/api/settings', { action: 'schedules-save', schedules: all, ...extra });
          if (Array.isArray(d?.schedules)) X.schedules = d.schedules;
          listError = ''; refreshBadge();
          return true;
        } catch (e) {
          if (e.message === '401') return false;
          // Coupure ou redémarrage de 8 ports ou plus : le serveur demande CONFIRMER (jeton à usage unique, 2 min).
          if (e.status === 409 && e.data?.danger && e.data.token) {
            if (!(await askDanger(e.data.reasons, Boolean(extra.danger_token)))) {
              toast('Rien n’a été enregistré', { type: 'info', sub: 'Seconde confirmation annulée.', timeout: 4000 });
              return false;
            }
            extra = { danger_token: e.data.token, confirm: 'CONFIRMER' };
            continue;
          }
          onErr(e.message);
          toast('Enregistrement refusé', { type: 'error', sub: e.message, timeout: 9000 });
          return false;
        }
      }
      onErr('La seconde confirmation n’a pas été prise en compte : réessaie.');
      return false;
    });
  }
  async function save(btn) {
    const bad = check(draft);
    if (bad) { showErr(bad[0]); if (bad[1]) body.querySelector(bad[1])?.focus(); return; }
    showErr('');
    const item = { id: draft.id, name: cleanName(draft.name), enabled: draft.enabled, days: [...draft.days].sort((a, b) => a - b), time: draft.time,
      action: draft.action, ports: [...draft.ports].sort((a, b) => portNum(a) - portNum(b)) };
    const all = list().map(strip), i = all.findIndex((s) => s.id === item.id);
    if (i >= 0) all[i] = item; else all.push(item);
    const created = draft.isNew;
    if (!(await commit(all, btn, showErr))) return;
    const nx = item.enabled ? nextRun(item) : null;
    toast(created ? 'Action planifiée créée' : 'Action planifiée modifiée', { type: 'success', sub: `${item.name} : ${item.enabled ? (nx ? `prochaine exécution ${whenText(nx)}` : 'aucune exécution prévue') : 'suspendue'}.` });
    if (dlg.open) showList();
  }
  async function toggle(id, btn) {
    const all = list().map(strip), s = all.find((x) => x.id === id);
    if (!s) return;
    s.enabled = !s.enabled;
    const ok = await commit(all, btn, (m) => { listError = m; });
    if (ok) toast(s.enabled ? `« ${s.name} » réactivée` : `« ${s.name} » suspendue`, { type: 'success', timeout: 2500 });
    renderList();
  }
  async function del(id, btn) {
    clearTimeout(delTimer);
    if (delAsk !== id) { // premier clic : demande de confirmation sur le bouton lui-même
      delAsk = id; renderList();
      body?.querySelector(`[data-sched="del"][data-id="${CSS.escape(id)}"]`)?.focus();
      delTimer = setTimeout(() => { delAsk = null; renderList(true); }, 4000);
      return;
    }
    delAsk = null;
    const all = list().map(strip), s = all.find((x) => x.id === id);
    if (s && (await commit(all.filter((x) => x.id !== id), btn, (m) => { listError = m; }))) toast(`« ${s.name} » supprimée`, { type: 'success', timeout: 2500 });
    renderList();
  }

  // ---------------------------------------------------------------- fenêtre
  function onClick(e) {
    const b = e.target.closest('button');
    if (!b || !dlg.contains(b) || b.disabled) return;
    if (b.dataset.sday && draft) { const n = Number(b.dataset.sday); draft.days.has(n) ? draft.days.delete(n) : draft.days.add(n); renderDraft(); return; }
    if (b.dataset.sport && draft) { const p = b.dataset.sport; draft.ports.has(p) ? draft.ports.delete(p) : draft.ports.add(p); dropNote = ''; renderDraft(); return; }
    const a = b.dataset.sched;
    if (a === 'close') dlg.close();
    else if (a === 'new') { listError = ''; edit(null); }
    else if (a === 'edit') { listError = ''; edit(b.dataset.id); }
    else if (a === 'toggle') toggle(b.dataset.id, b);
    else if (a === 'del') del(b.dataset.id, b);
    else if (a === 'back') showList();
    else if (a === 'save') save(b);
    else if (draft && a === 'weekdays') { draft.days = new Set([1, 2, 3, 4, 5]); renderDraft(); }
    else if (draft && a === 'alldays') { draft.days = new Set([1, 2, 3, 4, 5, 6, 7]); renderDraft(); }
    else if (draft && a === 'students') { draft.ports = new Set(studentPorts(draft.action)); dropNote = ''; renderDraft(); }
    else if (draft && a === 'noports') { draft.ports = new Set(); dropNote = ''; renderDraft(); }
  }
  function onInput(e) {
    if (view !== 'edit' || !draft) return;
    const t = e.target;
    if (t.id === 'schName') draft.name = t.value;
    else if (t.id === 'schTime') { draft.time = String(t.value || '').slice(0, 5); renderDraft(); }
    else if (t.id === 'schOn') { draft.enabled = t.checked; renderDraft(); }
    else if (t.id === 'schAction') setAction(t.value);
  }
  function ensureDlg() {
    if (dlg) return;
    dlg = document.createElement('dialog');
    dlg.className = 'wide sched-dlg';
    dlg.setAttribute('aria-labelledby', 'schTitle');
    dlg.innerHTML = '<h3 id="schTitle">Actions planifiées</h3><div id="schBody"></div>';
    document.body.append(dlg);
    body = dlg.querySelector('#schBody');
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onInput);
    // Échap dans l'éditeur : retour à la liste plutôt que fermeture (évite de perdre la saisie d'un coup).
    dlg.addEventListener('cancel', (e) => { if (view === 'edit') { e.preventDefault(); showList(); } });
    dlg.addEventListener('close', () => { view = 'list'; draft = null; delAsk = null; listError = ''; pressing = 0; if (cf?.open) cf.close(); markSeen(); });
    // Pas de redessin passif entre l'appui et le relâchement (le clic part juste après le relâchement).
    dlg.addEventListener('pointerdown', () => { pressing = Date.now(); });
    const release = () => { if (pressing) setTimeout(() => { pressing = 0; }, 0); };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  }
  function open(id, preset) {
    if (!canAdmin()) return;
    ensureDlg();
    listError = '';
    if (id || preset) edit(id, preset); else showList();
    if (!dlg.open) dlg.showModal();
    markSeen();
  }

  // ---------------------------------------------------------------- badge « échec » sur le bouton de l'outil
  const tool = { id: 'schedule', label: 'Planification', icon: ICON, title: 'Actions planifiées : couper, rallumer ou redémarrer des ports, allumer les PC à heure fixe', open: () => open() };
  let seen = 0;
  try { seen = Number(localStorage.getItem('sched-seen')) || 0; } catch {}
  function markSeen() { seen = nowS(); try { localStorage.setItem('sched-seen', String(seen)); } catch {} refreshBadge(); }
  function refreshBadge() {
    const now = nowS();
    const n = canAdmin() ? list().filter((s) => ['error', 'skipped', 'late'].includes(s.lastStatus) && Number(s.last) > Math.max(seen, now - 86400)).length : 0;
    const badge = n ? `${n} échec${n > 1 ? 's' : ''}` : '';
    if ((tool.badge || '') !== badge) { tool.badge = badge; renderTools(); }
  }

  addTool(tool);
  HOOK.poll.push((d) => {
    if (typeof d?.now === 'number') skew = d.now - Date.now() / 1000;
    refreshBadge();
    if (!dlg?.open) return;
    if (view === 'list') renderList(true); else renderDraft();
  });
  HOOK.role.push((ro) => { if (ro && dlg?.open) dlg.close(); refreshBadge(); });
  // Volet d'un port : planifications qui le concernent (vue admin seulement).
  HOOK.panel.push((p) => {
    if (!canAdmin() || !p?.port) return '';
    const mine = list().filter((s) => arr(s.ports).includes(p.port));
    if (!mine.length) return '';
    return `<div class="section"><h3>Actions planifiées</h3>
      ${mine.map((s) => `<div class="sched-pp${s.enabled !== false ? '' : ' off'}"><b>${esc(s.name)}</b><span class="note">${esc(TAG[s.action] || s.action)} à ${esc(s.time)}, ${esc(daysText(s.days))}${s.enabled !== false ? '' : ' (suspendue)'}</span></div>`).join('')}
      <div><button type="button" class="btn small" data-sched-open="1">Gérer les actions planifiées</button></div></div>`;
  });
  $('#ppBody')?.addEventListener('click', (e) => { if (e.target.closest('[data-sched-open]')) open(); });

  // Fonctions partagées avec les autres extensions.
  ADMIN.schedules = () => list().map((s) => ({ ...s, days: [...arr(s.days)], ports: [...arr(s.ports)] }));
  ADMIN.openSchedules = (preset) => open(null, preset && typeof preset === 'object' ? preset : null);
  ADMIN.nextRun = (s) => (s && s.enabled !== false ? nextRun(s) : null);
})();
