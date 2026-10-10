// Profils de port : modèles (poste élève, imprimante, borne Wi-Fi…) appliqués en un clic à un ou plusieurs ports
// (VLAN, description, protections, activation). Outil « Profils de port » pour les gérer, section « Profil » dans le
// volet d'un port. Données : X.profiles (administrateur seulement, null = profils par défaut ci-dessous).
// Fournit : ADMIN.profiles(), ADMIN.profileCmd(profil, ports), ADMIN.applyProfile(profil, ports),
// ADMIN.profileSummary(profil, n?), ADMIN.cliText(texte, max), ADMIN.switchErrors(sortie).
(() => {
  const MAX = 20;            // profils au maximum (vérifié aussi par le serveur)
  const CMD_MAX = 7800;      // /api/command accepte 8000 caractères : marge pour les lignes ajoutées par le serveur
  const KINDS = new Set(['profile', 'bulk']); // commandes dont on explique les refus du switch (profils, actions groupées)
  const TRI = ['edge', 'bpduGuard', 'loopProtect', 'enable'];
  const PROT = { edge: 'port de périphérie', bpduGuard: 'BPDU guard', loopProtect: 'loop-protect' };
  // Ports surveillés en mode Auto (réglage par défaut) : l'agent surveille chaque port décrit et envoie une alerte
  // critique quand il tombe. Les postes d'élèves s'éteignent à chaque fin de cours : leur description reste inchangée.
  // Un port libéré perd sa description, sinon sa coupure par le profil déclencherait elle-même une alerte.
  const DEFAULTS = [
    { id: 'eleve', name: 'Poste élève', vlan: null, desc: null, edge: true, bpduGuard: true, loopProtect: true, enable: true },
    { id: 'imprimante', name: 'Imprimante', vlan: null, desc: 'Imprimante', edge: true, bpduGuard: true, loopProtect: true, enable: true },
    { id: 'wifi', name: 'Borne Wi-Fi', vlan: null, desc: 'Borne Wi-Fi', edge: true, bpduGuard: false, loopProtect: true, enable: true },
    { id: 'serveur', name: 'Serveur', vlan: null, desc: 'Serveur', edge: true, bpduGuard: true, loopProtect: true, enable: true },
    { id: 'libre', name: 'Port libre (coupé)', vlan: null, desc: '', edge: null, bpduGuard: null, loopProtect: null, enable: false },
  ];

  // ------------------------------------------------------------ fonctions pures
  // Texte inséré dans une ligne de commande du switch : une seule ligne en ASCII imprimable, sans caractère de
  // contrôle, sans « ? » (le switch afficherait son aide) ni « # » en tête (ligne réservée à l'agent), longueur bornée.
  function cliText(s, max = 64) {
    return String(s ?? '')
      .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u00ab\u00bb\u201c\u201d]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u0153/g, 'oe').replace(/\u0152/g, 'OE').replace(/\u00e6/g, 'ae').replace(/\u00c6/g, 'AE').replace(/\u00df/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, ' ').replace(/\?/g, '')
      .replace(/\s+/g, ' ').trim().replace(/^[#\s]+/, '')
      .slice(0, max).trim();
  }
  const tri = (v) => (v === true || v === false ? v : null);
  // Profil propre (venant du serveur, de la page ou d'une autre extension), ou null.
  function norm(p) {
    if (!p || typeof p !== 'object') return null;
    const v = typeof p.vlan === 'string' && /^\d{1,4}$/.test(p.vlan) ? Number(p.vlan) : p.vlan;
    const out = {
      id: String(p.id ?? ''),
      name: String(p.name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Profil',
      vlan: Number.isInteger(v) && v >= 1 && v <= 4094 ? v : null,
      desc: typeof p.desc === 'string' ? cliText(p.desc, 64) : null,
    };
    for (const k of TRI) out[k] = tri(p[k]);
    return out;
  }
  const hasEffect = (p) => p.vlan != null || p.desc != null || TRI.some((k) => p[k] != null);
  // Numéros de ports valides (1 à 28), sans doublon, triés : accepte '1/1/N', 'N' ou N.
  function toNums(ports) {
    const set = new Set();
    for (const x of [].concat(ports ?? [])) {
      const m = String(x).trim().match(/^(?:1\/1\/)?(\d{1,2})$/);
      const n = m ? Number(m[1]) : 0;
      if (n >= 1 && n <= 28) set.add(n);
    }
    return [...set].sort((a, b) => a - b);
  }
  // « 3, 5, 6, 8-12 » : liste courte et lisible.
  function portsText(nums) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      if (j - i >= 2) { out.push(`${nums[i]}-${nums[j]}`); i = j; } else out.push(String(nums[i])); // plage à partir de 3 ports
    }
    return out.join(', ');
  }
  const descFor = (tpl, n) => cliText(String(tpl ?? '').replaceAll('{n}', String(n)), 64);
  // Une section « interface … exit » par port (jamais de plage) ; rien pour les réglages à null.
  function profileCmd(prof, ports) {
    const p = norm(prof), nums = toNums(ports);
    if (!p || !nums.length || !hasEffect(p)) return '';
    const lines = ['configure terminal'];
    for (const n of nums) {
      lines.push(`interface 1/1/${n}`);
      if (p.enable === false) lines.push('shutdown'); // coupé d'abord : plus rien ne passe pendant le reste
      if (p.vlan != null) lines.push(`vlan access ${p.vlan}`);
      if (p.desc != null) { const d = descFor(p.desc, n); lines.push(d ? `description ${d}` : 'no description'); }
      if (p.edge != null) lines.push(p.edge ? 'spanning-tree port-type admin-edge' : 'no spanning-tree port-type');
      if (p.bpduGuard != null) lines.push(p.bpduGuard ? 'spanning-tree bpdu-guard' : 'no spanning-tree bpdu-guard');
      if (p.loopProtect != null) lines.push(p.loopProtect ? 'loop-protect' : 'no loop-protect');
      if (p.enable === true) lines.push('no shutdown'); // activé en dernier, avec la configuration finale
      lines.push('exit');
    }
    lines.push('end');
    return lines.join('\n');
  }
  // Résumé en français : « VLAN inchangé · description « PC 12 » · port de périphérie, BPDU guard activés · port activé ».
  function summary(prof, n) {
    const p = norm(prof); if (!p) return '';
    const parts = [p.vlan != null ? `VLAN ${p.vlan}` : 'VLAN inchangé'];
    if (p.desc == null) parts.push('description inchangée');
    else { const d = n ? descFor(p.desc, n) : p.desc; parts.push(d ? `description « ${d} »` : 'description effacée'); }
    const on = Object.keys(PROT).filter((k) => p[k] === true).map((k) => PROT[k]);
    const off = Object.keys(PROT).filter((k) => p[k] === false).map((k) => PROT[k]);
    if (on.length) parts.push(`${on.join(', ')} activé${on.length > 1 ? 's' : ''}`);
    if (off.length) parts.push(`${off.join(', ')} désactivé${off.length > 1 ? 's' : ''}`);
    if (!on.length && !off.length) parts.push('protections inchangées');
    if (p.enable != null) parts.push(p.enable ? 'port activé' : 'port coupé');
    return parts.join(' · ');
  }
  // Lignes refusées par le switch dans une sortie de l'agent (« » <ligne> » puis la réponse) :
  // [{ line, port, error }], port = numéro du port en cours de configuration (ou null).
  const ERR = /^\s*(%|Invalid input|Error\b|ERROR\b)|Command incomplete/i;
  function switchErrors(out) {
    const res = []; let port = null, cur = null;
    for (const l of String(out ?? '').split('\n')) {
      const m = l.match(/^» (.*)$/);
      if (m) {
        const line = m[1].trim(), im = line.match(/^interface\s+1\/1\/(\d+)$/i);
        if (im) port = Number(im[1]);
        else if (/^(exit|end|configure(\s+terminal)?)$/i.test(line)) port = null;
        cur = { line, port, err: null };
        continue;
      }
      if (cur && !cur.err && ERR.test(l)) { cur.err = l.trim(); res.push({ line: cur.line, port: cur.port, error: cur.err }); }
    }
    return res;
  }
  // Explication en français des refus du switch, regroupés par commande.
  function explainText(errs) {
    const groups = new Map();
    for (const e of errs) {
      const key = /^description\s/i.test(e.line) ? 'description …' : e.line;
      const g = groups.get(key) || { key, ports: [], error: e.error };
      if (e.port) g.ports.push(e.port);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => {
      const where = g.ports.length ? ` (port${g.ports.length > 1 ? 's' : ''} ${portsText(toNums(g.ports))})` : '';
      const hint = /spanning-tree|bpdu-guard|loop-protect/i.test(g.key) ? 'ce firmware n’accepte peut-être pas cette syntaxe : mets « Ne pas toucher » pour cette protection dans le profil'
        : /^vlan access/i.test(g.key) ? 'vérifie que le VLAN existe et que le port n’est pas en mode trunk'
        : /^description/i.test(g.key) ? 'raccourcis la description ou retire les caractères spéciaux'
        : 'détail dans la console';
      return `« ${g.key} » refusé${where} : ${g.error}. Conseil : ${hint}.`;
    }).join(' ');
  }

  // ------------------------------------------------------------ données
  const isDefault = () => !Array.isArray(X.profiles);
  function profiles() {
    return isDefault() ? DEFAULTS.map((p) => ({ ...p })) : X.profiles.map(norm).filter(Boolean);
  }
  const findProfile = (x) => (typeof x === 'string' ? profiles().find((p) => p.id === x) : x);
  const portOf = (n) => (S?.ports || []).find((p) => portNum(p.port) === n);
  const pl = (nums, one, many) => (nums.length > 1 ? many : one);
  // Ports du PC qui fait tourner l'agent (règle LLDP de lib/danger.js, nom court comparé comme health.js) : le couper
  // ou changer son VLAN coupe la session SSH de l'agent, la suite de la commande n'arrive jamais et le dashboard perd
  // le switch jusqu'à une intervention sur place.
  function agentPorts() {
    const host = String(S?.agent?.host || '').split('.')[0].toLowerCase();
    if (!host) return new Set();
    return new Set(arr(S?.lldp).filter((l) => [l?.chassis, l?.name].some((x) => String(x || '').split('.')[0].toLowerCase() === host)).map((l) => l.port));
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

  // Ouvre la confirmation (lignes exactes) après avoir écarté les liens vers d'autres switches, et le port du PC de
  // l'agent si le profil le coupe ou change son VLAN.
  function applyProfile(prof, ports) {
    if (!canAdmin()) return toast(ROLE === 'viewer' ? 'Lecture seule' : 'Vue monitoring', { type: 'warn', sub: 'Action réservée à l’administrateur.' });
    const p = norm(findProfile(prof));
    if (!p) return toast('Profil introuvable', { type: 'error', sub: 'Il a peut-être été supprimé : rouvre la liste des profils.' });
    if (!hasEffect(p)) return toast(`Le profil « ${p.name} » ne change rien`, { type: 'warn', sub: 'Modifie-le dans l’outil « Profils de port ».' });
    if (!arr(S?.ports).length) return toast('État du switch pas encore reçu', { type: 'warn', sub: 'Réessaie quand l’agent aura envoyé un relevé.' });
    const all = toNums(ports).filter((n) => portOf(n));
    const up = all.filter((n) => isUplink(portOf(n)));
    const agent = p.enable === false || p.vlan != null ? agentPorts() : new Set();
    const ag = all.filter((n) => !up.includes(n) && agent.has(`1/1/${n}`));
    const nums = all.filter((n) => !up.includes(n) && !ag.includes(n));
    if (up.length) toast(`${pl(up, 'Port', 'Ports')} ${portsText(up)} exclu${up.length > 1 ? 's' : ''} du profil`, { type: 'warn',
      sub: `${pl(up, 'Il relie', 'Ils relient')} un autre switch : un profil prévu pour un appareil (BPDU guard, admin-edge…) ${pl(up, 'le', 'les')} couperait.`, timeout: 8000 });
    if (ag.length) toast(`${pl(ag, 'Port', 'Ports')} ${portsText(ag)} exclu${ag.length > 1 ? 's' : ''} du profil`, { type: 'warn',
      sub: `C’est le port du PC de l’agent : ${p.enable === false ? 'le couper' : 'changer son VLAN'} ferait perdre le switch au dashboard, jusqu’à une intervention sur place.`, timeout: 8000 });
    if (!nums.length) return up.length || ag.length ? null : toast('Aucun port à modifier', { type: 'warn' });
    const vlans = arr(S.vlans);
    if (p.vlan != null && vlans.length && !vlans.some((v) => Number(v.id) === p.vlan)) {
      return toast(`Le VLAN ${p.vlan} n’existe pas sur le switch`, { type: 'error', sub: 'Crée-le d’abord (carte VLAN) ou modifie le profil.', timeout: 8000 });
    }
    const cmd = profileCmd(p, nums);
    if (cmd.length > CMD_MAX) {
      const most = Math.max(1, Math.floor(((CMD_MAX - 30) * nums.length) / (cmd.length - 30)));
      return toast('Trop de ports d’un coup pour ce profil', { type: 'error', sub: `La commande serait trop longue : applique-le en plusieurs fois (${most} ports au plus).`, timeout: 9000 });
    }
    const trunk = p.vlan != null ? nums.filter((n) => portOf(n)?.mode === 'trunk') : [];
    const text = [
      `${pl(nums, 'Port', 'Ports')} ${portsText(nums)} : ${summary(p, nums.length === 1 ? nums[0] : null)}.`,
      p.desc != null && p.desc.includes('{n}') && nums.length > 1 && '{n} est remplacé par le numéro de chaque port.',
      p.enable === false && 'Les appareils branchés perdront le réseau.',
      p.vlan != null && 'Les appareils branchés changeront de réseau (ils devront parfois renouveler leur IP).',
      trunk.length && `⚠ ${pl(trunk, 'Le port', 'Les ports')} ${portsText(trunk)} ${pl(trunk, 'est', 'sont')} en mode trunk : ${pl(trunk, 'il passera', 'ils passeront')} en mode access sur le VLAN ${p.vlan}.`,
      p.desc != null && watchWarn(nums, (n) => descFor(p.desc, n)),
      up.length && `Exclus (lien vers un autre switch) : ${portsText(up)}.`,
      ag.length && `${pl(ag, 'Exclu', 'Exclus')} (PC de l’agent) : ${portsText(ag)}.`,
    ].filter(Boolean).join(' ');
    confirmCmd(`Appliquer le profil « ${p.name} » ?`, text, cmd, `Profil ${p.name} : ${pl(nums, 'port', 'ports')} ${portsText(nums)}`,
      { ports: nums.map((n) => `1/1/${n}`), kind: 'profile' });
  }

  Object.assign(ADMIN, { profiles, profileCmd, applyProfile, profileSummary: summary, cliText, switchErrors });

  // ------------------------------------------------------------ styles
  const css = document.createElement('style');
  css.textContent = `
.prof-dlg[open] { max-height: calc(100vh - 32px); overflow: auto; }
.prof-dlg .field { margin-bottom: 10px; }
.prof-list { display: grid; max-height: min(52vh, 440px); overflow: auto; }
.prof-item { display: grid; gap: 3px; padding: 9px 0; border-bottom: 1px solid var(--border); }
.prof-item:last-child { border-bottom: 0; }
.prof-top { display: flex; align-items: center; gap: 6px; font-size: 13.5px; min-width: 0; }
.prof-top b { overflow-wrap: anywhere; }
.prof-grow { flex: 1; }
.prof-top .btn.icon { width: 28px; height: 26px; flex-shrink: 0; }
.prof-top .btn.icon svg { width: 14px; height: 14px; }
.prof-acts { flex-wrap: wrap; }
.prof-tri .seg { justify-self: start; flex-wrap: wrap; }
.prof-tri .seg button { padding: 6px 11px; font-size: 12.5px; }
.prof-tri .seg button.on { background: var(--accent); color: #1d0f00; }
.prof-pre { margin: 0; max-height: 170px; }
.prof-desc > .dd { flex: 0 0 158px; }
.prof-panel .note { overflow-wrap: anywhere; }`;
  document.head.append(css);

  // ------------------------------------------------------------ section « Profil » du volet d'un port
  let panelChoice = null; // dernier profil choisi dans le volet (gardé entre deux rafraîchissements)
  function panelSection(p) {
    if (!canAdmin()) return '';
    if (isUplink(p)) {
      return '<div class="section"><h3>Profil</h3><div class="alert amber" style="margin:0">Ce port relie un autre switch : les profils, prévus pour des appareils, ne s’y appliquent pas.</div></div>';
    }
    const list = profiles(), n = portNum(p.port);
    if (!list.length) return '<div class="section"><h3>Profil</h3><p class="note" style="margin:0">Aucun profil. Crée-en un avec l’outil « Profils de port » (carte Administration).</p></div>';
    const cur = list.find((x) => x.id === panelChoice) || list[0];
    return `<div class="section prof-panel"><h3>Profil</h3>
      <div class="row"><select data-prof-sel aria-label="Profil à appliquer au port ${n}">${list.map((x) => `<option value="${esc(x.id)}"${x.id === cur.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select><button class="btn" type="button" data-prof-apply>Appliquer</button></div>
      <p class="note" style="margin:0" data-prof-sum>${esc(summary(cur, n))}.</p>${agentPorts().has(p.port)
        ? '<p class="note" style="margin:0">Port du PC de l’agent : un profil qui coupe le port ou change son VLAN ne s’y applique pas.</p>' : ''}</div>`;
  }
  HOOK.panel.push(panelSection);
  const body = $('#ppBody');
  // Changement de profil : mise à jour sur place, sans redessiner le volet (un renderPanel(true) remplacerait toute la
  // zone des extensions et effacerait les champs en cours de saisie des autres sections, comme l'annuaire).
  body?.addEventListener('change', (e) => {
    const s = e.target.closest?.('[data-prof-sel]'); if (!s) return;
    const p = arr(S?.ports).find((x) => x.port === selected);
    const before = p ? panelSection(p) : '';
    panelChoice = s.value;
    const prof = profiles().find((x) => x.id === s.value), sum = s.closest('.prof-panel')?.querySelector('[data-prof-sum]');
    if (prof && sum && p) sum.textContent = `${summary(prof, portNum(p.port))}.`;
    // setHTML compare avec le dernier HTML posé : on y reporte le nouveau choix (seulement notre section), sinon le
    // prochain relevé verrait une différence et reconstruirait la zone.
    const ext = $('#ppExt');
    if (p && before && typeof ext?._html === 'string' && ext._html.includes(before)) ext._html = ext._html.replace(before, () => panelSection(p));
  });
  body?.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-prof-apply]') || !selected) return;
    const id = body.querySelector('[data-prof-sel]')?.value || panelChoice;
    const prof = profiles().find((x) => x.id === id);
    if (prof) applyProfile(prof, [selected]);
  });

  // ------------------------------------------------------------ explication des refus du switch
  const told = new Set(); let primed = false;
  function watchResults() {
    if (!primed) { for (const c of LOG) if (['done', 'error'].includes(c.status)) told.add(c.id); primed = true; return; }
    for (const c of LOG) {
      if (!KINDS.has(c.kind) || told.has(c.id) || !['done', 'error'].includes(c.status) || OUT[c.id] === undefined) continue;
      told.add(c.id);
      const errs = switchErrors(OUT[c.id]);
      if (!errs.length) continue;
      dropToast(c.id); // remplace la notification générique « le switch a renvoyé une erreur »
      toast(c.label || 'Commande refusée par le switch', { id: `${c.id}:x`, type: 'error', timeout: 20000,
        sub: `${errs.length} ligne${errs.length > 1 ? 's' : ''} refusée${errs.length > 1 ? 's' : ''} par le switch. ${explainText(errs)} Le reste a été appliqué.` });
    }
  }
  HOOK.poll.push(watchResults);
  HOOK.render.push(watchResults);

  // ------------------------------------------------------------ outil « Profils de port »
  let dlg = null, draft = null, editId = null, confirmDel = null, confirmReset = 0;
  let listErr = ''; // erreur affichée sous la liste : gardée aux rafraîchissements, effacée à la prochaine action
  const example = () => (selected ? portNum(selected) : 12);
  function dialog() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'wide prof-dlg';
    dlg.setAttribute('aria-labelledby', 'profTitle');
    document.body.append(dlg);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onInput);
    dlg.addEventListener('close', () => { draft = null; editId = null; confirmDel = null; confirmReset = 0; listErr = ''; });
    return dlg;
  }
  function openManager() {
    dialog(); draft = null; editId = null; confirmDel = null; confirmReset = 0; listErr = '';
    showList();
    if (!dlg.open) dlg.showModal();
  }
  addTool({ id: 'profiles', label: 'Profils de port', icon: '▤', title: 'Crée et modifie les profils (poste élève, imprimante, borne Wi-Fi…) appliqués en un clic aux ports', open: openManager });

  function showList(err) {
    if (err !== undefined) listErr = err;
    const list = profiles(), resetting = confirmReset > Date.now();
    const item = (p) => `<div class="prof-item"><div class="prof-top"><b>${esc(p.name)}</b><span class="prof-grow"></span>
        <button type="button" class="btn icon" data-pf="edit" data-id="${esc(p.id)}" title="Modifier" aria-label="Modifier le profil ${esc(p.name)}">${ICON_EDIT}</button>
        ${confirmDel === p.id ? `<button type="button" class="btn small dangerous" data-pf="del" data-id="${esc(p.id)}">Confirmer la suppression</button>`
          : `<button type="button" class="btn icon danger" data-pf="del" data-id="${esc(p.id)}" title="Supprimer" aria-label="Supprimer le profil ${esc(p.name)}">${ICON_TRASH}</button>`}</div>
      <div class="note">${esc(summary(p))}</div></div>`;
    setHTML(dlg, `<h3 id="profTitle">Profils de port</h3>
      <p class="note" style="margin:0 0 6px">Un profil règle d’un coup le VLAN, la description et les protections d’un port. Applique-le depuis le volet d’un port (section Profil), ou à plusieurs ports : Maj+clic sur les ports (ou outil « Sélection multiple »), puis « Profil… ».${isDefault() ? ' Ce sont les profils par défaut : modifie-les librement.' : ''}</p>
      <div class="prof-list">${list.length ? list.map(item).join('') : '<div class="empty" style="padding:16px 0">Aucun profil pour l’instant.</div>'}</div>
      <div class="error">${esc(listErr)}</div>
      <div class="actions prof-acts">
        ${isDefault() ? '' : `<button type="button" class="btn${resetting ? ' dangerous' : ''}" data-pf="reset">${resetting ? 'Confirmer : profils par défaut' : 'Revenir aux profils par défaut'}</button>`}
        <span class="prof-grow"></span>
        <button type="button" class="btn" data-pf="close">Fermer</button>
        <button type="button" class="btn primary" data-pf="new"${list.length >= MAX ? ` disabled title="${MAX} profils au maximum"` : ''}>+ Nouveau profil</button>
      </div>`);
  }
  const triRow = (k, label, help, [on, off] = ['Activer', 'Désactiver']) => `<div class="field prof-tri"><span class="label" id="pfL-${k}">${label}</span>
      <span class="seg" role="group" aria-labelledby="pfL-${k}">${[[true, on], [false, off], [null, 'Ne pas toucher']].map(([v, t]) =>
        `<button type="button" data-pf-tri="${k}" data-v="${v}" class="${draft[k] === v ? 'on' : ''}" aria-pressed="${draft[k] === v}">${t}</button>`).join('')}</span>
      <span class="note">${help}</span></div>`;
  function preview() {
    const p = norm(draft);
    return p && hasEffect(p) ? profileCmd(p, [example()]) : 'Aucun changement : choisis au moins un réglage.';
  }
  function showEdit(p) {
    draft = { ...p }; editId = p.id || null;
    const vl = arr(S?.vlans);
    const vopts = ['<option value="">Ne pas changer</option>',
      ...vl.map((v) => `<option value="${esc(v.id)}"${draft.vlan === Number(v.id) ? ' selected' : ''}>VLAN ${esc(v.id)} · ${esc(v.name)}</option>`)];
    if (draft.vlan != null && !vl.some((v) => Number(v.id) === draft.vlan)) vopts.push(`<option value="${draft.vlan}" selected>VLAN ${draft.vlan} (absent du switch)</option>`);
    dlg.innerHTML = `<h3 id="profTitle">${editId ? 'Modifier le profil' : 'Nouveau profil'}</h3>
      <div class="field"><label for="pfName">Nom</label><input id="pfName" type="text" maxlength="40" data-pf-in="name" value="${esc(draft.name)}" placeholder="ex. Poste professeur" autocomplete="off"></div>
      <div class="field"><label for="pfVlan">VLAN (mode access)</label><select id="pfVlan" data-pf-in="vlan">${vopts.join('')}</select></div>
      <div class="field"><label for="pfDesc">Description du port</label>
        <div class="row prof-desc"><select data-pf-in="descMode" aria-label="Que faire de la description"><option value="set"${draft.desc != null ? ' selected' : ''}>Remplacer par</option><option value="keep"${draft.desc == null ? ' selected' : ''}>Ne pas changer</option></select>
          <input id="pfDesc" type="text" maxlength="64" data-pf-in="desc" value="${esc(draft.desc ?? '')}" placeholder="vide = effacer" autocomplete="off"${draft.desc == null ? ' disabled' : ''}></div>
        <span class="note">{n} devient le numéro du port (« PC {n} » donne « PC 12 » sur le port 12). Accents et caractères spéciaux retirés, 64 caractères max. Avec les ports surveillés en mode Auto (Réglages), un port décrit est surveillé : l’arrêt de son appareil envoie une alerte.</span></div>
      ${triRow('edge', 'Port de périphérie (admin-edge)', 'Le port transmet dès le branchement, sans attendre le spanning-tree. Pour un appareil, jamais pour un switch.')}
      ${triRow('bpduGuard', 'BPDU guard', 'Coupe le port si on y branche un switch (protège des boucles et des switches pirates).')}
      ${triRow('loopProtect', 'Loop-protect', 'Coupe le port si une boucle est détectée (câble rebranché sur une autre prise de la salle, mini-switch…).')}
      ${triRow('enable', 'État du port', 'Coupé = shutdown : plus rien ne passe sur ce port.', ['Activer', 'Couper'])}
      <div class="field"><span class="label">Aperçu des commandes (port ${example()})</span><pre class="prof-pre" data-pf-preview>${esc(preview())}</pre></div>
      <div class="error" data-pf-err></div>
      <div class="actions"><button type="button" class="btn" data-pf="back">Annuler</button><button type="button" class="btn primary" data-pf="save">Enregistrer</button></div>`;
    dlg._html = null; // contenu modifié par l'utilisateur : ne pas le comparer avec setHTML
    enhanceSelects(dlg);
    setTimeout(() => dlg.querySelector('[data-pf-in="name"]')?.focus(), 30);
  }
  function refresh() {
    const pre = dlg.querySelector('[data-pf-preview]');
    if (pre) pre.textContent = preview();
    const e = dlg.querySelector('[data-pf-err]');
    if (e) e.textContent = '';
  }
  const showErr = (msg) => { const e = dlg.querySelector('[data-pf-err]'); if (e) e.textContent = msg; else showList(msg); };
  function onInput(e) {
    const k = e.target.dataset?.pfIn; if (!k || !draft) return;
    if (k === 'name') draft.name = e.target.value;
    if (k === 'vlan') draft.vlan = e.target.value ? Number(e.target.value) : null;
    if (k === 'desc') draft.desc = e.target.value;
    if (k === 'descMode') {
      const inp = dlg.querySelector('[data-pf-in="desc"]');
      const keep = e.target.value === 'keep';
      draft.desc = keep ? null : inp?.value ?? '';
      if (inp) inp.disabled = keep;
    }
    refresh();
  }
  function onClick(e) {
    const t = e.target.closest('[data-pf-tri]');
    if (t && draft) {
      draft[t.dataset.pfTri] = t.dataset.v === 'true' ? true : t.dataset.v === 'false' ? false : null;
      for (const b of t.parentNode.children) { b.classList.toggle('on', b === t); b.setAttribute('aria-pressed', String(b === t)); }
      return refresh();
    }
    const b = e.target.closest('[data-pf]'); if (!b || b.disabled) return;
    const act = b.dataset.pf;
    if (act !== 'save') listErr = ''; // nouvelle action : l'ancienne erreur n'a plus lieu d'être
    if (act === 'close') return dlg.close();
    if (act === 'back') { draft = null; editId = null; return showList(); }
    if (act === 'new') return showEdit({ id: null, name: '', vlan: null, desc: null, edge: true, bpduGuard: true, loopProtect: true, enable: true });
    if (act === 'edit') { const p = profiles().find((x) => x.id === b.dataset.id); return p ? showEdit(p) : showList('Ce profil n’existe plus.'); }
    if (act === 'del') return remove(b.dataset.id, b);
    if (act === 'reset') return reset(b);
    if (act === 'save') return save(b);
  }
  // Identifiant tiré du nom (« Poste prof » -> poste-prof), unique, 20 caractères max.
  function newId(name, list) {
    const base = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 16).replace(/-+$/, '') || 'profil';
    let id = base, i = 2;
    while (list.some((x) => x.id === id)) id = `${base}-${i++}`;
    return id;
  }
  async function store(btn, list, done) {
    await busy(btn, async () => {
      try {
        const r = await api('/api/settings', { action: 'profiles-save', profiles: list });
        X.profiles = Array.isArray(r.profiles) ? r.profiles : list;
        draft = null; editId = null; confirmDel = null; listErr = '';
        if (dlg.open) showList();
        if (S) renderPanel(true);
        toast(done, { type: 'success', timeout: 3000 });
      } catch (err) { if (err.message !== '401') showErr(err.message); }
    });
  }
  function save(btn) {
    if (!draft) return;
    const name = String(draft.name || '').replace(/\s+/g, ' ').trim();
    if (!name) return showErr('Donne un nom au profil.');
    if (name.length > 40) return showErr('Nom trop long (40 caractères max).');
    const p = norm({ ...draft, name });
    if (!hasEffect(p)) return showErr('Ce profil ne change rien : choisis au moins un réglage.');
    const list = profiles();
    if (list.some((x) => x.id !== editId && x.name.toLowerCase() === name.toLowerCase())) return showErr(`Un autre profil s’appelle déjà « ${name} ».`);
    const i = editId ? list.findIndex((x) => x.id === editId) : -1;
    if (i >= 0) list[i] = { ...p, id: editId };
    else {
      if (list.length >= MAX) return showErr(`${MAX} profils au maximum : supprimes-en un d’abord.`);
      list.push({ ...p, id: newId(name, list) });
    }
    store(btn, list, i >= 0 ? `Profil « ${name} » modifié` : `Profil « ${name} » créé`);
  }
  function remove(id, btn) {
    if (confirmDel !== id) { // premier clic : demande confirmation pendant 4 s
      confirmDel = id; showList();
      setTimeout(() => { if (confirmDel === id) { confirmDel = null; if (dlg.open && !draft) showList(); } }, 4000);
      return;
    }
    const p = profiles().find((x) => x.id === id);
    store(btn, profiles().filter((x) => x.id !== id), `Profil « ${p?.name || id} » supprimé`);
  }
  function reset(btn) {
    if (confirmReset < Date.now()) {
      confirmReset = Date.now() + 4000; showList();
      setTimeout(() => { if (confirmReset && confirmReset <= Date.now()) { confirmReset = 0; if (dlg.open && !draft) showList(); } }, 4100);
      return;
    }
    confirmReset = 0;
    busy(btn, async () => {
      try {
        await api('/api/settings', { action: 'profiles-reset' });
        X.profiles = null; draft = null; editId = null; listErr = '';
        if (dlg.open) showList();
        if (S) renderPanel(true);
        toast('Profils par défaut rétablis', { type: 'success', timeout: 3000 });
      } catch (err) { if (err.message !== '401') showList(err.message); }
    });
  }
  // Liste rafraîchie si les profils changent ailleurs (autre onglet administrateur), sauf pendant une modification.
  HOOK.poll.push(() => { if (dlg?.open && !draft) showList(); });
})();
