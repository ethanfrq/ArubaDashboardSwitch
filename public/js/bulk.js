// Sélection multiple de ports : Maj+clic, Ctrl+clic ou Cmd+clic sur un port de la façade ou une ligne du tableau,
// ou outil « Sélection multiple » (un clic simple sélectionne, pratique sur mobile). Une barre d'actions en bas de
// l'écran applique la même action à tous les ports sélectionnés, avec une section par port (jamais de plage).
// Le clic simple habituel (ouvrir le volet du port) ne change pas. Échap vide la sélection.
// Fournit : ADMIN.selection(), ADMIN.selectPorts(ports, on), ADMIN.clearSelection(), ADMIN.bulkCmd(action, ports, arg).
(() => {
  const sel = new Set();  // ports sélectionnés ('1/1/N')
  let mode = false;       // outil « Sélection multiple » actif : un clic simple sélectionne
  let handled = null;     // clic avec touche de modification déjà traité au pointerdown : { port, t }
  let baseNote = null;    // aide de la façade remplacée pendant le mode sélection
  let lastVlan = null, lastDesc = null, lastProfile = null;
  const HINT = ' · Maj+clic : plusieurs ports';
  const CMD_MAX = 7800;   // /api/command accepte 8000 caractères : marge pour les lignes ajoutées par le serveur

  // ------------------------------------------------------------ fonctions pures
  // Même nettoyage que les profils (ADMIN.cliText) : une ligne ASCII, sans « ? » ni « # » en tête, longueur bornée.
  const cliText = (s, max = 64) => (typeof ADMIN.cliText === 'function' ? ADMIN.cliText(s, max) : String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/\?/g, '')
    .replace(/\s+/g, ' ').trim().replace(/^[#\s]+/, '').slice(0, max).trim());
  function toNums(ports) {
    const set = new Set();
    for (const x of [].concat(ports ?? [])) {
      const m = String(x).trim().match(/^(?:1\/1\/)?(\d{1,2})$/);
      const n = m ? Number(m[1]) : 0;
      if (n >= 1 && n <= 28) set.add(n);
    }
    return [...set].sort((a, b) => a - b);
  }
  function portsText(nums) { // « 3, 5, 6, 8-12 »
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      if (j - i >= 2) { out.push(`${nums[i]}-${nums[j]}`); i = j; } else out.push(String(nums[i])); // plage à partir de 3 ports
    }
    return out.join(', ');
  }
  const descFor = (tpl, n) => cliText(String(tpl ?? '').replaceAll('{n}', String(n)), 64);
  // Commande d'une action groupée : enable, disable, bounce, vlan (arg = numéro), desc (arg = modèle avec {n}),
  // cable (test de câble). Une section par port. Renvoie '' si l'action ou les ports sont invalides.
  function bulkCmd(action, ports, arg) {
    const nums = toNums(ports);
    if (!nums.length) return '';
    if (action === 'cable') {
      return ['diagnostics', ...nums.flatMap((n) => [`diag cable-diagnostic test 1/1/${n}`, 'y', `diag cable-diagnostic show 1/1/${n}`])].join('\n');
    }
    const vid = Number(arg);
    if (action === 'vlan' && !(Number.isInteger(vid) && vid >= 1 && vid <= 4094)) return '';
    const body = {
      enable: () => ['no shutdown'],
      disable: () => ['shutdown'],
      bounce: () => ['shutdown', 'no shutdown'],
      vlan: () => [`vlan access ${vid}`],
      desc: (n) => { const d = descFor(arg, n); return [d ? `description ${d}` : 'no description']; },
    }[action];
    if (!body) return '';
    return ['configure terminal', ...nums.flatMap((n) => [`interface 1/1/${n}`, ...body(n), 'exit']), 'end'].join('\n');
  }

  // ------------------------------------------------------------ sélection
  const selNums = () => toNums([...sel]);
  const asPorts = (nums) => nums.map((n) => `1/1/${n}`);
  const portOf = (n) => (S?.ports || []).find((p) => portNum(p.port) === n);
  const pl = (nums, one, many) => (nums.length > 1 ? many : one);
  const cnt = (nums) => (nums.length > 1 ? `${nums.length} ports` : `le port ${nums[0]}`);
  const named = (nums, one, many) => `${pl(nums, 'Port', 'Ports')} ${portsText(nums)} ${pl(nums, one, many)}`; // « Ports 3, 5 désactivés »

  function changed() { mark(); renderBar(); }
  function toggle(port) { if (sel.has(port)) sel.delete(port); else sel.add(port); changed(); }
  function clear() { if (!sel.size) return; sel.clear(); changed(); }
  // Surligne les ports sélectionnés (façade et tableau), sans toucher au reste.
  function mark() {
    for (const root of [$('#faceplate'), $('#portRows')]) {
      if (!root) continue;
      for (const el of root.querySelectorAll('[data-port]')) {
        const on = sel.has(el.dataset.port);
        if (el.classList.contains('bulk-sel') !== on) el.classList.toggle('bulk-sel', on);
      }
    }
  }
  function note() {
    const el = $('#fpNote'); if (!el) return;
    if (mode) {
      if (baseNote == null) baseNote = el.textContent;
      el.textContent = 'Sélection multiple : touche les ports à ajouter ou retirer, puis choisis l’action en bas de l’écran.';
    } else if (baseNote != null) { el.textContent = baseNote; baseNote = null; }
  }
  const tool = { id: 'bulk', label: 'Sélection multiple', icon: '☑',
    title: 'Sélectionne plusieurs ports d’un simple clic (pratique sur mobile) pour les modifier ensemble. Sur ordinateur : Maj+clic ou Ctrl+clic sur les ports.',
    open: () => setMode(!mode) };
  function setMode(on) {
    mode = Boolean(on) && canAdmin();
    tool.badge = mode ? 'activée' : '';
    renderTools(); note(); changed();
    if (mode) toast('Sélection multiple activée', { sub: 'Touche les ports à sélectionner. Termine avec × dans la barre du bas.', timeout: 3500 });
  }
  addTool(tool);

  // Clics sur la façade et le tableau : écouteurs en phase de capture, avant celui qui ouvre le volet du port.
  const modKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;
  function onDown(e) {
    if (e.button !== 0 || !canAdmin()) return;
    const b = e.target.closest?.('[data-port]'); if (!b) return;
    if (!modKey(e) && !mode) return;
    e.stopPropagation(); // le volet du port ne s'ouvre pas
    if (modKey(e)) { toggle(b.dataset.port); handled = { port: b.dataset.port, t: Date.now() }; }
    // mode sélection sans touche : on attend le clic (un glissement pour faire défiler la façade ne sélectionne rien)
  }
  function onClick(e) {
    const b = e.target.closest?.('[data-port]'); if (!b) return;
    if (handled && handled.port === b.dataset.port && Date.now() - handled.t < 2000) { handled = null; e.stopPropagation(); return; }
    if (!canAdmin() || (!modKey(e) && !mode)) return;
    e.stopPropagation(); e.preventDefault();
    toggle(b.dataset.port);
  }
  function onMouseDown(e) { // Maj+clic : pas de sélection de texte dans le tableau
    if (e.button === 0 && canAdmin() && (modKey(e) || mode) && e.target.closest?.('[data-port]')) e.preventDefault();
  }
  function onMenu(e) { // Ctrl+clic sur Mac ouvre aussi le menu contextuel
    if (handled && Date.now() - handled.t < 1500 && e.target.closest?.('[data-port]')) e.preventDefault();
  }
  for (const root of [$('#faceplate'), $('#portRows')]) {
    if (!root) continue;
    root.addEventListener('pointerdown', onDown, true);
    root.addEventListener('click', onClick, true);
    root.addEventListener('mousedown', onMouseDown, true);
    root.addEventListener('contextmenu', onMenu, true);
    // le tableau est redessiné aussi hors du rendu complet (tri, recherche, sélection d'un port)
    new MutationObserver(mark).observe(root, { childList: true });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!sel.size && !mode) || ddOpen || document.querySelector('dialog[open]')) return;
    sel.clear();
    if (mode) setMode(false); else changed();
    e.stopPropagation(); // le volet du port reste ouvert : un second Échap le fermera
  });

  // ------------------------------------------------------------ styles et barre d'actions
  const css = document.createElement('style');
  css.textContent = `
.jack.bulk-sel { outline: 2px solid var(--info); outline-offset: 2px; }
.jack.sel.bulk-sel { outline-color: var(--accent); }
.jack.bulk-sel::before { content: "✓"; position: absolute; top: -7px; left: -7px; z-index: 1; width: 16px; height: 16px; border-radius: 50%; background: var(--info); color: #fff; font: 700 10px/16px system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px var(--faceplate); }
table.ports tr.bulk-sel td { background: var(--info-soft); }
table.ports tr.bulk-sel td:first-child { box-shadow: inset 3px 0 0 var(--info); }
.bulk-bar { position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 30; width: min(1100px, calc(100% - 16px));
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 10px; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: 12px; box-shadow: 0 10px 30px rgb(0 0 0 / .25); }
.bulk-info { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.bulk-count { font-weight: 600; white-space: nowrap; }
.bulk-list { color: var(--text-3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
.bulk-acts { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }
.bulk-acts .btn, .bulk-end .btn { flex-shrink: 0; }
.bulk-sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 2px; }
.bulk-end { display: flex; gap: 6px; margin-left: auto; }
.bulk-x { min-width: 28px; }
.bulk-prev { overflow-wrap: anywhere; }
body.bulk-on { padding-bottom: 96px; }
body.bulk-on .toasts { bottom: 92px; }
body.bulk-on .drawer { bottom: 84px; }
@media (max-width: 700px) {
  .bulk-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "info end" "acts acts"; bottom: 6px; width: calc(100% - 12px); padding: 7px 8px; gap: 6px; }
  .bulk-info { grid-area: info; } .bulk-end { grid-area: end; } .bulk-list { max-width: none; }
  .bulk-acts { grid-area: acts; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; padding-bottom: 1px; }
  .bulk-acts::-webkit-scrollbar { display: none; }
  body.bulk-on { padding-bottom: 112px; }
  body.bulk-on .toasts { bottom: 104px; }
  body.bulk-on .drawer { bottom: 104px; }
}`;
  document.head.append(css);

  const bar = document.createElement('div');
  bar.className = 'bulk-bar admin-only';
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Actions sur les ports sélectionnés');
  document.body.append(bar);
  bar.addEventListener('pointerdown', (e) => e.stopPropagation()); // un clic dans la barre ne ferme pas le volet du port
  bar.addEventListener('click', onBar);

  function renderBar() {
    const show = canAdmin() && (sel.size > 0 || mode);
    bar.hidden = !show;
    document.body.classList.toggle('bulk-on', show);
    if (!show) return;
    const nums = selNums(), n = nums.length, dis = n ? '' : ' disabled';
    const wake = typeof ADMIN.wake === 'function' && agentHas('wol');
    const prof = typeof ADMIN.applyProfile === 'function';
    const btn = (act, label, extra = '', title = '') => `<button type="button" class="btn small${extra}" data-bulk="${act}"${title ? ` title="${esc(title)}"` : ''}${dis}>${label}</button>`;
    setHTML(bar, `<div class="bulk-info"><span class="bulk-count" aria-live="polite">${n ? `${n} port${n > 1 ? 's' : ''}` : 'Aucun port'}</span>
        <span class="bulk-list"${n ? ` title="Ports ${esc(portsText(nums))}"` : ''}>${n ? esc(portsText(nums)) : 'touche les ports à sélectionner'}</span></div>
      <div class="bulk-acts">
        ${btn('enable', 'Activer')}${btn('disable', 'Désactiver', ' danger')}${btn('bounce', 'Redémarrer', '', 'Coupe puis réactive chaque port (environ 3 s)')}
        ${btn('vlan', 'VLAN…')}${btn('desc', 'Description…')}${prof ? btn('profile', 'Profil…') : ''}
        ${wake ? btn('wake', 'Allumer', '', 'Allume les appareils connus de ces ports (Wake-on-LAN)') : ''}
        ${btn('cable', 'Tester les câbles', '', 'Seulement les ports cuivre sans lien : aucun appareil n’est coupé')}
        <span class="bulk-sep" aria-hidden="true"></span>
        <button type="button" class="btn small" data-bulk="add-free" title="Ajoute les ports sans lien (hors liens vers d’autres switches et port du PC de l’agent)">+ ports sans lien</button>
        <button type="button" class="btn small" data-bulk="add-up" title="Ajoute les ports avec un lien établi (hors liens vers d’autres switches et port du PC de l’agent)">+ ports actifs</button>
      </div>
      <div class="bulk-end">${n ? '<button type="button" class="btn small" data-bulk="clear">Vider</button>' : ''}<button type="button" class="btn small bulk-x" data-bulk="close" title="Terminer la sélection multiple" aria-label="Terminer la sélection multiple">×</button></div>`);
  }

  function onBar(e) {
    const b = e.target.closest?.('[data-bulk]');
    if (!b || b.disabled || !canAdmin()) return;
    const run = {
      clear,
      close: () => { sel.clear(); if (mode) setMode(false); else changed(); },
      enable: () => onOff(true),
      disable: () => onOff(false),
      bounce, vlan: openVlan, desc: openDesc, profile: openProfile, wake, cable,
      'add-free': () => addWhere((p) => !p.up && p.reason !== 'No XCVR installed', 'Aucun port sans lien'),
      'add-up': () => addWhere((p) => p.up, 'Aucun port actif'),
    }[b.dataset.bulk];
    if (run) run();
  }

  // ------------------------------------------------------------ actions
  function ready() {
    if (arr(S?.ports).length) return true;
    toast('État du switch pas encore reçu', { type: 'warn', sub: 'Réessaie quand l’agent aura envoyé un relevé.' });
    return false;
  }
  const upWarn = (nums, what) => {
    const up = nums.filter((n) => isUplink(portOf(n)));
    return up.length ? `⚠ ${pl(up, 'Le port', 'Les ports')} ${portsText(up)} ${pl(up, 'relie', 'relient')} un autre switch : ${what}` : '';
  };
  // Ports du PC qui fait tourner l'agent (règle LLDP de lib/danger.js, nom court comparé comme health.js).
  function agentPorts() {
    const host = String(S?.agent?.host || '').split('.')[0].toLowerCase();
    if (!host) return new Set();
    return new Set(arr(S?.lldp).filter((l) => [l?.chassis, l?.name].some((x) => String(x || '').split('.')[0].toLowerCase() === host)).map((l) => l.port));
  }
  // Retire le port du PC de l'agent d'une action qui le couperait (désactiver, redémarrer, changer de VLAN) : la session
  // SSH de l'agent passe par lui, la suite de la commande n'arriverait jamais (« no shutdown » compris) et le dashboard
  // perdrait le switch jusqu'à une intervention sur place. Renvoie [ports gardés, phrase pour la confirmation].
  function dropAgent(nums, what) {
    const agent = agentPorts(), ag = nums.filter((n) => agent.has(`1/1/${n}`));
    if (!ag.length) return [nums, ''];
    toast(`${pl(ag, 'Port', 'Ports')} ${portsText(ag)} exclu${ag.length > 1 ? 's' : ''}`, { type: 'warn',
      sub: `C’est le port du PC de l’agent : ${what} ferait perdre le switch au dashboard, jusqu’à une intervention sur place.`, timeout: 8000 });
    return [nums.filter((n) => !ag.includes(n)), `${pl(ag, 'Exclu', 'Exclus')} (PC de l’agent) : ${portsText(ag)}.`];
  }
  // Ports surveillés en mode Auto (Réglages, par défaut) : l'agent surveille chaque port qui a une description et envoie
  // une alerte critique quand il tombe. Avertissement si la commande décrit un port qui ne l'était pas, sinon ''.
  function watchWarn(nums, descOf) {
    const s = typeof SETTINGS === 'undefined' ? null : SETTINGS; // null tant que les réglages ne sont pas lus : défauts
    if (arr(s?.watchPorts).length || s?.notify?.portDown === false) return '';
    const fresh = nums.filter((n) => descOf(n) && !portOf(n)?.desc);
    if (!fresh.length) return '';
    return `⚠ Ports surveillés en mode Auto : chaque port décrit est surveillé, l’arrêt de son appareil enverra une alerte (${pl(fresh, 'port', 'ports')} ${portsText(fresh)}). Choisis les ports surveillés dans Réglages.`;
  }
  // Confirmation (lignes exactes), sauf si la commande dépasse ce qu'accepte /api/command.
  function ask(title, text, cmd, label, opts) {
    if (!cmd) return;
    if (cmd.length > CMD_MAX) return toast('Trop de ports d’un coup', { type: 'error', sub: 'La commande serait trop longue : fais-le en plusieurs fois.', timeout: 9000 });
    confirmCmd(title, text, cmd, label, opts);
  }
  function onOff(on) {
    if (!ready()) return;
    const all = selNums().filter((n) => portOf(n)), want = all.filter((n) => portOf(n).enabled !== on);
    const done = all.filter((n) => !want.includes(n));
    if (!want.length) return toast(`${pl(all, 'Ce port est', 'Ces ports sont')} déjà ${on ? 'activé' : 'désactivé'}${all.length > 1 ? 's' : ''}`, { type: 'info' });
    const [nums, agent] = on ? [want, ''] : dropAgent(want, 'le couper');
    if (!nums.length) return;
    const text = [on ? 'Les appareils branchés retrouvent le réseau.' : 'Les appareils branchés perdront le réseau.',
      !on && upWarn(nums, 'tout ce qui passe par ce lien sera coupé.'),
      done.length && `Déjà ${on ? 'activé' : 'désactivé'}${done.length > 1 ? 's' : ''}, ignoré${done.length > 1 ? 's' : ''} : ${portsText(done)}.`, agent].filter(Boolean).join(' ');
    ask(`${on ? 'Activer' : 'Désactiver'} ${cnt(nums)} ?`, text, bulkCmd(on ? 'enable' : 'disable', nums),
      named(nums, on ? 'activé' : 'désactivé', on ? 'activés' : 'désactivés'), { ports: asPorts(nums), kind: 'bulk' });
  }
  function bounce() {
    if (!ready()) return;
    const all = selNums().filter((n) => portOf(n)), enabled = all.filter((n) => portOf(n).enabled);
    if (!enabled.length) return toast('Aucun port activé dans la sélection', { type: 'info', sub: 'Un port désactivé ne se redémarre pas : active-le.' });
    const off = all.filter((n) => !enabled.includes(n));
    const [nums, agent] = dropAgent(enabled, 'le redémarrer');
    if (!nums.length) return;
    const text = ['Coupure d’environ 3 secondes sur chaque port.', upWarn(nums, 'tout ce qui passe par ce lien sera coupé quelques secondes.'),
      off.length && `Désactivé${off.length > 1 ? 's' : ''}, ignoré${off.length > 1 ? 's' : ''} : ${portsText(off)}.`, agent].filter(Boolean).join(' ');
    ask(`Redémarrer ${cnt(nums)} ?`, text, bulkCmd('bounce', nums), named(nums, 'redémarré', 'redémarrés'), { ports: asPorts(nums), kind: 'bulk' });
  }
  function applyVlan(vid) {
    if (!ready()) return;
    const all = selNums().filter((n) => portOf(n));
    const trunk = all.filter((n) => portOf(n).mode === 'trunk');
    const same = all.filter((n) => !trunk.includes(n) && portOf(n).vlan === String(vid));
    const change = all.filter((n) => !trunk.includes(n) && !same.includes(n));
    const skipped = [same.length && `déjà dans le VLAN ${vid} : ${portsText(same)}`, trunk.length && `en mode trunk (à changer dans la console) : ${portsText(trunk)}`].filter(Boolean);
    if (!change.length) return toast('Rien à changer', { type: 'info', sub: `Ports ${skipped.join(' ; ')}.` });
    const [nums, agent] = dropAgent(change, 'changer son VLAN');
    if (!nums.length) return;
    const text = ['Les appareils branchés changeront de réseau (ils devront parfois renouveler leur IP).',
      upWarn(nums, 'le changer de VLAN coupe tout ce qui passe par ce lien.'), skipped.length && `Ignorés : ${skipped.join(' ; ')}.`, agent].filter(Boolean).join(' ');
    ask(`Mettre ${cnt(nums)} dans le VLAN ${vid} ?`, text, bulkCmd('vlan', nums, vid), `${pl(nums, 'Port', 'Ports')} ${portsText(nums)} → VLAN ${vid}`,
      { ports: asPorts(nums), kind: 'bulk' });
  }
  function applyDesc(tpl) {
    if (!ready()) return;
    const nums = selNums().filter((n) => portOf(n));
    if (!nums.length) return;
    const t = cliText(tpl);
    const text = [t ? `Modèle « ${t} »${t.includes('{n}') ? ' ({n} = numéro de chaque port)' : ''}.` : 'Les descriptions seront effacées.',
      watchWarn(nums, (n) => descFor(t, n))].filter(Boolean).join(' ');
    ask(`Description de ${cnt(nums)}`, text, bulkCmd('desc', nums, t), `Description ${pl(nums, 'port', 'ports')} ${portsText(nums)}`, { ports: asPorts(nums), kind: 'bulk' });
  }
  function wake() {
    if (typeof ADMIN.wake !== 'function' || !agentHas('wol')) return toast('Allumage à distance indisponible', { type: 'warn', sub: 'Mets l’agent à jour (version 1.4.0 ou plus).' });
    ADMIN.wake(asPorts(selNums()));
  }
  function cable() {
    if (!ready()) return;
    const all = selNums(), nums = all.filter((n) => { const p = portOf(n); return p && p.enabled && !p.up && p.type === '1GbT'; });
    if (!nums.length) return toast('Aucun port à tester', { type: 'info', sub: 'Le test se fait seulement sur les ports cuivre activés et sans lien (il ne coupe aucun appareil).' });
    const skip = all.filter((n) => !nums.includes(n));
    ask(`Tester le câble de ${cnt(nums)} ?`,
      `Pour chaque port : y a-t-il un câble, quelle longueur, est-il en bon état ? Aucun appareil n’est coupé (ces ports n’ont pas de lien). Durée : environ ${Math.ceil((nums.length * 8) / 60)} min.${skip.length ? ` Ignorés (lien établi, port désactivé ou SFP) : ${portsText(skip)}.` : ''}`,
      bulkCmd('cable', nums), `Test câbles ${pl(nums, 'port', 'ports')} ${portsText(nums)}`, { ports: asPorts(nums), kind: 'cablescan' });
  }
  // Raccourcis de sélection : jamais les liens vers d'autres switches ni le port du PC de l'agent.
  function addWhere(test, none) {
    if (!ready()) return;
    const agent = agentPorts();
    const add = S.ports.filter((p) => test(p) && !isUplink(p) && !agent.has(p.port)).map((p) => p.port);
    const fresh = add.filter((p) => !sel.has(p));
    if (!fresh.length) return toast(add.length ? 'Ces ports sont déjà sélectionnés' : none, { type: 'info' });
    for (const p of fresh) sel.add(p);
    changed();
  }

  // ------------------------------------------------------------ petites fenêtres (VLAN, description, profil)
  let dlg = null, onOk = null, onEdit = null;
  function form(title, html, ok, edit = null) {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'bulk-dlg';
      document.body.append(dlg);
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest?.('[data-bf-act]'); if (!b) return;
        if (b.dataset.bfAct === 'ok') submit(); else dlg.close();
      });
      dlg.addEventListener('input', () => onEdit?.());
      dlg.addEventListener('change', () => onEdit?.());
      dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
    }
    dlg.innerHTML = `<h3>${esc(title)}</h3>${html}<div class="error" data-bf-err></div>
      <div class="actions"><button type="button" class="btn" data-bf-act="no">Annuler</button><button type="button" class="btn primary" data-bf-act="ok">Continuer</button></div>`;
    onOk = ok; onEdit = edit;
    enhanceSelects(dlg);
    if (!dlg.open) dlg.showModal();
    setTimeout(() => (dlg.querySelector('input') || dlg.querySelector('.dd-btn'))?.focus(), 30);
  }
  // ok() renvoie un message d'erreur (la fenêtre reste ouverte) ou la suite à lancer une fois la fenêtre fermée.
  function submit() {
    if (!onOk) return;
    const r = onOk();
    if (typeof r === 'string') { const e = dlg.querySelector('[data-bf-err]'); if (e) e.textContent = r; return; }
    dlg.close();
    if (typeof r === 'function') r();
  }
  const field = (name) => dlg.querySelector(`[data-bf="${name}"]`);

  function openVlan() {
    if (!ready()) return;
    const vl = arr(S.vlans), nums = selNums();
    if (!vl.length) return toast('Aucun VLAN connu', { type: 'warn', sub: 'Le relevé des VLAN n’est pas encore arrivé.' });
    const cur = vl.some((v) => Number(v.id) === lastVlan) ? lastVlan : Number(vl[0].id);
    form(`VLAN pour ${cnt(nums)}`, `<div class="field"><label for="bulkVlan">VLAN (mode access)</label><select id="bulkVlan" data-bf="vlan">${vl.map((v) =>
      `<option value="${esc(v.id)}"${Number(v.id) === cur ? ' selected' : ''}>VLAN ${esc(v.id)} · ${esc(v.name)}</option>`).join('')}</select></div>
      <p class="note" style="margin:0">${pl(nums, 'Port', 'Ports')} ${esc(portsText(nums))}. Les ports en mode trunk et ceux déjà dans ce VLAN sont ignorés.</p>`, () => {
      const vid = Number(field('vlan')?.value);
      if (!(Number.isInteger(vid) && vid >= 1 && vid <= 4094)) return 'Choisis un VLAN.';
      lastVlan = vid;
      return () => applyVlan(vid);
    });
  }
  function descPreview(tpl, nums) {
    const list = nums.slice(0, 4).map((n) => `port ${n} : ${descFor(tpl, n) || '(effacée)'}`);
    return list.join(' · ') + (nums.length > 4 ? ` · et ${nums.length - 4} autre${nums.length > 5 ? 's' : ''}` : '');
  }
  function openDesc() {
    if (!ready()) return;
    const nums = selNums(), descs = new Set(nums.map((n) => portOf(n)?.desc || ''));
    const init = lastDesc ?? (descs.size === 1 ? [...descs][0] : '');
    form(`Description de ${cnt(nums)}`, `<div class="field"><label for="bulkDesc">Description</label>
        <input id="bulkDesc" type="text" maxlength="64" data-bf="desc" value="${esc(init)}" placeholder="ex. PC {n}" autocomplete="off">
        <span class="note">{n} devient le numéro de chaque port. Vide = effacer la description. Accents et caractères spéciaux retirés.</span></div>
      <div class="field" style="margin:0"><span class="label">Aperçu</span><div class="note bulk-prev" data-bf-prev>${esc(descPreview(init, nums))}</div></div>`, () => {
      const v = field('desc')?.value ?? '';
      lastDesc = v;
      return () => applyDesc(v);
    }, () => { const p = dlg.querySelector('[data-bf-prev]'); if (p) p.textContent = descPreview(field('desc')?.value ?? '', nums); });
  }
  function openProfile() {
    if (!ready() || typeof ADMIN.profiles !== 'function' || typeof ADMIN.applyProfile !== 'function') return;
    const list = ADMIN.profiles(), nums = selNums();
    if (!list.length) return toast('Aucun profil', { type: 'warn', sub: 'Crée-en un avec l’outil « Profils de port ».' });
    const sum = (id) => { const p = list.find((x) => x.id === id) || list[0]; return typeof ADMIN.profileSummary === 'function' ? ADMIN.profileSummary(p, nums.length === 1 ? nums[0] : null) : ''; };
    const cur = list.some((p) => p.id === lastProfile) ? lastProfile : list[0].id;
    form(`Profil pour ${cnt(nums)}`, `<div class="field"><label for="bulkProf">Profil</label><select id="bulkProf" data-bf="profile">${list.map((p) =>
      `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <p class="note bulk-prev" style="margin:0" data-bf-prev>${esc(sum(cur))}</p>
      <p class="note" style="margin:6px 0 0">Les liens vers d’autres switches sont exclus d’office, ainsi que le port du PC de l’agent si le profil le coupe ou change son VLAN. Les lignes exactes s’affichent avant l’envoi.</p>`, () => {
      const p = list.find((x) => x.id === field('profile')?.value);
      if (!p) return 'Choisis un profil.';
      lastProfile = p.id;
      return () => ADMIN.applyProfile(p, asPorts(selNums()));
    }, () => { const e = dlg.querySelector('[data-bf-prev]'); if (e) e.textContent = sum(field('profile')?.value); });
  }

  // ------------------------------------------------------------ points d'accroche
  HOOK.faceplate.push(mark);
  HOOK.render.push(() => { mark(); renderBar(); });
  HOOK.role.push((ro) => {
    if (ro) { sel.clear(); mode = false; baseNote = null; tool.badge = ''; dlg?.close(); }
    else { // aide sur ordinateur (souris) : la façade rappelle le Maj+clic
      const el = $('#fpNote');
      if (el && !mode && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches && !el.textContent.endsWith(HINT)) el.textContent += HINT;
    }
    mark(); renderBar();
  });

  Object.assign(ADMIN, {
    selection: () => asPorts(selNums()),
    selectPorts: (ports, on = true) => { if (!canAdmin()) return; for (const n of toNums(ports)) { if (on) sel.add(`1/1/${n}`); else sel.delete(`1/1/${n}`); } changed(); },
    clearSelection: () => { sel.clear(); changed(); },
    bulkCmd,
  });
})();
