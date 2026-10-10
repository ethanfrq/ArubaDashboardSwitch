// Diagnostic d'un port (section du volet du port) et outil « Un appareil ne marche pas ? ».
// Les étapes (✓ ⚠ ✕) sont recalculées à chaque affichage à partir de l'état du switch : le diagnostic suit
// en direct le test du câble ou le ping lancés pour lui. Rien côté serveur : la page n'envoie que des commandes
// déjà prévues (test de câble, ping de l'agent), et seulement en vue administrateur.
// Fourni : ADMIN.diagnose(port), ADMIN.diagnoseReport(port), ADMIN.findDevice(texte), ADMIN.switchError(sortie),
// ADMIN.portGuard(p) (raison si le switch a coupé ce port par une protection, sinon '').
(() => {
  'use strict'; // IIFE stricte : aucune fonction ne fuit dans l'espace global (seul ADMIN est partagé)
  const PORT_RE = /^1\/1\/([1-9]|1\d|2[0-8])$/;
  const RUNNING = ['pending', 'running', 'confirm'];
  const ERR_WIN = 1800; // compteurs d'erreurs gardés 30 min pour voir s'ils augmentent
  const DG = { on: new Set(), ping: {}, err: {}, errT: null, dlg: null, input: null, list: null };
  const isFn = (f) => typeof f === 'function';
  const plural = (n, s, p = `${s}s`) => (n > 1 ? p : s);
  const when = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const portOf = (port) => arr(S?.ports).find((p) => p.port === port) || null;
  const macHex = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');

  // ---------------------------------------------------------------- ports sensibles
  // Lien vers un autre switch, ou port du PC de l'agent (voisin LLDP dont le nom est celui du PC).
  const agentHost = () => String(S?.agent?.host || '').split('.')[0].toLowerCase();
  function isAgentPort(port) {
    const h = agentHost();
    return Boolean(h) && arr(S?.lldp).some((l) => l.port === port && [l.chassis, l.name].some((x) => String(x || '').split('.')[0].toLowerCase() === h));
  }
  const isSwitchLink = (p) => Boolean(p.uplink) || isUplink(p) || arr(S?.lldp).some((l) => l.port === p.port && l.name && /\d{4}|aruba|switch/i.test(l.name));
  const sensitive = (p) => isSwitchLink(p) || isAgentPort(p.port);
  // Agent à jour (même seuil que la vérification automatique des câbles) : sinon une commande attend dans la file
  // et part à son retour, peut-être sur un port qui a retrouvé son lien entre-temps.
  const agentAge = () => NOW - (S?.received || S?.updated || 0);
  const fresh = () => agentAge() <= 90;

  // Port activé mais coupé par le switch (BPDU guard, loop-protect…) : raison donnée par le switch, sinon ''.
  // Libellé exact non vérifié sur AOS-CX 10.15 : on écarte les raisons ordinaires et on cherche les mots-clés.
  const PLAIN_REASON = /^(--|Waiting for link|Administratively down|No XCVR installed)$/i;
  const reasonOf = (p) => String(p?.reason || '').trim();
  const guardOf = (p) => {
    const r = reasonOf(p);
    return p?.enabled && !p.up && r && !PLAIN_REASON.test(r) && /bpdu|loop|err|disab|block|guard|protect/i.test(r) ? r : '';
  };
  // Appareil connu sur le port (présent ou dernier vu) : même règle que la section « Allumer à distance » de wol.js.
  const knownMac = (port) => arr(S?.macs).some((m) => m.port === port) || Boolean((isFn(ADMIN.lastMac) && ADMIN.lastMac(port)) || X.lastmac?.[port]?.mac);

  // Erreur du switch dans une sortie (syntaxe refusée…) : { line, cmd } pour la première ligne fautive, sinon null.
  function switchError(out) {
    let cmd = '';
    for (const raw of String(out || '').split('\n')) {
      const l = raw.trim();
      if (l.startsWith('» ')) { cmd = l.slice(2).trim(); continue; }
      if (/^%/.test(l) || /Invalid input|Command incomplete|Unknown command|\bError\b/.test(l)) return { line: l.slice(0, 200), cmd };
    }
    return null;
  }

  // ---------------------------------------------------------------- erreurs : augmentent-elles ?
  // Les compteurs du switch sont cumulés depuis son démarrage : seule leur évolution entre deux lectures compte.
  function recordErrors() {
    if (!S?.ports || !S.updated || S.updated === DG.errT) return;
    DG.errT = S.updated;
    for (const p of S.ports) {
      const h = (DG.err[p.port] ||= []);
      const v = { t: S.updated, e: (Number(p.rx_errors) || 0) + (Number(p.tx_errors) || 0), crc: Number(p.crc) || 0 };
      const last = h.at(-1);
      if (last && (v.e < last.e || v.crc < last.crc || v.t < last.t)) h.length = 0; // compteurs remis à zéro (redémarrage)
      h.push(v);
      while (h.length > 2 && v.t - h[0].t > ERR_WIN) h.shift();
      if (h.length > 240) h.shift();
    }
  }
  function errTrend(port) {
    const h = DG.err[port] || [];
    if (!h.length) return null;
    const a = h[0], b = h.at(-1);
    return { n: h.length, e: b.e, crc: b.crc, de: b.e - a.e, dcrc: b.crc - a.crc, dt: b.t - a.t };
  }

  // ---------------------------------------------------------------- câble
  const cableCmd = (port) => `diagnostics\ndiag cable-diagnostic test ${port}\ny\ndiag cable-diagnostic show ${port}`;
  const cableFor = (c, port) => c.kind === `cable:${port}` || (['cablescan', 'auto:cable'].includes(c.kind) && arr(c.ports).includes(port));
  const cablePending = (port) => LOG.some((c) => RUNNING.includes(c.status) && cableFor(c, port));
  // Résultat valable : celui gardé par l'agent, sinon la sortie du dernier test (avant que l'agent ne l'envoie).
  function cableNow(port) {
    const c = cableOf(port);
    if (c) return c;
    const run = LOG.find((x) => cableFor(x, port) && ['done', 'error'].includes(x.status));
    if (!run || run.status !== 'done' || typeof OUT[run.id] !== 'string') return null;
    const sec = sections(OUT[run.id])[`diag cable-diagnostic show ${port}`];
    const rows = parseCable(sec ? sec.join('\n') : run.kind === `cable:${port}` ? OUT[run.id] : '');
    const t = run.finished || run.created;
    return rows.length && NOW - t < CABLE_MAX_AGE && !cableStale(port, t) ? { t, rows, ...cableKind(rows) } : null;
  }
  // Dernier test de ce port en échec (ou refusé par le switch) et sans résultat : explication, sinon null.
  function cableFailure(port) {
    const run = LOG.find((x) => cableFor(x, port) && ['done', 'error'].includes(x.status));
    if (!run || NOW - (run.finished || run.created) > 3600 || cableNow(port)) return null;
    const out = OUT[run.id];
    const err = typeof out === 'string' ? switchError(out) : null;
    if (err) return `le switch a répondu « ${err.line} »${err.cmd ? ` à la ligne « ${err.cmd} »` : ''}`;
    if (run.status === 'error') return 'le test a échoué (détail dans la console)';
    return typeof out === 'string' ? 'le switch n’a donné aucun résultat' : null;
  }
  function runCable(p) {
    if (!canAdmin() || !p || p.type !== '1GbT' || !p.enabled) return;
    const n = portNum(p.port), label = `Test câble port ${n}`, opts = { kind: `cable:${p.port}`, ports: [p.port] };
    if (cablePending(p.port)) return toast('Test du câble déjà en cours', { sub: `Port ${n} : résultat dans quelques secondes.` });
    // Sans lien et agent à jour, le test ne coupe rien : envoi direct. Avec un lien, sur un port sensible ou si
    // l'agent ne répond pas (le test partira plus tard, le port aura peut-être un lien) : confirmation.
    const live = fresh();
    if (!p.up && !sensitive(p) && live) return void send(cableCmd(p.port), label, opts).catch(() => {});
    const warn = isSwitchLink(p) ? '⚠ Ce port relie un autre switch : tout ce qui passe par lui sera coupé. '
      : isAgentPort(p.port) ? '⚠ C’est le port du PC de l’agent : le dashboard perdra le contact quelques secondes. ' : '';
    const late = live ? '' : `⚠ L’agent ne répond pas depuis ${fmtDur(Math.max(0, agentAge()))} : le test partira à son retour. Si un appareil a été branché entre-temps, il perdra le réseau 5 à 10 secondes pendant la mesure. `;
    confirmCmd(`Tester le câble du port ${n} ?`, `${warn}${late}${p.up ? 'Le port sera coupé 5 à 10 secondes pendant la mesure : l’appareil branché perdra le réseau quelques instants.' : 'Mesure chaque paire du câble.'}`, cableCmd(p.port), label, opts);
  }

  // ---------------------------------------------------------------- ping depuis le PC de l'agent
  const apipa = (ip) => /^169\.254\./.test(String(ip || ''));
  const isIPv4 = (ip) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(ip || ''));
  function pingWhy(ip) {
    if (!isFn(ADMIN.ping)) return 'Le test de réponse (ping) n’est pas disponible dans ce dashboard.';
    if (!agentHas('ping')) {
      const v = S?.agent?.version;
      return `L’agent ${/^\d+\.\d+/.test(String(v ?? '')) ? `v${v}` : 'installé'} ne sait pas encore faire de ping : mets-le à jour (version ${AGENT_LATEST} ou plus).`;
    }
    if (!isIPv4(ip)) return 'Adresse IP inconnue : impossible de tester si l’appareil répond.';
    if (!canAdmin()) return 'Le ping est réservé à l’administrateur.';
    return '';
  }
  async function runPing(port, ip) {
    if (pingWhy(ip) || DG.ping[port]?.st === 'run') return;
    const rec = DG.ping[port] = { ip, st: 'run', t: NOW };
    if (selected === port) renderPanel();
    try {
      const r = (await ADMIN.ping(ip)) || {};
      Object.assign(rec, { st: 'done', sent: Math.max(0, Number(r.sent) || 0), received: Math.max(0, Number(r.received) || 0), avgMs: r.avgMs == null ? null : Number(r.avgMs) });
      if (!rec.sent && !r.ok) Object.assign(rec, { st: 'error', err: 'L’agent n’a renvoyé aucun résultat.' });
    } catch (e) { Object.assign(rec, { st: 'error', err: String(e?.message || e || 'Erreur inconnue').slice(0, 200) }); }
    if (DG.ping[port] === rec && selected === port) renderPanel();
  }

  // ---------------------------------------------------------------- dernier appareil vu (port sans lien)
  function lastSeen(p) {
    const ips = S?.ips || {}, lm = X.lastmac?.[p.port] || null;
    const mac = (isFn(ADMIN.lastMac) && ADMIN.lastMac(p.port)) || lm?.mac || '';
    const name = (mac && isFn(ADMIN.deviceName) && ADMIN.deviceName(mac)) || ips[mac]?.name || lm?.host || '';
    const ip = lm?.ip || ips[mac]?.ip || '';
    const lldp = arr(S?.lldp).find((l) => l.port === p.port && !l.name && l.chassis && !isMacLike(l.chassis));
    if (!mac && !lldp) return '';
    const t = Number(lm?.t) > 1e12 ? Number(lm.t) / 1000 : Number(lm?.t) || 0; // secondes (ou millisecondes)
    return [name || lldp?.chassis, ip, mac, t > 1e9 && ago(NOW - t)].filter(Boolean).join(' · ');
  }
  function devText(macs) {
    const ips = S?.ips || {};
    const one = (m) => [(isFn(ADMIN.deviceName) && ADMIN.deviceName(m)) || ips[m]?.name, ips[m]?.ip, m].filter(Boolean).join(' · ');
    return macs.slice(0, 3).map(one).join(' ; ') + (macs.length > 3 ? ` et ${macs.length - 3} autre(s)` : '');
  }

  // ---------------------------------------------------------------- étapes du diagnostic
  // Renvoie { port, steps: [{ st: ok|warn|bad|info|na|run, title, detail, btns }], level, text, next, btns }.
  function report(port) {
    const p = portOf(port);
    if (!p || !S) return null;
    recordErrors();
    const admin = canAdmin(), n = portNum(port), st = pState(p), copper = p.type === '1GbT';
    const sw = isSwitchLink(p), agentPc = !sw && isAgentPort(port), sens = sw || agentPc;
    const nb = arr(S.lldp).find((l) => l.port === port && l.name);
    const ips = S.ips || {};
    const macs = arr(S.macs).filter((m) => m.port === port).map((m) => m.mac);
    const withIp = macs.filter((m) => ips[m]?.ip);
    const ip = withIp.length ? ips[withIp[0]].ip : '';
    const guard = guardOf(p), live = fresh();
    const steps = [], issues = new Set(), ctx = { p, n, sw, agentPc, sens, nb, ip, admin, cable: null, guard, live };
    const step = (s, title, detail = '', btns = []) => steps.push({ st: s, title, detail, btns: admin ? btns.filter(Boolean) : [] });
    const cableUp = !sens && copper && { act: 'cable', label: 'Tester le câble (coupe 5 à 10 s)' };

    const age = NOW - (S.received || S.updated || NOW);
    if (age > 120) {
      step('warn', 'Données anciennes', `L’agent n’a rien envoyé depuis ${fmtDur(age)} : ce diagnostic montre l’état du switch à ce moment-là.`);
      if (age > 600) { issues.add('stale'); ctx.age = age; }
    }
    if (sw) step('info', `Lien vers un autre switch${nb ? ` (${nb.name})` : ''}`, 'Tous les appareils branchés sur l’autre switch passent par ce port.');
    else if (agentPc) step('info', 'Port du PC de l’agent', 'C’est par ce port que le dashboard lit le switch : s’il était coupé, plus rien ne s’afficherait.');

    // port activé
    const noSfp = p.reason === 'No XCVR installed';
    if (!p.enabled) {
      step('bad', 'Port désactivé', 'Le port est coupé dans la configuration du switch (shutdown) : rien ne peut passer.', [{ act: 'noshut', label: 'Activer le port', cls: 'primary' }]);
      issues.add('off');
    } else if (noSfp) {
      step('bad', 'Aucun module SFP', 'Ce port attend un module SFP (fibre ou cuivre) : il n’y en a pas.');
      issues.add('nosfp');
    } else if (guard) {
      // activé dans la configuration, mais coupé par le switch : le câble et l'appareil ne sont pas en cause
      step('bad', 'Port coupé par une protection du switch', `Le port est activé, mais le switch l’a coupé : « ${guard} ». ${sw
        ? 'Une protection réservée aux postes (BPDU guard, loop-protect) est sans doute active sur ce lien.'
        : 'Il a sans doute détecté un switch, une borne Wi-Fi ou un câble en boucle sur cette prise.'}`, [{ act: 'rearm', label: 'Réactiver le port', cls: 'primary' }]);
      issues.add('guard');
    } else step('ok', 'Port activé');

    const flapStep = () => {
      const f = DIAG?.flaps?.[port], base = arr(DIAG_HIST)[0], win = DIAG && base ? DIAG.t - base.t : 0;
      if (!DIAG || f == null) return step('na', 'Stabilité du lien', 'Relevé du switch en attente.');
      if (f >= 4) {
        step(f >= 10 ? 'bad' : 'warn', 'Lien instable', `${f} changements d’état en ${fmtDur(Math.max(60, win))} : le lien se coupe et revient.`, [!p.up ? null : cableUp]);
        issues.add('flap'); ctx.flaps = f;
      } else if (win < 60) step('na', 'Stabilité du lien', 'Les coupures sont comptées entre deux relevés du switch : résultat dans quelques minutes.');
      else step('ok', 'Lien stable', f ? `${f} changement${f > 1 ? 's' : ''} d’état en ${fmtDur(win)}.` : `Aucune coupure depuis ${fmtDur(win)}.`);
    };
    const vlanStep = () => {
      if (sw) return;
      const vl = arr(S.vlans).find((v) => String(v.id) === String(p.vlan));
      if (p.mode === 'trunk') step('info', 'Port en mode trunk', 'Il transporte plusieurs VLAN : normal pour une borne Wi-Fi ou un autre switch, inhabituel pour un PC.');
      else if (String(p.vlan) !== '1') step('info', `VLAN ${p.vlan}${vl?.name ? ` (${vl.name})` : ''}`, 'L’appareil n’obtient une adresse IP que si un serveur DHCP (ou un relais DHCP) répond sur ce VLAN.');
      else step('ok', 'VLAN 1', 'Réseau principal du switch.');
    };

    if (guard) {
      flapStep();
      vlanStep();
    } else if (p.enabled && !noSfp && !p.up) {
      // pas de lien : le test du câble dit si quelque chose est branché
      step('bad', 'Pas de lien', sw ? 'Le switch ne voit plus l’autre switch au bout du câble.' : 'Le switch ne détecte aucun appareil allumé au bout du câble.');
      if (reasonOf(p) && !PLAIN_REASON.test(reasonOf(p))) step('info', 'Raison donnée par le switch', `« ${reasonOf(p)} »`);
      const again = { act: 'cable', label: 'Refaire le test' };
      const c = copper ? cableNow(port) : null, fail = copper && !c ? cableFailure(port) : null;
      if (!copper) { step('na', 'Test du câble impossible', 'Port SFP : vérifie le module et la fibre (ou le câble) des deux côtés.'); issues.add('sfpdown'); }
      else if (cablePending(port)) {
        step('run', live ? 'Test du câble en cours…' : 'Test du câble en attente de l’agent', live ? 'Résultat dans 10 à 20 secondes.' : 'L’agent ne répond pas : le test partira à son retour.');
        issues.add('cablewait');
      } else if (c) {
        // distance du défaut : celle des paires en cause ; longueur du câble jusqu'à l'appareil : celle des paires bonnes
        const dist = (ok) => arr(c.rows).filter((r) => (r.status === 'good') === ok).map((r) => parseFloat(r.dist)).filter((x) => !isNaN(x));
        const bad = dist(false), good = dist(true);
        ctx.cable = { ...c, at: bad.length ? Math.round(Math.min(...bad)) : c.len, end: good.length ? Math.round(Math.max(...good)) : null };
        const tt = `Test du ${when(c.t)}`, len = c.len ?? '?', at = ctx.cable.at ?? '?';
        if (c.kind === 'empty') { step('bad', 'Aucun câble branché', `${tt} : rien n’est branché sur ce port côté switch.`, [again]); issues.add('empty'); }
        else if (c.kind === 'open') { step('warn', `Câble d’environ ${len} m, rien au bout`, `${tt} : un câble part du switch, mais aucun appareil n’est branché à l’autre bout.`, [again]); issues.add('open'); }
        else if (c.kind === 'good') { step('warn', `Câble en bon état (environ ${len} m)`, `${tt} : le câble va jusqu’à l’appareil, mais celui-ci ne répond pas.`, [again]); issues.add('good'); }
        else if (c.kind === 'partial') { const k = arr(c.open).length; step('warn', 'Câble partiellement coupé', `${tt} : paire${k > 1 ? 's' : ''} ${arr(c.open).join(', ')} ouverte${k > 1 ? 's' : ''}, les autres sont bonnes (environ ${len} m).`, [again]); issues.add('partial'); }
        else { step('bad', 'Câble en défaut', `${tt} : défaut détecté vers ${at} m du switch (court-circuit ou fil coupé).`, [again]); issues.add('fault'); }
      } else {
        const unk = cableUnknown(p);
        const why = fail ? `Le dernier test n’a rien donné : ${fail}.` : unk?.why === 'stale' ? 'Le port a changé d’état depuis le dernier test.' : unk?.why === 'old' ? 'Le dernier test est trop ancien.' : 'Ce port n’a jamais été testé.';
        const ro = admin ? '' : SETTINGS?.autoCable !== false && !sens ? ' La vérification automatique des câbles va le tester.' : ' Demande à l’administrateur de lancer un test.';
        step('na', 'État du câble inconnu', `${why} Sans lien, impossible de savoir si un câble est branché.${ro}`, [{ act: 'cable', label: sens || !live ? 'Tester le câble' : 'Tester le câble (ne coupe rien)', cls: 'primary' }]);
        issues.add('cableunk');
      }
      flapStep();
      vlanStep();
    } else if (p.enabled && !noSfp) {
      // lien établi : qualité du lien, puis l'appareil
      step('ok', 'Lien établi', [p.speed && `${p.speed} Mb/s`, sinceText(p)].filter(Boolean).join(', '));
      if (copper && isSlow(p)) {
        step('warn', `Vitesse réduite : ${p.speed} Mb/s`, sw ? 'Le lien vers l’autre switch devrait monter à 1000 Mb/s : tout son trafic est ralenti.' : 'Le lien devrait monter à 1000 Mb/s.', [cableUp]);
        issues.add('slow');
      } else if (p.speed) step(copper ? 'ok' : 'info', copper ? 'Vitesse normale' : 'Vitesse', `${p.speed} Mb/s`);
      const tr = errTrend(port);
      if (!tr) step('na', 'Erreurs de transmission', 'Pas encore mesurées.');
      else if (tr.de > 0 || tr.dcrc > 0) {
        const big = Math.max(tr.de, tr.dcrc) >= 50;
        step(big ? 'bad' : 'warn', 'Erreurs en augmentation', `+${nf0.format(tr.de)} ${plural(tr.de, 'erreur')} (CRC : +${nf0.format(tr.dcrc)}) en ${fmtDur(Math.max(1, tr.dt))}. Total depuis le démarrage du switch : ${nf0.format(tr.e)}.`, [cableUp]);
        issues.add('errors');
      } else if (tr.e || tr.crc) {
        step(tr.n < 2 ? 'info' : 'ok', tr.n < 2 ? 'Erreurs anciennes, à confirmer' : 'Erreurs anciennes, stables',
          `${nf0.format(tr.e)} ${plural(tr.e, 'erreur')} (CRC : ${nf0.format(tr.crc)}) comptées depuis le démarrage du switch. ${tr.n < 2 ? 'Le dashboard vérifie à la prochaine lecture si elles augmentent.' : `Aucune nouvelle depuis ${fmtDur(Math.max(1, tr.dt))}.`}`);
      } else step('ok', 'Aucune erreur de transmission');
      const stp = DIAG?.ports?.[port]?.stp;
      if (!DIAG) step('na', 'Spanning-tree', 'Relevé du switch en attente.');
      else if (stpBlocked(p)) {
        step('bad', 'Port bloqué par le spanning-tree', sw ? 'Le switch coupe ce lien pour éviter une boucle : un autre chemin mène au même switch.' : 'Le switch coupe ce port pour éviter une boucle réseau.');
        issues.add('stp');
      } else step('ok', 'Pas de blocage spanning-tree', stp ? `Rôle ${STP_FR[stp.role] || stp.role}, état ${STP_FR[stp.state] || stp.state}.` : DIAG.stp?.enabled === false ? 'Spanning-tree désactivé sur le switch.' : '');
      flapStep();
      if (st === 'idle') { step('warn', 'Aucun trafic', `Lien établi, mais aucun paquet reçu depuis ${fmtDur(quietFor(p))}.`); issues.add('idle'); ctx.quiet = quietFor(p); }
      else step('ok', 'Du trafic passe', `Reçu ${fmtBps(p.rx_bps)}, envoyé ${fmtBps(p.tx_bps)}.`);
      if (!macs.length) { step('warn', 'Aucun appareil vu', sw ? 'Le switch n’a appris aucune adresse derrière ce lien.' : 'Le switch n’a appris aucune adresse MAC sur ce port.'); issues.add('nomac'); }
      else if (sw) step('ok', `${macs.length} ${plural(macs.length, 'appareil')} derrière ce lien`);
      else step('ok', macs.length > 1 ? `${macs.length} appareils vus` : 'Appareil vu', devText(macs));
      vlanStep();
      if (!sw && macs.length) {
        if (apipa(ip)) { step('bad', `Adresse automatique ${ip}`, 'L’appareil n’a pas reçu d’adresse du serveur DHCP et s’en est donné une lui-même : il ne peut pas communiquer.'); issues.add('apipa'); }
        else if (ip) step('ok', `Adresse IP ${ip}`, ips[withIp[0]]?.name ? `Nom sur le réseau : ${ips[withIp[0]].name}.` : '');
        else if (!S.agent?.scan) step('na', 'Adresse IP inconnue', 'L’agent ne recherche pas les adresses IP : il doit tourner sur un PC du même réseau.');
        else if (String(p.vlan) !== '1') { step('info', 'Adresse IP inconnue', `L’agent cherche les adresses sur ${S.agent.scan} : un appareil du VLAN ${p.vlan} n’y apparaît pas, c’est normal.`); issues.add('noip-vlan'); }
        else { step('warn', 'Adresse IP inconnue', `Pas trouvée par l’agent sur ${S.agent.scan} (recherche toutes les 5 min) : l’appareil n’a peut-être pas reçu d’adresse.`); issues.add('noip'); }
        // ping depuis le PC de l'agent (inutile vers une adresse automatique 169.254.x.x)
        const why = apipa(ip) ? 'L’appareil n’a pas d’adresse valable : inutile de le tester.' : pingWhy(ip), pr = DG.ping[port];
        const again = { act: 'ping', label: 'Relancer le ping' };
        if (why) step('na', 'Ping non disponible', why);
        else if (!pr || pr.ip !== ip) step('na', 'Ping', 'Vérifie que l’appareil répond, depuis le PC de l’agent.', [{ act: 'ping', label: 'Lancer le ping' }]);
        else if (pr.st === 'run') step('run', 'Ping en cours…', `Depuis le PC de l’agent vers ${ip} (30 s au plus).`);
        else if (pr.st === 'error') step('na', 'Ping impossible', pr.err, [again]);
        else if (pr.received > 0 && pr.received >= pr.sent) step('ok', 'Répond au ping', `${pr.received}/${pr.sent} réponses${Number.isFinite(pr.avgMs) ? `, ${nf.format(pr.avgMs)} ms en moyenne` : ''}.`, [again]);
        else if (pr.received > 0) { step('warn', 'Répond mal au ping', `${pr.received}/${pr.sent} réponses : des paquets se perdent.`, [again]); issues.add('pingpartial'); ctx.ping = pr; }
        else { step('warn', 'Ne répond pas au ping', `0/${pr.sent} réponse depuis le PC de l’agent.`, [again]); issues.add('pingfail'); }
      }
    }
    if (!p.up) { const last = lastSeen(p); if (last) step('info', 'Dernier appareil vu sur ce port', last); }
    return { port, n, steps, ...conclude(issues, ctx) };
  }

  // ---------------------------------------------------------------- conclusion et marche à suivre
  // Le problème le plus important l'emporte ; les autres restent visibles dans les étapes.
  const ORDER = ['stale', 'off', 'guard', 'nosfp', 'sfpdown', 'empty', 'fault', 'partial', 'open', 'good', 'cablewait', 'cableunk', 'stp', 'flap',
    'errors', 'slow', 'idle', 'nomac', 'apipa', 'noip', 'pingfail', 'pingpartial', 'noip-vlan'];
  function conclude(issues, c) {
    const key = ORDER.find((k) => issues.has(k)) || 'ok';
    const { p, n, sw, agentPc, sens } = c, len = c.cable?.len ?? '?', at = c.cable?.at ?? '?', end = c.cable?.end;
    const plan = X.plan?.[p.port], jack = plan?.jack ? `la prise ${plan.jack}${plan.room ? ` (${plan.room})` : ''}` : '';
    // Allumer à distance : pas de second bouton, la section de wol.js le propose déjà quand un appareil est connu
    const wake = c.admin && !sw && isFn(ADMIN.wake) && knownMac(p.port) &&'Tu peux aussi l’allumer à distance : bouton « Allumer l’appareil » de la section « Allumer à distance ».';
    const cable = !sens && p.type === '1GbT' && { act: 'cable', label: p.up ? 'Tester le câble (coupe 5 à 10 s)' : 'Tester le câble' };
    // Position du défaut : cordon de brassage (près du switch), cordon de l'appareil (au bout) ou câble du mur.
    // (longueur inconnue quand toutes les paires sont en défaut : le cordon d'abord, c'est le moins cher à essayer)
    const atN = Number(at), wall = 'Si le défaut reste, c’est le câble dans le mur ou la prise : fais-la vérifier.';
    const faultAt = Number.isFinite(atN) && atN <= 3 ? ['Le défaut est tout près du switch : change le cordon de brassage du port.', wall]
      : !Number.isFinite(atN) || end == null ? ['Change d’abord le cordon entre la prise murale et l’appareil.', wall]
        : atN >= end - 5 ? ['Le défaut est au bout du câble : change le cordon entre la prise murale et l’appareil.', 'Si le défaut reste, fais vérifier la prise murale.']
          : [`Le défaut est dans le câble du mur (vers ${at} m), pas dans les cordons : fais vérifier la prise et le câble.`, 'Pour confirmer, branche l’appareil sur une autre prise : s’il marche, c’est bien ce câble.'];
    const bounce = !sens && p.enabled && { act: 'bounce', label: 'Redémarrer le port' };
    const dhcp = String(p.vlan) !== '1' ? `Ce port est sur le VLAN ${p.vlan} : vérifie qu’un serveur DHCP (ou un relais DHCP) existe pour ce VLAN, ou remets le port sur le bon VLAN.`
      : 'Vérifie que le serveur DHCP du réseau (box, serveur…) fonctionne.';
    const R = {
      stale: ['red', `Le dashboard ne reçoit plus les données du switch depuis ${fmtDur(c.age || 0)} : ce diagnostic n’est pas fiable.`,
        ['Vérifie que le PC de l’agent est allumé et relié au réseau.', 'Relance le diagnostic quand l’agent sera de nouveau en ligne.']],
      off: ['red', sw ? 'Le lien vers l’autre switch est désactivé : tout ce qui est branché derrière est privé de réseau.' : 'Le port est désactivé sur le switch : c’est pour ça que rien ne passe.',
        ['Active le port avec le bouton « Activer le port ».', 'Si quelqu’un l’a désactivé exprès (port inutilisé…), vérifie avant de le réactiver.'], [{ act: 'noshut', label: 'Activer le port', cls: 'primary' }]],
      guard: ['red', sw ? `Le switch a coupé le lien vers l’autre switch (« ${c.guard} ») : une protection réservée aux postes (BPDU guard, loop-protect) est sans doute active sur ce port.`
        : `Le switch a coupé ce port (« ${c.guard} ») : il a détecté un switch, une borne Wi-Fi ou un câble en boucle sur cette prise.`,
        sw ? ['Retire de ce port les protections BPDU guard et loop-protect (réservées aux postes).', 'Puis réactive le port avec le bouton « Réactiver le port ».']
          : ['Retire le petit switch, la borne ou le câble branché en boucle sur cette prise.', 'Puis réactive le port avec le bouton « Réactiver le port ».',
            'Si un appareil de ce genre doit rester branché ici, retire la protection BPDU guard de ce port, sinon il sera coupé de nouveau.'],
        [{ act: 'rearm', label: 'Réactiver le port', cls: 'primary' }]],
      nosfp: ['red', 'Aucun module SFP n’est installé dans ce port : il ne peut rien relier.', ['Insère un module SFP adapté (fibre ou cuivre), puis branche le câble.']],
      sfpdown: ['red', 'Le module SFP ne voit rien en face : fibre ou câble débranché, ou équipement d’en face éteint.',
        ['Vérifie que la fibre (ou le câble) est bien branchée des deux côtés.', 'Vérifie que l’équipement d’en face est allumé.', 'Essaie une autre jarretière.']],
      empty: ['red', sw ? 'Le câble vers l’autre switch n’est plus branché côté switch.' : 'Rien n’est branché sur ce port côté switch : le câble est débranché, ou la prise de l’appareil est reliée à un autre port.',
        [`Vérifie que le câble est bien enfoncé dans le port ${n} du switch (il doit faire « clic »).`,
          jack ? `Ce port est relié à ${jack} : vérifie que l’appareil est bien branché sur cette prise.` : 'Au tableau de brassage, vérifie que la prise murale de l’appareil est reliée à ce port.',
          !sw && 'Si l’appareil est branché ailleurs, cherche-le avec l’outil « Un appareil ne marche pas ? ».'], [cable]],
      fault: ['red', `Le câble est abîmé à environ ${at} m du switch (court-circuit ou fil coupé).`, faultAt, [cable]],
      partial: ['amber', 'Un ou plusieurs fils du câble sont coupés : le lien ne peut pas monter à 1 Gb/s, ou pas du tout.',
        ['Change le cordon entre la prise murale et l’appareil.', 'Si rien ne change, fais vérifier la prise murale (fil mal serti).'], [cable]],
      open: ['amber', `Un câble d’environ ${len} m part de ce port, mais rien n’est branché au bout.`,
        ['Vérifie le cordon entre la prise murale et l’appareil (bien enfoncé des deux côtés).', jack ? `Vérifie que l’appareil est branché sur ${jack}.` : 'Vérifie que l’appareil est branché sur la bonne prise murale.', 'Essaie un autre cordon.'], [cable]],
      good: ['amber', sw ? 'Le câble vers l’autre switch est bon, mais celui-ci ne répond pas : il est sans doute éteint ou son port est désactivé.'
        : 'Le câble est en bon état jusqu’à l’appareil, mais l’appareil ne répond pas : il est éteint, en veille profonde, ou sa carte réseau est désactivée.',
        sw ? ['Vérifie que l’autre switch est allumé et que son port est activé.'] : ['Allume l’appareil ou sors-le de veille (bouge la souris, appuie sur une touche).',
          'Sous Windows, vérifie que la carte Ethernet est activée (Paramètres, Réseau et Internet).', wake], [cable]],
      cablewait: ['amber', 'Pas de lien : le test du câble est en cours pour savoir si un câble est branché.',
        [c.live ? 'Attends le résultat (10 à 20 secondes), le diagnostic se met à jour tout seul.' : 'L’agent ne répond pas : le test partira à son retour et le diagnostic se mettra à jour tout seul.']],
      cableunk: ['amber', 'Pas de lien, et on ne sait pas encore si un câble est branché.',
        [!c.admin ? 'La vérification automatique des câbles va le tester ; sinon, demande à l’administrateur.'
          : c.live ? 'Lance le test du câble : sur un port sans lien, il ne coupe rien.' : 'Lance le test du câble : l’agent ne répond pas, il partira à son retour.',
        !sw && 'Vérifie que l’appareil est allumé et bien branché sur sa prise.', wake], [cable && { ...cable, cls: 'primary' }]],
      stp: ['red', sw ? 'Le spanning-tree bloque ce lien : il existe un autre chemin vers ce switch. Normal si deux câbles relient volontairement les deux switches (secours), sinon c’est une boucle.'
        : 'Le switch bloque ce port pour éviter une boucle réseau : deux câbles relient sans doute les mêmes équipements (ou un petit switch est branché deux fois).',
        ['Cherche un câble qui revient sur le switch, ou un petit switch branché sur deux prises.', 'Débranche le câble en trop : le port se débloque tout seul en quelques secondes.']],
      flap: ['amber', `Le lien se coupe et revient sans arrêt (${c.flaps || 'plusieurs'} fois en quelques minutes).`,
        ['Change le cordon et vérifie la prise murale.', 'Si l’appareil redémarre en boucle ou se met sans cesse en veille, le problème vient de lui.', !sens && p.up && 'Lance un test du câble (le port sera coupé 5 à 10 secondes).'], [p.up && cable]],
      errors: ['amber', 'Des erreurs de transmission apparaissent en ce moment : le câble ou une prise est abîmé.',
        ['Change le cordon de l’appareil.', !sens && 'Teste le câble (le port sera coupé 5 à 10 secondes).', 'Éloigne le câble des sources de parasites (néons, moteurs, câbles électriques).'], [cable]],
      slow: ['amber', `Le lien fonctionne, mais à ${p.speed} Mb/s au lieu de 1 Gb/s : ce sera lent.`,
        sw ? ['Vérifie le câble entre les deux switches et le port utilisé sur l’autre switch (certains ports sont limités à 100 Mb/s).']
          : ['Si le PC est en veille, c’est normal : sa carte réseau ralentit.', 'Sinon change le cordon (un fil coupé limite à 100 Mb/s) et teste le câble.', 'Une vieille carte réseau peut aussi être limitée à 100 Mb/s.'], [cable]],
      idle: ['amber', `Le câble et le lien sont bons, mais l’appareil n’envoie rien depuis ${fmtDur(c.quiet || 0)} : il est sans doute en veille, figé, ou sa carte réseau est désactivée.`,
        ['Réveille ou redémarre l’appareil.', 'Sous Windows, vérifie que la carte Ethernet est activée.', !sens && 'Si rien ne change, redémarre le port (bouton ci-dessous).'], [bounce]],
      nomac: ['amber', sw ? 'Le lien vers l’autre switch est établi, mais aucun appareil n’est vu derrière : l’autre switch ne transmet rien.'
        : 'Le lien est établi, mais le switch ne voit encore aucun appareil : l’appareil vient d’être branché, démarre, ou n’envoie rien.',
        ['Attends une minute (l’appareil démarre peut-être).', 'Redémarre l’appareil.', !sens && 'Si rien ne change, redémarre le port.'], [bounce]],
      apipa: ['red', 'L’appareil n’a pas reçu d’adresse IP (il s’est donné une adresse 169.254.x.x) : le serveur DHCP ne lui a pas répondu.',
        [dhcp, 'Sur le PC, tape « ipconfig /renew » dans une invite de commandes, ou débranche et rebranche le câble.']],
      noip: ['amber', 'L’appareil est bien branché, mais son adresse IP n’est pas connue : il n’a peut-être pas reçu d’adresse (DHCP), ou il est sur un autre réseau.',
        ['Sur le PC, tape « ipconfig » dans une invite de commandes pour voir son adresse.', dhcp, 'L’agent recherche les adresses toutes les 5 min : relance le diagnostic dans quelques minutes.']],
      pingfail: ['amber', 'Le switch voit bien l’appareil, mais il ne répond pas au ping : son pare-feu le bloque peut-être (fréquent sous Windows), ou sa configuration réseau est fausse.',
        ['Si l’appareil accède quand même au réseau, c’est juste le pare-feu : rien à faire.', 'Sinon, vérifie son adresse IP, son masque et sa passerelle (« ipconfig »).', 'Redémarre l’appareil.']],
      pingpartial: ['amber', `L’appareil répond, mais perd des paquets (${c.ping?.received ?? '?'}/${c.ping?.sent ?? '?'} réponses) : la liaison est de mauvaise qualité.`,
        ['Change le cordon de l’appareil.', !sens && 'Teste le câble (le port sera coupé 5 à 10 secondes).'], [cable]],
      'noip-vlan': ['green', `Le port fonctionne. L’appareil est sur le VLAN ${p.vlan} : le dashboard ne peut pas voir son adresse IP ni le tester.`,
        [dhcp, 'Sur l’appareil, tape « ipconfig » pour vérifier qu’il a bien une adresse.']],
      ok: ['green', sw ? 'Le lien vers l’autre switch fonctionne normalement.'
        : agentPc ? 'Le port du PC de l’agent fonctionne normalement.'
          : 'Tout est normal côté switch : câble, lien, vitesse et réseau sont bons. Le problème vient sans doute de l’appareil lui-même (logiciel, compte, Wi-Fi utilisé à la place du câble…).',
        sw ? ['Si des appareils derrière l’autre switch ne marchent pas, diagnostique-les depuis l’autre switch.']
          : ['Redémarre l’appareil.', 'Vérifie qu’il utilise bien le câble et pas le Wi-Fi.', 'Teste un autre appareil sur la même prise pour comparer.']],
    }[key];
    return { key, level: R[0], text: R[1], next: R[2].filter(Boolean), btns: c.admin ? arr(R[3]).filter(Boolean) : [] };
  }

  // ---------------------------------------------------------------- section du volet du port
  const IC = { ok: '✓', warn: '⚠', bad: '✕', info: 'i', na: '?' };
  const btnHTML = (b, port) => `<button class="btn small${b.cls ? ` ${b.cls}` : ''} admin-only" type="button" data-diagnose-act="${esc(b.act)}" data-diagnose-port="${esc(port)}">${esc(b.label)}</button>`;
  function panelHTML(p) {
    if (!S || !p || !PORT_RE.test(p.port)) return '';
    const port = esc(p.port);
    if (!DG.on.has(p.port)) {
      return `<div class="section diagnose-sec" data-diagnose-sec><h3>Diagnostic</h3>
        <p class="note" style="margin:0">Un appareil branché ici ne marche pas ? Le diagnostic vérifie le port étape par étape et te dit quoi faire.</p>
        <div class="row"><button class="btn" type="button" data-diagnose-act="run" data-diagnose-port="${port}">Diagnostiquer ce port</button></div></div>`;
    }
    const r = report(p.port);
    if (!r) return '';
    const steps = r.steps.map((s) => `<li class="diagnose-step ${s.st}"><span class="diagnose-ic" aria-hidden="true">${s.st === 'run' ? '<span class="spinner"></span>' : IC[s.st]}</span>
      <div><b>${esc(s.title)}</b>${s.detail ? `<span class="diagnose-d">${esc(s.detail)}</span>` : ''}${s.btns.length ? `<div class="row">${s.btns.map((b) => btnHTML(b, p.port)).join('')}</div>` : ''}</div></li>`).join('');
    const seen = new Set(r.steps.flatMap((s) => s.btns.map((b) => b.act)));
    const btns = r.btns.filter((b) => !seen.has(b.act)); // pas deux fois le même bouton
    return `<div class="section diagnose-sec" data-diagnose-sec><h3>Diagnostic</h3>
      <ol class="diagnose-steps" aria-label="Étapes du diagnostic">${steps}</ol>
      <div class="alert ${r.level}" style="margin:0"><b>${esc(r.text)}</b></div>
      ${r.next.length ? `<div><span class="label">Que faire ?</span><ol class="diagnose-next">${r.next.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
      ${btns.length ? `<div class="row">${btns.map((b) => btnHTML(b, p.port)).join('')}</div>` : ''}
      <div class="row"><button class="btn small" type="button" data-diagnose-act="run" data-diagnose-port="${port}">Relancer le diagnostic</button>
        <button class="btn small" type="button" data-diagnose-act="hide" data-diagnose-port="${port}">Masquer</button></div></div>`;
  }

  // Démarre (ou relance) le diagnostic : en administrateur, lance tout de suite ce qui ne coupe rien
  // (test du câble d'un port cuivre sans lien, si l'agent répond ; ping de l'appareil).
  function startDiag(port) {
    const p = portOf(port);
    if (!p) return false;
    DG.on.add(port);
    delete DG.ping[port];
    if (canAdmin()) {
      if (p.enabled && !p.up && p.type === '1GbT' && p.reason !== 'No XCVR installed' && !guardOf(p) && !sensitive(p) && fresh() && !cableNow(port) && !cablePending(port)) runCable(p);
      if (p.up && !isSwitchLink(p)) {
        const ips = S.ips || {}, mac = arr(S.macs).find((m) => m.port === port && ips[m.mac]?.ip)?.mac;
        if (mac && !apipa(ips[mac].ip) && !pingWhy(ips[mac].ip)) runPing(port, ips[mac].ip);
      }
    }
    if (selected === port) renderPanel(true);
    return true;
  }
  function act(a, port) {
    if (a === 'run') return startDiag(port);
    if (a === 'hide') { DG.on.delete(port); delete DG.ping[port]; return renderPanel(true); }
    const p = portOf(port);
    if (!p) return;
    if (!canAdmin()) return toast(ROLE === 'viewer' ? 'Lecture seule' : 'Vue monitoring', { type: 'warn', sub: 'Action réservée à l’administrateur.' });
    const n = portNum(port), base = `configure terminal\ninterface ${port}\n`, opt = { ports: [port] };
    const warn = isSwitchLink(p) ? '⚠ Ce port relie un autre switch : tout ce qui passe par lui sera coupé. '
      : isAgentPort(port) ? '⚠ C’est le port du PC de l’agent : le dashboard perdra le contact quelques secondes. ' : '';
    if (a === 'noshut') confirmCmd(`Activer le port ${n} ?`, 'L’appareil branché retrouvera le réseau en quelques secondes.', `${base}no shutdown\nend`, `Port ${n} activé`, opt);
    else if (a === 'bounce') confirmCmd(`Redémarrer le port ${n} ?`, `${warn}Coupure d’environ 3 secondes.`, `${base}shutdown\nno shutdown\nend`, `Port ${n} redémarré`, opt);
    else if (a === 'rearm') {
      // port déjà coupé par le switch : shutdown puis no shutdown le réarme sans rien couper de plus
      const why = guardOf(p);
      confirmCmd(`Réactiver le port ${n} ?`, `${why ? `Le switch a coupé ce port : « ${why} ». ` : ''}Retire d’abord ce qui a déclenché la protection (petit switch, borne Wi-Fi, câble en boucle), sinon il sera coupé de nouveau.`,
        `${base}shutdown\nno shutdown\nend`, `Port ${n} réactivé`, opt);
    } else if (a === 'cable') runCable(p);
    else if (a === 'ping') { delete DG.ping[port]; runPing(port, arr(S.macs).filter((m) => m.port === port).map((m) => S.ips?.[m.mac]?.ip).find(Boolean) || ''); }
  }
  $('#ppBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-diagnose-act]');
    if (!b || !PORT_RE.test(b.dataset.diagnosePort || '')) return;
    act(b.dataset.diagnoseAct, b.dataset.diagnosePort);
  });

  // ---------------------------------------------------------------- « Un appareil ne marche pas ? »
  // Recherche par nom, IP, MAC ou numéro de port : les ports sans lien gardent leur dernier appareil vu.
  function extraText(p) {
    const lm = X.lastmac?.[p.port] || null, plan = X.plan?.[p.port] || null;
    const mac = (isFn(ADMIN.lastMac) && ADMIN.lastMac(p.port)) || lm?.mac || '';
    const name = mac && isFn(ADMIN.deviceName) ? ADMIN.deviceName(mac) || '' : '';
    return { mac, text: [mac, name, lm?.ip, lm?.host, plan?.jack, plan?.room, plan?.note].filter(Boolean).join(' ').toLowerCase() };
  }
  function findRows(q) {
    if (!S?.ports) return [];
    q = String(q || '').trim().toLowerCase().slice(0, 64);
    const num = (q.match(/^(?:port\s*)?(?:1\/1\/)?(\d{1,2})$/) || [])[1];
    const hex = /^[0-9a-f]{2}([:.\s-]?[0-9a-f]{2}){1,5}$/.test(q) || /^[0-9a-f]{4}(\.[0-9a-f]{4}){1,2}$/.test(q) ? macHex(q) : '';
    const rows = [];
    for (const p of S.ports) {
      if (!PORT_RE.test(p.port)) continue;
      const info = portInfo(p), ex = extraText(p);
      const macs = [...arr(S.macs).filter((m) => m.port === p.port).map((m) => m.mac), ex.mac].filter(Boolean);
      let score = 0;
      if (!q) score = info.mac || ex.mac || p.up || p.desc ? 1 : 0;
      else if (num && portNum(p.port) === Number(num)) score = 100;
      else if (hex.length >= 4 && macs.some((m) => macHex(m).includes(hex))) score = 50;
      else if (`${info.text} ${ex.text}`.includes(q)) score = 10 + (String(info.name).toLowerCase().startsWith(q) ? 5 : 0);
      if (score) rows.push({ port: p.port, n: portNum(p.port), score, name: info.name, sub: info.sub, ip: info.ip, mac: info.mac || ex.mac, st: stInfo(p), sw: isSwitchLink(p) });
    }
    rows.sort((a, b) => b.score - a.score || a.n - b.n);
    return rows.slice(0, q ? 12 : 28);
  }
  // Appareils vus par l'agent sur le réseau mais pas branchés directement sur ce switch.
  function awayRows(q) {
    q = String(q || '').trim().toLowerCase();
    if (q.length < 3 || !S) return [];
    const on = new Set(arr(S.macs).map((m) => m.mac)), hex = macHex(q);
    return Object.entries(S.ips || {}).filter(([mac, v]) => !on.has(mac) && v?.ip !== S.mgmt_ip
      && ([v?.ip, v?.name, mac].some((x) => String(x || '').toLowerCase().includes(q)) || (hex.length >= 4 && macHex(mac).includes(hex))))
      .slice(0, 3).map(([mac, v]) => ({ mac, ip: v.ip, name: v.name || '' }));
  }
  function renderFind() {
    if (!DG.list) return;
    const q = DG.input.value;
    if (!S?.ports) return setHTML(DG.list, '<div class="empty">En attente des données du switch…</div>');
    const rows = findRows(q), away = awayRows(q);
    const html = rows.map((r) => `<button type="button" class="diagnose-hit" data-diagnose-pick="${esc(r.port)}">
        <span class="diagnose-hn mono">Port ${r.n}</span>
        <span class="diagnose-hm"><span><b>${esc(r.name || (r.sw ? 'Autre switch' : 'Appareil inconnu'))}</b> <span class="status ${esc(r.st.cls)}">${esc(r.st.label)}</span></span>
          <span class="note">${esc([r.sub, r.ip, r.mac].filter(Boolean).join(' · ') || '-')}</span></span></button>`).join('')
      + away.map((a) => `<div class="diagnose-away note"><b>${esc(a.name || a.ip)}</b> (${esc([a.ip, a.mac].filter(Boolean).join(' · '))}) : vu sur le réseau, mais pas branché directement sur ce switch. Il est sans doute derrière un autre switch, ou en Wi-Fi.</div>`).join('');
    setHTML(DG.list, html || `<div class="empty">Aucun port ne correspond à « ${esc(q.trim())} ». Essaie le numéro de la prise, l’adresse IP ou la fin de l’adresse MAC.</div>`);
  }
  function pick(port) {
    if (!PORT_RE.test(port || '')) return;
    DG.dlg?.close();
    ADMIN.diagnose(port);
  }
  function openFind() {
    if (!canAdmin()) return;
    if (!DG.dlg) {
      const d = document.createElement('dialog');
      d.className = 'wide diagnose-find';
      d.setAttribute('aria-label', 'Un appareil ne marche pas ?');
      const head = document.createElement('div');
      head.innerHTML = `<h3>Un appareil ne marche pas ?</h3>
        <p class="note" style="margin:0 0 10px">Cherche-le par son nom, son adresse IP, son adresse MAC ou le numéro du port. Le port s’ouvre et le diagnostic démarre.</p>`;
      const input = document.createElement('input');
      input.type = 'search'; input.placeholder = 'ex. PC 12, 192.168.1.42, a4:bb:6d, 12';
      input.setAttribute('aria-label', 'Rechercher un appareil'); input.maxLength = 64; input.autocomplete = 'off';
      const list = document.createElement('div');
      list.className = 'diagnose-hits';
      const foot = document.createElement('div');
      foot.className = 'actions';
      foot.innerHTML = '<button class="btn" type="button" data-diagnose-close>Fermer</button>';
      d.append(head, input, list, foot);
      document.body.append(d);
      input.addEventListener('input', renderFind);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = findRows(input.value)[0];
        if (first) pick(first.port);
      });
      d.addEventListener('click', (e) => {
        if (e.target.closest('[data-diagnose-close]')) return d.close();
        const b = e.target.closest('[data-diagnose-pick]');
        if (b) pick(b.dataset.diagnosePick);
      });
      Object.assign(DG, { dlg: d, input, list });
    }
    DG.input.value = '';
    renderFind();
    if (!DG.dlg.open) DG.dlg.showModal();
    setTimeout(() => DG.input.focus(), 30);
  }

  // ---------------------------------------------------------------- branchements
  const css = document.createElement('style');
  css.textContent = `
.diagnose-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.diagnose-step { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; align-items: start; font-size: 13px; }
.diagnose-ic { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; font-weight: 700; background: var(--surface-2); color: var(--text-3); }
.diagnose-ic .spinner { width: 10px; height: 10px; border-width: 1.5px; }
.diagnose-step.ok .diagnose-ic { background: var(--good-soft); color: var(--good); }
.diagnose-step.warn .diagnose-ic { background: var(--warn-soft); color: var(--warn); }
.diagnose-step.bad .diagnose-ic { background: var(--bad-soft); color: var(--bad); }
.diagnose-step.info .diagnose-ic { background: var(--info-soft); color: var(--info); }
.diagnose-step.run .diagnose-ic { color: var(--info); }
.diagnose-step b { font-weight: 600; }
.diagnose-d { display: block; color: var(--text-2); font-size: 12.5px; overflow-wrap: anywhere; }
.diagnose-step .row, .diagnose-sec .row { flex-wrap: wrap; }
.diagnose-step .row { margin-top: 6px; }
.diagnose-next { margin: 4px 0 0; padding-left: 20px; display: grid; gap: 4px; font-size: 13px; }
.diagnose-hits { display: grid; gap: 6px; max-height: min(52vh, 440px); overflow: auto; margin-top: 10px; }
.diagnose-hit { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 10px; align-items: start; text-align: left; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.diagnose-hit:hover, .diagnose-hit:focus-visible { background: var(--surface-2); border-color: var(--accent); outline: none; }
.diagnose-hn { font-weight: 600; padding-top: 1px; }
.diagnose-hm { display: grid; gap: 2px; min-width: 0; }
.diagnose-hm .note { overflow-wrap: anywhere; }
.diagnose-hm .status { font-size: 12px; margin-left: 4px; }
.diagnose-away { padding: 6px 2px; }
@media (max-width: 560px) { .diagnose-hit { grid-template-columns: 1fr; gap: 2px; } }`;
  document.head.append(css);

  HOOK.panel.push(panelHTML);
  HOOK.poll.push(() => recordErrors());
  HOOK.render.push(() => { if (DG.dlg?.open) renderFind(); });
  addTool({
    id: 'diagnose', label: 'Un appareil ne marche pas ?', title: 'Retrouve un appareil (nom, IP, MAC, port) et diagnostique son port',
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v3l2 2"/></svg>',
    open: openFind,
  });

  // Ouvre le port et lance son diagnostic (utilisable par les autres outils, ex. le bilan de santé).
  ADMIN.diagnose = (port) => {
    if (!PORT_RE.test(String(port)) || !portOf(port)) return false;
    if (selected !== port) selectPort(port);
    startDiag(port);
    setTimeout(() => document.querySelector('#ppBody [data-diagnose-sec]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
    return true;
  };
  ADMIN.diagnoseReport = (port) => report(String(port));
  ADMIN.findDevice = (q) => findRows(q);
  ADMIN.switchError = switchError;
  ADMIN.portGuard = (p) => guardOf(p);
})();
