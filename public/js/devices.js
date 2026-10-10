// Annuaire des appareils, plan de brassage, export CSV et impression (fonction d'administration « devices »).
// Données du serveur (lib/features/devices.js) : X.names { mac: { name, t } }, X.plan { port: { jack, room, note } },
// X.lastmac { port: { mac, t, on, ip?, host? } } ; registre complet par api('/api/output?part=devices').
// Fournit ADMIN.deviceName(mac), ADMIN.lastMac(port), ADMIN.lastSeen(port), ADMIN.portPlan(port), ADMIN.portsCSV().
// IIFE en mode strict : aucune fonction de ce fichier ne peut remplacer une fonction globale de la page.
(() => {
  'use strict';
  const LIMITS = { name: 60, jack: 40, room: 60, note: 200, desc: 64 };
  const MAX_PORT_MACS = 8; // comme le serveur : au-delà, le port mène à un switch pas encore reconnu ou à un point d'accès
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const str = (v) => (typeof v === 'string' ? v : '');
  const dash = '<span class="muted">-</span>';

  // « AA-BB-CC-DD-EE-FF », « aabb.ccdd.eeff »… -> « aa:bb:cc:dd:ee:ff » (null si invalide), comme le serveur.
  function normMac(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    if (!/^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$|^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$|^[0-9a-f]{6}-[0-9a-f]{6}$/.test(s)) return null;
    const hex = s.replace(/[^0-9a-f]/g, '');
    if (parseInt(hex.slice(0, 2), 16) & 1 || /^0{12}$/.test(hex)) return null;
    return hex.match(/../g).join(':');
  }
  // Texte saisi : une seule ligne, sans caractère de contrôle ni « # » en tête (même règle que le serveur).
  const cleanText = (v) => String(v ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[#\s]+/, '');
  // Description envoyée au switch : en plus, sans « ? » (aide de la console du switch) et 64 caractères au plus.
  const descText = (v) => cleanText(String(v ?? '').replace(/\?/g, ' ')).slice(0, LIMITS.desc).trim();

  const names = () => obj(X.names), plan = () => obj(X.plan), lastmac = () => obj(X.lastmac);
  function deviceName(mac) {
    const m = normMac(mac), v = m && names()[m];
    return v && typeof v.name === 'string' && v.name ? v.name : null;
  }
  function planOf(port) {
    const v = plan()[port];
    if (!v || typeof v !== 'object') return null;
    const o = { jack: str(v.jack), room: str(v.room), note: str(v.note) };
    return o.jack || o.room || o.note ? o : null;
  }
  function lastOf(port) {
    const e = lastmac()[port], mac = e && normMac(e.mac);
    return mac ? { ...e, mac } : null;
  }
  const portOf = (port) => (S?.ports || []).find((p) => p.port === port) || null;
  const toPort = (x) => (typeof x === 'number' || /^\d{1,2}$/.test(String(x)) ? `1/1/${x}` : String(x ?? ''));
  const crowded = (list) => list.length > MAX_PORT_MACS;
  // Adresses présentes sur un port. Rien sur un lien vers un autre switch (les appareils derrière ne sont pas « sur » ce
  // port), ni sur un port qui en porte trop pour être une prise d'appareil (ex. lien montant dont l'agent n'a pas encore
  // relu le voisin LLDP : la table du switch s'y remplit de tout le réseau voisin).
  function macsOn(port) {
    const p = portOf(port);
    if (!p || isUplink(p)) return [];
    const list = [...new Set((S.macs || []).filter((m) => m.port === port).map((m) => normMac(m.mac)).filter(Boolean))];
    return crowded(list) ? [] : list;
  }
  // Adresses présentes sur tout le switch, avec la même règle : mac -> port (une adresse vue sur deux ports : le premier).
  function liveMap() {
    const out = new Map();
    if (!S) return out;
    const ports = (S.ports || []).filter((p) => !isUplink(p)).map((p) => p.port).sort((a, b) => portNum(a) - portNum(b));
    for (const port of ports) for (const mac of macsOn(port)) if (!out.has(mac)) out.set(mac, port);
    return out;
  }
  // Heure à laquelle un appareil absent a été vu pour la dernière fois. Le serveur ne note un départ que si le lien du
  // port tombe (rien n'est écrit quand une adresse vieillit dans la table du switch) : si l'appareil est encore noté
  // branché et que son port est resté établi sans appareil visible (PC en veille), le dernier trafic reçu est plus juste.
  function seenAt(port, t, on) {
    const p = portOf(port), q = Number(p?.rx_quiet_since) || 0;
    return on !== false && p?.up && !isUplink(p) && !macsOn(port).length && q > (Number(t) || 0) ? q : Number(t) || 0;
  }
  const fmtDate = (t, year) => (Number(t) > 0 ? new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', ...(year ? { year: '2-digit' } : {}), hour: '2-digit', minute: '2-digit' }) : '-');
  const slug = (s) => String(s || 'switch').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'switch';
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ---------------------------------------------------------------- fonctions partagées
  ADMIN.deviceName = deviceName;
  // Dernier appareil vu sur un port : celui qui y est branché, sinon le dernier noté par le serveur (null : aucun).
  ADMIN.lastMac = (port) => {
    port = toPort(port);
    const p = portOf(port);
    if (p && isUplink(p)) return null;
    const live = macsOn(port), last = lastOf(port)?.mac || null;
    return live.length ? (live.includes(last) ? last : live[0]) : last;
  };
  // Heure (s) à laquelle un appareil a été vu pour la dernière fois sur un port (NOW s'il y est, null si inconnu) :
  // plus juste que X.lastmac[port].t pour un PC en veille dont le lien reste établi (voir seenAt).
  ADMIN.lastSeen = (port) => {
    port = toPort(port);
    const p = portOf(port), last = lastOf(port);
    if (p && isUplink(p)) return null;
    if (macsOn(port).length) return NOW || null;
    const t = last ? seenAt(port, last.t, last.on) : 0;
    return t > 0 ? t : null;
  };
  ADMIN.portPlan = (port) => planOf(toPort(port));
  ADMIN.portsCSV = () => portsCSV();

  // ---------------------------------------------------------------- styles
  const css = document.createElement('style');
  css.textContent = `
.dev-dlg { width: min(1100px, calc(100% - 32px)); max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); }
.dev-dlg.dev-mid { width: min(780px, calc(100% - 32px)); }
.dev-dlg[open] { display: flex; flex-direction: column; gap: 12px; }
.dev-dlg h3 { margin: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dev-dlg h3 .muted { font-size: 12.5px; font-weight: 500; }
.dev-dlg .actions { margin-top: 0; }
.dev-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dev-bar input[type=search] { flex: 1 1 220px; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); outline: none; }
.dev-bar input[type=search]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgb(255 131 0 / .18); }
.dev-scroll { overflow: auto; flex: 1 1 auto; min-height: 140px; border: 1px solid var(--border); border-radius: 10px; }
.dev-table th, .dev-plan th { position: sticky; top: 0; background: var(--surface); z-index: 1; }
.dev-table td { vertical-align: middle; }
.dev-table .sub, .dev-plan .sub { display: block; font-size: 12px; color: var(--text-3); }
.dev-table input.dev-name { min-width: 170px; padding: 5px 8px; font-size: 13px; }
.dev-table input.dev-name.dirty, .dev-sec input.dev-dirty { border-color: var(--warn); }
.dev-table tr.dev-gone td { color: var(--text-2); }
.dev-plan td { white-space: normal; }
.dev-sec .field { margin: 0; }
.dev-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dev-mac { font-size: 12.5px; overflow-wrap: anywhere; }
.dev-block { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.dev-block .row { flex-wrap: wrap; }
.dev-prev { max-height: 38vh; }
@media (max-width: 560px) { .dev-dlg { padding: 16px; } .dev-grid { grid-template-columns: 1fr; } }
#devPrintArea { display: none; }
@media print {
  body.dev-printing { background: #fff !important; }
  body.dev-printing > :not(#devPrintArea) { display: none !important; }
  body.dev-printing #devPrintArea { display: block; color: #000; background: #fff; font: 10.5pt/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #devPrintArea h1 { font-size: 15pt; margin: 0 0 2mm; }
  #devPrintArea p { margin: 0 0 4mm; color: #333; }
  #devPrintArea table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  #devPrintArea th, #devPrintArea td { border: 1px solid #888; padding: 3px 6px; color: #000; background: #fff; text-align: left; white-space: normal; vertical-align: top; }
  #devPrintArea th { background: #eee; font-weight: 600; }
  #devPrintArea thead { display: table-header-group; }
  #devPrintArea tr { break-inside: avoid; }
}`;
  document.head.append(css);

  // ---------------------------------------------------------------- nom affiché d'un port
  // Appareil nommé branché : son nom remplace celui affiché (l'ancien passe en sous-titre). Port vide : « dernier vu ».
  HOOK.portName.push((p, { name, sub, macs }) => {
    if (!S || isUplink(p)) return null;
    let list = [...new Set(arr(macs).map(normMac).filter(Boolean))];
    if (crowded(list)) list = [];
    const named = list.find((m) => deviceName(m));
    const jack = planOf(p.port)?.jack;
    const withJack = (s) => [s, jack && `prise ${jack}`].filter(Boolean).join(' · ');
    if (p.up && named) {
      const nm = deviceName(named);
      const old = name && name !== nm && name !== 'Appareil sans nom' ? name : '';
      return { name: nm, sub: withJack([old, sub].filter(Boolean).join(' · ')) };
    }
    if (!p.up || !list.length) {
      const last = lastOf(p.port), nm = (last && deviceName(last.mac)) || (named && deviceName(named));
      // remplace le « dernier appareil vu » du voisin LLDP par le nom donné
      if (nm) return { sub: withJack([`dernier vu : ${nm}`, ...String(sub || '').split(' · ').filter((s) => s && !s.startsWith('dernier appareil vu : '))].join(' · ')) };
    }
    return jack ? { sub: withJack(sub) } : null;
  });

  // ---------------------------------------------------------------- info-bulle de la façade
  // Complète le title des ports (appareil nommé, prise, salle). Le texte d'origine est gardé dans data-dev-base :
  // tant que la façade n'est pas redessinée, on repart de lui (pas d'ajout en double).
  function tipExtra(port) {
    const p = portOf(port);
    if (!p) return '';
    const pl = planOf(port), up = isUplink(p);
    const named = up || !p.up ? null : macsOn(port).map(deviceName).find(Boolean);
    const last = !up && !named && !macsOn(port).length ? lastOf(port) : null, lastName = last && deviceName(last.mac);
    return [named && `appareil : ${named}`, lastName && `dernier vu : ${lastName}`, pl?.jack && `prise ${pl.jack}`, pl?.room && `salle ${pl.room}`].filter(Boolean).join(' · ');
  }
  HOOK.faceplate.push(() => {
    if (!S) return;
    for (const b of document.querySelectorAll('#faceplate [data-port]')) {
      if (b.dataset.devBase === undefined) b.dataset.devBase = b.getAttribute('title') || '';
      const t = [b.dataset.devBase, tipExtra(b.dataset.port)].filter(Boolean).join(' · ');
      if (b.getAttribute('title') !== t) { b.setAttribute('title', t); b.setAttribute('aria-label', t); }
    }
  });

  // ---------------------------------------------------------------- volet d'un port
  // Appareil branché (nommé) ou dernier vu, pour l'affichage en lecture seule.
  function deviceLine(p) {
    if (isUplink(p)) return null;
    const live = macsOn(p.port);
    const named = live.map(deviceName).find(Boolean);
    if (named) return { label: 'Appareil', html: esc(named) };
    if (live.length) return null;
    const last = lastOf(p.port);
    if (!last) return null;
    const who = deviceName(last.mac) || last.host || last.ip || last.mac, t = seenAt(p.port, last.t, last.on);
    return { label: 'Dernier appareil vu', html: `${esc(who)}${t > 0 ? ` <span class="muted">(${esc(fmtDate(t))})</span>` : ''}` };
  }
  function panelView(p) {
    const pl = planOf(p.port), who = deviceLine(p);
    if (!pl && !who) return '';
    return `<div class="section dev-sec"><h3>Plan de brassage</h3><dl>
      ${pl?.jack ? `<dt>Prise murale</dt><dd>${esc(pl.jack)}</dd>` : ''}${pl?.room ? `<dt>Salle</dt><dd>${esc(pl.room)}</dd>` : ''}
      ${pl?.note ? `<dt>Note</dt><dd>${esc(pl.note)}</dd>` : ''}${who ? `<dt>${who.label}</dt><dd>${who.html}</dd>` : ''}
    </dl></div>`;
  }
  // Saisies du volet pas encore enregistrées, pour le port affiché, et appareil choisi dans la liste : le volet entier
  // (#ppExt) est redessiné dès qu'une de ses sections change (enregistrement de l'autre formulaire, nouvel état, autre
  // extension) ; elles sont reprises dans le HTML au lieu d'être perdues.
  let draft = { port: null, plan: {}, names: {}, pick: null };
  const draftFor = (port) => (draft.port === port ? draft : (draft = { port, plan: {}, names: {}, pick: null }));
  const dirty = (v) => (v !== undefined ? ' class="dev-dirty"' : '');
  // Vue administrateur : formulaires. HTML déterministe (pas d'heure relative) : le volet n'est redessiné que si
  // quelque chose change vraiment.
  function panelAdmin(p) {
    const saved = planOf(p.port), pl = saved || { jack: '', room: '', note: '' }, port = esc(p.port), dr = draftFor(p.port);
    const pv = (k) => esc(dr.plan[k] ?? pl[k]);
    const planHtml = `<div class="section dev-sec">
      <h3>Plan de brassage</h3>
      <div class="dev-grid">
        <div class="field"><label for="devJack">Prise murale</label><input id="devJack" type="text" maxlength="${LIMITS.jack}" value="${pv('jack')}" placeholder="ex. B12" autocomplete="off"${dirty(dr.plan.jack)}></div>
        <div class="field"><label for="devRoom">Salle</label><input id="devRoom" type="text" maxlength="${LIMITS.room}" value="${pv('room')}" placeholder="ex. N11" autocomplete="off"${dirty(dr.plan.room)}></div>
      </div>
      <div class="field"><label for="devNote">Note</label><input id="devNote" type="text" maxlength="${LIMITS.note}" value="${pv('note')}" placeholder="ex. bureau du professeur, sous la fenêtre" autocomplete="off"${dirty(dr.plan.note)}></div>
      <div class="row"><button class="btn" type="button" data-dev="plan-save" data-dev-port="${port}">Enregistrer</button>${saved ? `<button class="btn small" type="button" data-dev="plan-clear" data-dev-port="${port}">Effacer</button>` : ''}</div>
    </div>`;
    if (isUplink(p)) return planHtml;
    const ips = obj(S.ips), live = macsOn(p.port), last = lastOf(p.port);
    const cands = live.length ? live.map((mac) => ({ mac, ip: str(obj(ips[mac]).ip), host: str(obj(ips[mac]).name), live: true }))
      : last ? [{ mac: last.mac, ip: str(last.ip), host: str(last.host), live: false, t: last.t }] : [];
    let body;
    if (!cands.length) body = '<p class="note" style="margin:0">Aucun appareil vu sur ce port pour l’instant.</p>';
    else {
      const c0 = cands[0], pick = cands.find((c) => c.mac === dr.pick) || c0, label = (c) => [c.mac, c.ip, c.host].filter(Boolean).join(' · ');
      const t = c0.live ? 0 : seenAt(p.port, c0.t, last?.on);
      body = `<p class="note" style="margin:0">${c0.live ? (cands.length > 1 ? `${cands.length} appareils branchés en ce moment.` : 'Branché en ce moment.') : `Dernier appareil vu sur ce port${t > 0 ? ` (${esc(fmtDate(t))})` : ''}.`}</p>
        ${cands.length > 1 ? `<div class="field"><label for="devMac">Appareil</label><select id="devMac">${cands.map((c) => `<option value="${esc(c.mac)}"${c === pick ? ' selected' : ''}>${esc(label(c))}${deviceName(c.mac) ? ` · ${esc(deviceName(c.mac))}` : ''}</option>`).join('')}</select></div>`
          : `<div class="mono dev-mac">${esc(label(c0))}</div><input type="hidden" id="devMac" value="${esc(c0.mac)}">`}
        <div class="field"><label for="devName">Nom</label><div class="row"><input id="devName" type="text" maxlength="${LIMITS.name}" value="${esc(dr.names[pick.mac] ?? deviceName(pick.mac) ?? '')}" placeholder="ex. Poste professeur" autocomplete="off"${dirty(dr.names[pick.mac])}><button class="btn" type="button" data-dev="name-save">Enregistrer</button></div></div>
        <div class="row"><button class="btn small" type="button" data-dev="name-desc" data-dev-port="${port}" title="Écrit ce nom comme description du port, sur le switch">Utiliser comme description du port</button></div>`;
    }
    return `${planHtml}<div class="section dev-sec"><h3>Nommer l’appareil</h3>${body}</div>`;
  }
  HOOK.panel.push((p) => (!p?.port || !S ? '' : canAdmin() ? panelAdmin(p) : panelView(p)));

  const pp = $('#ppBody');
  pp.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dev]');
    if (!b || !canAdmin()) return;
    const port = b.dataset.devPort || selected;
    if (b.dataset.dev === 'plan-save' || b.dataset.dev === 'plan-clear') savePlan(b, port, b.dataset.dev === 'plan-clear');
    if (b.dataset.dev === 'name-save') saveName($('#devMac')?.value, $('#devName')?.value ?? '', b);
    if (b.dataset.dev === 'name-desc') nameToDesc(port);
  });
  pp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const act = { devJack: 'plan-save', devRoom: 'plan-save', devNote: 'plan-save', devName: 'name-save' }[e.target.id];
    if (act) { e.preventDefault(); pp.querySelector(`[data-dev="${act}"]`)?.click(); }
  });
  // Saisie : gardée dans draft (comparée à la valeur enregistrée) ; choix d'un autre appareil : son nom ou sa saisie.
  pp.addEventListener('input', (e) => {
    const i = e.target, k = { devJack: 'jack', devRoom: 'room', devNote: 'note' }[i.id];
    if (draft.port !== selected || (!k && i.id !== 'devName')) return;
    let v;
    if (k) {
      if (i.value === (planOf(draft.port)?.[k] || '')) delete draft.plan[k]; else draft.plan[k] = i.value;
      v = draft.plan[k];
    } else {
      const mac = normMac($('#devMac')?.value);
      if (!mac) return;
      if (i.value === (deviceName(mac) || '')) delete draft.names[mac]; else draft.names[mac] = i.value;
      v = draft.names[mac];
    }
    i.classList.toggle('dev-dirty', v !== undefined);
  });
  pp.addEventListener('change', (e) => {
    if (e.target.id !== 'devMac') return;
    const mac = normMac(e.target.value), n = $('#devName');
    if (draft.port === selected) draft.pick = mac;
    if (n) { n.value = draft.names[mac] ?? deviceName(mac) ?? ''; n.classList.toggle('dev-dirty', draft.names[mac] !== undefined); }
  });

  // Un enregistrement à la fois : les réponses arrivent dans l'ordre, aucune ne remet une version plus ancienne des
  // noms ou du plan (le serveur, lui, ne perd aucune modification simultanée).
  let chain = Promise.resolve();
  const inTurn = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  async function savePlan(btn, port, clear) {
    if (!/^1\/1\/\d{1,2}$/.test(port || '')) return;
    const v = clear ? { jack: '', room: '', note: '' }
      : { jack: cleanText($('#devJack')?.value), room: cleanText($('#devRoom')?.value), note: cleanText($('#devNote')?.value) };
    const over = [['jack', 'Prise murale'], ['room', 'Salle'], ['note', 'Note']].find(([k]) => v[k].length > LIMITS[k]);
    if (over) return toast(`${over[1]} trop longue`, { type: 'warn', sub: `${LIMITS[over[0]]} caractères au maximum.` });
    await busy(btn, async () => {
      try {
        await inTurn(async () => {
          const d = await api('/api/settings', { action: 'port-plan', port, ...v });
          if (d?.plan && typeof d.plan === 'object') X.plan = d.plan;
        });
        if (draft.port === port) draft.plan = {};
        toast(clear || (!v.jack && !v.room && !v.note) ? 'Plan de brassage effacé' : 'Plan de brassage enregistré', { type: 'success', sub: `Port ${portNum(port)}` });
        refresh(true);
      } catch (e) { if (e.message !== '401') toast('Impossible d’enregistrer', { type: 'error', sub: e.message }); }
    });
  }
  // Enregistre (ou efface, si vide) le nom d'un appareil. Renvoie vrai si c'est fait.
  async function saveName(mac, value, btn) {
    const m = normMac(mac);
    if (!m) { toast('Aucun appareil à nommer', { type: 'warn' }); return false; }
    const name = cleanText(value);
    if (name.length > LIMITS.name) { toast('Nom trop long', { type: 'warn', sub: `${LIMITS.name} caractères au maximum.` }); return false; }
    if ((deviceName(m) || '') === name) return true;
    return busy(btn, async () => {
      try {
        await inTurn(async () => {
          const d = await api('/api/settings', { action: 'device-name', mac: m, name });
          if (d?.names && typeof d.names === 'object') X.names = d.names;
        });
        delete draft.names[m];
        toast(name ? 'Nom enregistré' : 'Nom effacé', { type: 'success', sub: name ? `${name} (${m})` : m });
        refresh(true);
        return true;
      } catch (e) {
        if (e.message !== '401') toast('Impossible d’enregistrer le nom', { type: 'error', sub: e.message });
        return false;
      }
    });
  }
  function nameToDesc(port) {
    const p = portOf(port);
    if (!p) return;
    const d = descText($('#devName')?.value || deviceName($('#devMac')?.value) || '');
    if (!d) return toast('Écris d’abord un nom', { type: 'warn' });
    const n = portNum(p.port);
    confirmCmd(`Description du port ${n}`, 'Le nom devient la description du port sur le switch (64 caractères au plus). En mode « Auto », les ports qui ont une description sont surveillés par les alertes.',
      `configure terminal\ninterface ${p.port}\ndescription ${d}\nend`, `Description port ${n}`, { ports: [p.port] });
  }
  // Redessine ce qui affiche des noms ou le plan (façade, tableau, volet, fenêtres ouvertes).
  function refresh(panel) {
    if (S) { renderFaceplate(); renderPorts(); if (panel) renderPanel(true); }
    if (dirDlg?.open) renderDirectory();
    if (expDlg?.open) renderExport();
  }

  // ---------------------------------------------------------------- annuaire
  let dirDlg = null, dirData = null, dirBusy = false, dirErr = '', dirQ = '', dirF = 'all', dirLm = null;
  function dirRows() {
    const reg = obj(dirData), ips = obj(S?.ips), live = liveMap();
    const macs = new Set([...Object.keys(reg), ...live.keys(), ...Object.keys(names())].map(normMac).filter(Boolean));
    return [...macs].map((mac) => {
      const e = obj(reg[mac]), lp = live.get(mac) || '', v = obj(ips[mac]);
      return { mac, name: deviceName(mac) || '', ip: str(v.ip) || str(e.ip), host: str(v.name) || str(e.host), live: Boolean(lp),
        port: lp || str(e.port), first: Number(e.first) || 0, last: lp ? NOW : seenAt(str(e.port), e.last, e.on),
        ports: arr(e.ports).filter((x) => Array.isArray(x) && typeof x[0] === 'string') };
    }).sort((a, b) => b.live - a.live || (a.live ? portNum(a.port) - portNum(b.port) : b.last - a.last) || a.mac.localeCompare(b.mac));
  }
  function rowText(r) {
    const pl = r.port ? planOf(r.port) : null;
    return [r.name, r.mac, r.mac.replace(/:/g, ''), r.ip, r.host, r.port && `port ${portNum(r.port)}`, pl?.jack, pl?.room].filter(Boolean).join(' ').toLowerCase();
  }
  const portHistory = (r) => (r.ports.length > 1 ? `Historique des ports : ${r.ports.map(([p, t]) => `${portNum(p)} (${fmtDate(t, true)})`).join(' → ')}`
    : r.ports.length ? `Vu d’abord sur le port ${portNum(r.ports[0][0])} (${fmtDate(r.ports[0][1], true)})` : '');
  function dirRow(r) {
    const pn = r.port ? portNum(r.port) : null, hist = portHistory(r), pl = r.port ? planOf(r.port) : null;
    const where = [pl?.jack && `prise ${pl.jack}`, pl?.room && `salle ${pl.room}`].filter(Boolean).join(' · ');
    return `<tr class="${r.live ? '' : 'dev-gone'}">
      <td><input class="dev-name" type="text" maxlength="${LIMITS.name}" value="${esc(r.name)}" placeholder="Nommer…" data-mac="${esc(r.mac)}" aria-label="Nom de l’appareil ${esc(r.mac)}" autocomplete="off"></td>
      <td class="mono">${esc(r.mac)}</td>
      <td>${r.ip ? `<span class="mono">${esc(r.ip)}</span>` : ''}${r.host ? `<span class="sub">${esc(r.host)}</span>` : ''}${!r.ip && !r.host ? dash : ''}</td>
      <td title="${esc(hist)}">${pn ? (r.live ? `<span class="status up">Port ${pn}</span>` : `<span class="muted">dernier : port ${pn}</span>`) : dash}${r.ports.length > 1 ? ` <span class="badge">${r.ports.length} ports</span>` : ''}${where ? `<span class="sub">${esc(where)}</span>` : ''}</td>
      <td class="num">${r.first ? esc(fmtDate(r.first, true)) : dash}</td>
      <td class="num">${r.live ? 'maintenant' : r.last ? esc(fmtDate(r.last, true)) : dash}</td>
      <td class="r">${r.live ? '<button type="button" class="btn small" disabled title="Branché en ce moment : il réapparaîtrait aussitôt">Oublier</button>'
        : `<button type="button" class="btn small danger" data-dev-forget="${esc(r.mac)}" title="Retire cet appareil de l’annuaire (et son nom)">Oublier</button>`}</td>
    </tr>`;
  }
  function renderDirectory() {
    if (!dirDlg) return;
    const rows = dirRows(), q = dirQ.trim().toLowerCase();
    const hit = rows.filter((r) => (dirF === 'all' || (dirF === 'live' && r.live) || (dirF === 'named' && r.name) || (dirF === 'gone' && !r.live)) && (!q || rowText(r).includes(q)));
    const live = rows.filter((r) => r.live).length, named = rows.filter((r) => r.name).length;
    $('#devDirCount').textContent = `${rows.length} appareil${rows.length > 1 ? 's' : ''} · ${live} branché${live > 1 ? 's' : ''} · ${named} nommé${named > 1 ? 's' : ''}`;
    const body = $('#devDirRows');
    if (body.querySelector('input.dev-name:focus')) { dirDlg.dataset.pending = '1'; return; } // saisie en cours : on attend
    dirDlg.dataset.pending = '';
    let html = hit.map(dirRow).join('');
    if (!html) html = `<tr><td colspan="7" class="empty">${dirBusy && !dirData ? '<span class="spinner"></span> Chargement de l’annuaire…'
      : q || dirF !== 'all' ? 'Aucun appareil ne correspond.' : 'Aucun appareil vu pour l’instant : l’annuaire se remplit à chaque branchement.'}</td></tr>`;
    if (dirErr) html = `<tr><td colspan="7"><div class="alert red" style="margin:0">Annuaire indisponible : ${esc(dirErr)}</div></td></tr>${html}`;
    // garde les noms tapés mais pas encore enregistrés
    const typed = {};
    for (const i of body.querySelectorAll('input.dev-name.dirty')) typed[i.dataset.mac] = i.value;
    setHTML(body, html);
    for (const [mac, v] of Object.entries(typed)) {
      const i = body.querySelector(`input.dev-name[data-mac="${mac}"]`);
      if (i && i.value !== v) { i.value = v; i.classList.add('dirty'); }
    }
  }
  async function loadDirectory() {
    dirBusy = true; renderDirectory();
    try { const d = await api('/api/output?part=devices'); dirData = obj(d?.devices); dirErr = ''; }
    catch (e) { if (e.message !== '401') dirErr = e.message; }
    finally { dirBusy = false; renderDirectory(); }
  }
  function dirDialog() {
    if (dirDlg) return dirDlg;
    dirDlg = document.createElement('dialog');
    dirDlg.className = 'dev-dlg';
    dirDlg.setAttribute('aria-labelledby', 'devDirTitle');
    dirDlg.innerHTML = `<h3 id="devDirTitle">Annuaire des appareils <span class="muted" id="devDirCount"></span></h3>
      <p class="note" style="margin:0">Tous les appareils vus sur les ports de ce switch (hors liens vers d’autres switches), 500 au plus. Le nom donné s’affiche partout dans le dashboard : Entrée pour l’enregistrer, Échap pour annuler. Survole un port pour son historique.</p>
      <div class="dev-bar">
        <input type="search" id="devDirQ" placeholder="Rechercher un nom, une MAC, une IP, un port…" aria-label="Rechercher un appareil" autocomplete="off">
        <span class="seg" id="devDirF"><button type="button" data-f="all" class="on">Tous</button><button type="button" data-f="live">Branchés</button><button type="button" data-f="named">Nommés</button><button type="button" data-f="gone">Absents</button></span>
        <button type="button" class="btn small" id="devDirCsv">Exporter (CSV)</button>
        <button type="button" class="btn small" id="devDirReload">Actualiser</button>
      </div>
      <div class="dev-scroll"><table class="dev-table"><thead><tr><th>Nom</th><th>MAC</th><th>IP · nom réseau</th><th>Port</th><th>Vu la première fois</th><th>Vu la dernière fois</th><th></th></tr></thead><tbody id="devDirRows"></tbody></table></div>
      <div class="actions"><button type="button" class="btn" data-dev-close>Fermer</button></div>`;
    document.body.append(dirDlg);
    const body = dirDlg.querySelector('#devDirRows');
    dirDlg.querySelector('#devDirQ').addEventListener('input', (e) => { dirQ = e.target.value; renderDirectory(); });
    dirDlg.querySelector('#devDirF').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      dirF = b.dataset.f;
      for (const x of b.parentNode.children) x.classList.toggle('on', x === b);
      renderDirectory();
    });
    dirDlg.querySelector('#devDirCsv').addEventListener('click', (e) => busy(e.currentTarget, directoryCSV));
    dirDlg.querySelector('#devDirReload').addEventListener('click', (e) => busy(e.currentTarget, loadDirectory));
    dirDlg.querySelector('[data-dev-close]').addEventListener('click', () => dirDlg.close());
    body.addEventListener('input', (e) => {
      const i = e.target.closest('input.dev-name');
      if (i) i.classList.toggle('dirty', cleanText(i.value) !== (deviceName(i.dataset.mac) || ''));
    });
    body.addEventListener('keydown', async (e) => {
      const i = e.target.closest('input.dev-name');
      if (!i || e.isComposing) return;
      if (e.key === 'Escape' && i.classList.contains('dirty')) { // annule la saisie sans fermer la fenêtre
        e.preventDefault(); e.stopPropagation();
        i.value = deviceName(i.dataset.mac) || ''; i.classList.remove('dirty');
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const mac = i.dataset.mac, typed = i.value;
        i.classList.remove('dirty'); i.disabled = true; // la saisie n'est pas recopiée si le tableau est redessiné entre-temps
        const ok = await saveName(mac, typed, null);
        i.disabled = false;
        const cur = body.querySelector(`input.dev-name[data-mac="${mac}"]`) || i;
        if (ok) { cur.value = deviceName(mac) || ''; cur.classList.remove('dirty'); cur.blur(); }
        else { cur.value = typed; cur.classList.add('dirty'); cur.focus(); }
        renderDirectory();
      }
    });
    body.addEventListener('focusout', () => setTimeout(() => { if (dirDlg.dataset.pending === '1' && !body.querySelector('input.dev-name:focus')) renderDirectory(); }, 0));
    body.addEventListener('click', (e) => { const b = e.target.closest('[data-dev-forget]'); if (b) forget(b, b.dataset.devForget); });
    return dirDlg;
  }
  // Oublier : second clic pour confirmer (4 s).
  async function forget(btn, mac) {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'; btn.textContent = 'Confirmer ?';
      clearTimeout(btn._devT);
      btn._devT = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Oublier'; }, 4000);
      return;
    }
    clearTimeout(btn._devT);
    await busy(btn, async () => {
      try {
        await inTurn(async () => {
          const d = await api('/api/settings', { action: 'device-forget', mac });
          if (d?.names && typeof d.names === 'object') X.names = d.names;
        });
        delete draft.names[mac];
        if (dirData) delete dirData[mac];
        toast('Appareil oublié', { type: 'success', sub: mac });
        refresh(true);
      } catch (e) { if (e.message !== '401') toast('Impossible d’oublier cet appareil', { type: 'error', sub: e.message }); }
    });
  }
  function openDirectory() {
    dirDialog();
    dirLm = XV.lastmac;
    if (!dirDlg.open) dirDlg.showModal();
    renderDirectory();
    loadDirectory();
  }

  // ---------------------------------------------------------------- export CSV et impression
  // Cellule CSV : guillemets si besoin, et pas de formule involontaire dans Excel (= + - @ en tête).
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
    return /[";\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  // Séparateur « ; » et BOM UTF-8 : Excel en français ouvre le fichier directement, accents compris.
  const toCSV = (rows) => `\ufeff${rows.map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.hidden = true;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  // Dernier test de câble enregistré pour un port, en clair.
  function cableText(port) {
    const c = S?.cables?.[port];
    if (!c?.rows?.length) return '';
    const k = cableKind(c.rows);
    if (!k) return '';
    const len = k.len ?? '?';
    const txt = { empty: 'rien de branché', open: `câble ~${len} m, rien au bout`, good: `câble ~${len} m en bon état`,
      partial: `câble ~${len} m, paire(s) ${(k.open || []).join(', ')} ouverte(s)`, fault: `câble en défaut (~${len} m)` }[k.kind];
    return txt ? `${txt} (test du ${fmtDate(c.t, true)}${cableOf(port) ? '' : ', plus à jour'})` : '';
  }
  // Appareil d'un port pour l'export : nom affiché, IP, MAC ; port vide : dernier appareil vu.
  function portDevice(p) {
    const ips = obj(S?.ips);
    const all = [...new Set((S?.macs || []).filter((m) => m.port === p.port).map((m) => normMac(m.mac)).filter(Boolean))];
    if (isUplink(p)) return { name: portInfo(p).name, ips: [], macs: all.length ? `${all.length} adresse${all.length > 1 ? 's' : ''} derrière ce lien` : '' };
    if (crowded(all)) return { name: portInfo(p).name, ips: [], macs: `${all.length} adresses (switch ou point d’accès)` };
    if (all.length) {
      const info = portInfo(p);
      return { name: info.name === 'Appareil sans nom' ? '' : info.name, ips: all.map((m) => str(obj(ips[m]).ip)).filter(Boolean), macs: all.join(' ') };
    }
    const last = lastOf(p.port);
    return { name: last ? `dernier vu : ${deviceName(last.mac) || last.host || last.mac}` : '', ips: [], macs: '' };
  }
  const sortedPorts = () => (S?.ports || []).slice().sort((a, b) => portNum(a.port) - portNum(b.port));
  function portsCSV() {
    const head = ['Port', 'État', 'Vitesse', 'VLAN', 'Appareil', 'IP', 'MAC', 'Prise', 'Salle', 'Note', 'Description', 'Câble mesuré'];
    return toCSV([head, ...sortedPorts().map((p) => {
      const pl = planOf(p.port) || {}, d = portDevice(p);
      return [portNum(p.port), stInfo(p).label, p.speed ? `${p.speed} Mb/s` : '', `${p.vlan ?? ''}${p.mode === 'trunk' ? ' (trunk)' : ''}`,
        d.name, d.ips.join(' '), d.macs, pl.jack || '', pl.room || '', pl.note || '', p.desc || '', cableText(p.port)];
    })]);
  }
  async function directoryCSV() {
    if (!dirData) await loadDirectory();
    if (!dirData) return toast('Annuaire indisponible', { type: 'error', sub: dirErr || 'Réessaie dans un instant.' });
    const head = ['Nom', 'MAC', 'IP', 'Nom réseau', 'Branché', 'Port', 'Prise', 'Salle', 'Vu la première fois', 'Vu la dernière fois', 'Historique des ports'];
    const rows = dirRows().map((r) => {
      const pl = (r.port && planOf(r.port)) || {};
      return [r.name, r.mac, r.ip, r.host, r.live ? 'oui' : 'non', r.port ? portNum(r.port) : '', pl.jack || '', pl.room || '',
        r.first ? fmtDate(r.first, true) : '', r.live ? 'maintenant' : r.last ? fmtDate(r.last, true) : '',
        r.ports.map(([p, t]) => `${portNum(p)} (${fmtDate(t, true)})`).join(' > ')];
    });
    download(`appareils-${slug(S?.hostname)}-${today()}.csv`, toCSV([head, ...rows]));
    toast('Annuaire exporté', { type: 'success', sub: `${rows.length} appareil${rows.length > 1 ? 's' : ''}` });
  }
  function exportPorts() {
    if (!S?.ports?.length) return toast('Aucune donnée du switch pour l’instant', { type: 'warn', sub: 'Attends le premier envoi de l’agent.' });
    download(`ports-${slug(S.hostname)}-${today()}.csv`, portsCSV());
    toast('Tableau des ports exporté', { type: 'success', sub: `${S.ports.length} ports` });
  }
  function planRows(onlyFilled) {
    return sortedPorts().map((p) => {
      const pl = planOf(p.port) || {};
      return { n: portNum(p.port), jack: pl.jack || '', room: pl.room || '', note: pl.note || '', device: portDevice(p).name, desc: p.desc || '', vlan: String(p.vlan ?? ''), state: stInfo(p).label };
    }).filter((r) => !onlyFilled || r.jack || r.room || r.note);
  }
  // Tableau du plan : à l'écran les cases vides affichent « - », à l'impression elles restent blanches (à compléter à la main).
  function planTable(rows, screen) {
    const cell = (v) => (v ? esc(v) : screen ? dash : '');
    return `<table class="dev-plan"><thead><tr><th>Port</th><th>Prise murale</th><th>Salle</th><th>Appareil</th><th>Description</th><th>VLAN</th><th>État</th><th>Note</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="num"><b>${r.n}</b></td><td>${cell(r.jack)}</td><td>${cell(r.room)}</td><td>${cell(r.device)}</td><td>${cell(r.desc)}</td><td class="num">${cell(r.vlan)}</td><td>${cell(r.state)}</td><td>${cell(r.note)}</td></tr>`).join('')}
    </tbody></table>`;
  }
  let expDlg = null, expFilled = false;
  function renderExport() {
    if (!expDlg) return;
    const rows = planRows(expFilled);
    setHTML($('#devExpPrev'), !S ? '<div class="empty">Aucune donnée du switch pour l’instant.</div>'
      : rows.length ? planTable(rows, true) : '<div class="empty">Aucun port renseigné : remplis le plan de brassage depuis le volet d’un port.</div>');
    const filled = sortedPorts().filter((p) => planOf(p.port)).length;
    $('#devExpCount').textContent = S ? `${filled} port${filled > 1 ? 's' : ''} renseigné${filled > 1 ? 's' : ''} sur ${(S.ports || []).length}` : '';
  }
  function printPlan() {
    if (!S?.ports?.length) return toast('Aucune donnée du switch pour l’instant', { type: 'warn' });
    const rows = planRows(expFilled);
    if (!rows.length) return toast('Rien à imprimer', { type: 'warn', sub: 'Aucun port renseigné.' });
    let area = document.getElementById('devPrintArea');
    if (!area) { area = document.createElement('div'); area.id = 'devPrintArea'; document.body.append(area); }
    const site = SETTINGS?.siteName;
    const when = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    area.innerHTML = `<h1>Plan de brassage${site ? ` · ${esc(site)}` : ''}</h1>
      <p>${esc(S.hostname || 'Switch')}${S.model ? ` · ${esc(S.model)}` : ''}${S.location ? ` · ${esc(S.location)}` : ''} · imprimé le ${esc(when)}</p>${planTable(rows, false)}`;
    document.body.classList.add('dev-printing');
    addEventListener('afterprint', () => document.body.classList.remove('dev-printing'), { once: true });
    window.print();
  }
  function openExport() {
    if (!expDlg) {
      expDlg = document.createElement('dialog');
      expDlg.className = 'dev-dlg dev-mid';
      expDlg.setAttribute('aria-labelledby', 'devExpTitle');
      expDlg.innerHTML = `<h3 id="devExpTitle">Exporter et imprimer</h3>
        <div class="dev-block"><b>Tableau de tous les ports</b>
          <span class="note">Port, état, vitesse, VLAN, appareil, IP, MAC, prise, salle, note, description et câble mesuré. Fichier CSV qui s’ouvre directement dans Excel.</span>
          <div class="row"><button type="button" class="btn primary" id="devExpCsv">Télécharger le CSV des ports</button></div></div>
        <div class="dev-block"><b>Annuaire des appareils</b>
          <span class="note">Nom, MAC, IP, nom réseau, port, première et dernière apparition, historique des ports.</span>
          <div class="row"><button type="button" class="btn" id="devExpDir">Télécharger le CSV de l’annuaire</button></div></div>
        <div class="dev-block"><b>Plan de brassage <span class="muted" id="devExpCount" style="font-weight:400"></span></b>
          <label class="check"><input type="checkbox" id="devExpFilled"> seulement les ports renseignés (prise, salle ou note)</label>
          <div class="dev-scroll dev-prev" id="devExpPrev"></div>
          <div class="row"><button type="button" class="btn" id="devExpPrint">Imprimer le plan de brassage</button></div></div>
        <div class="actions"><button type="button" class="btn" data-dev-close>Fermer</button></div>`;
      document.body.append(expDlg);
      expDlg.querySelector('#devExpCsv').addEventListener('click', exportPorts);
      expDlg.querySelector('#devExpDir').addEventListener('click', (e) => busy(e.currentTarget, directoryCSV));
      expDlg.querySelector('#devExpPrint').addEventListener('click', printPlan);
      expDlg.querySelector('#devExpFilled').addEventListener('change', (e) => { expFilled = e.target.checked; renderExport(); });
      expDlg.querySelector('[data-dev-close]').addEventListener('click', () => expDlg.close());
      // filet de sécurité si le navigateur n'envoie pas « afterprint » : Ctrl+P réimprime ensuite toute la page
      expDlg.addEventListener('close', () => document.body.classList.remove('dev-printing'));
    }
    if (!expDlg.open) expDlg.showModal();
    renderExport();
  }

  // ---------------------------------------------------------------- outils et rafraîchissement
  const ICON_BOOK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h5"/></svg>';
  const ICON_PRINT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>';
  addTool({ id: 'devices', label: 'Annuaire des appareils', icon: ICON_BOOK, title: 'Nommer les appareils, voir où et quand chacun a été vu', open: openDirectory });
  addTool({ id: 'devices-export', label: 'Exporter et imprimer', icon: ICON_PRINT, title: 'Tableau des ports pour Excel, annuaire, plan de brassage à imprimer', open: openExport });

  // Fenêtres ouvertes : l'annuaire est relu quand le dernier appareil d'un port change, sinon simplement redessiné.
  HOOK.poll.push(() => {
    if (dirDlg?.open) { if (XV.lastmac !== dirLm) { dirLm = XV.lastmac; loadDirectory(); } else renderDirectory(); }
    if (expDlg?.open) renderExport();
  });

  // Si l'état est déjà arrivé avant le chargement de ce fichier, on applique tout de suite les noms et le plan.
  if (S) { try { renderFaceplate(); renderPorts(); } catch (e) { console.error('devices', e); } }
})();
