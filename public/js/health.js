// Bilan de santé du switch : vérifications (OK, à surveiller, à corriger, inconnu) avec, quand c'est possible,
// une correction en un clic (fenêtre de confirmation qui montre les lignes exactes).
// La configuration vient de la dernière sauvegarde (ADMIN.latestConfig, tâche backup), relue quand X.cfg change ;
// sans elle, le bilan propose de la lire et marque « inconnu » ce qui en dépend.
// Les liens vers d'autres switches et le port du PC de l'agent ne font jamais partie d'une correction.
// Fourni : ADMIN.healthChecks(texteConfig?), ADMIN.openHealth().
(() => {
  'use strict'; // IIFE stricte : aucune fonction ne fuit dans l'espace global (seul ADMIN est partagé)
  const PORT_RE = /^1\/1\/([1-9]|1\d|2[0-8])$/;
  const RUNNING = ['pending', 'running', 'confirm'];
  const WEEK = 7 * 86400;
  const NTP_IP = '162.159.200.123'; // serveur de temps public de Cloudflare
  const MASK = '<masqué>'; // marque des secrets masqués par la sauvegarde (lib/features/backup.js)
  const ST = { fix: ['À corriger', 0], watch: ['À surveiller', 1], unknown: ['Inconnu', 2], ok: ['OK', 3] };
  const HL = { cfg: null, state: 'idle', err: '', loading: null, first: false, lastTry: 0, asked: 0, askedAt: 0, askId: null, askDone: 0, askFail: false, direct: { id: null, v: null },
    dlg: null, body: null, tool: null, okOpen: false, warned: new Set() };
  const isFn = (f) => typeof f === 'function';
  const plural = (n, s, p = `${s}s`) => (n > 1 ? p : s);
  const when = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const nums = (ports) => ports.map(portNum).join(', ');
  const portOf = (port) => arr(S?.ports).find((p) => p.port === port) || null;

  // ---------------------------------------------------------------- ports sensibles (jamais corrigés)
  const agentHost = () => String(S?.agent?.host || '').split('.')[0].toLowerCase();
  function isAgentPort(port) {
    const h = agentHost();
    return Boolean(h) && arr(S?.lldp).some((l) => l.port === port && [l.chassis, l.name].some((x) => String(x || '').split('.')[0].toLowerCase() === h));
  }
  const sensitive = (p) => Boolean(p.uplink) || isUplink(p) || isAgentPort(p.port)
    || arr(S?.lldp).some((l) => l.port === p.port && l.name && /\d{4}|aruba|switch/i.test(l.name));

  // Erreur du switch dans une sortie : { line, cmd } ou null (même règle que le diagnostic).
  const switchError = (out) => {
    if (isFn(ADMIN.switchError)) return ADMIN.switchError(out);
    let cmd = '';
    for (const raw of String(out || '').split('\n')) {
      const l = raw.trim();
      if (l.startsWith('» ')) { cmd = l.slice(2).trim(); continue; }
      if (/^%/.test(l) || /Invalid input|Command incomplete|Unknown command|\bError\b/.test(l)) return { line: l.slice(0, 200), cmd };
    }
    return null;
  };

  // Heure (s) d'une valeur : nombre (s ou ms), date texte, ou objet/liste de sauvegardes { t } (forme libre de X.cfg).
  function newestT(x, depth = 0) {
    if (x == null || depth > 3) return 0;
    if (typeof x === 'number') { const t = x > 1e12 ? x / 1000 : x; return t > 1e9 ? t : 0; }
    if (typeof x === 'string') { const t = /^\d+(\.\d+)?$/.test(x) ? Number(x) : Date.parse(x) / 1000; return Number.isFinite(t) ? newestT(t, depth + 1) : 0; }
    if (Array.isArray(x)) return x.reduce((a, y) => Math.max(a, newestT(y, depth + 1)), 0);
    if (typeof x === 'object') {
      let best = 0;
      for (const k of ['t', 'last', 'latest', 'time', 'at']) if (k in x) best = Math.max(best, newestT(x[k], depth + 1));
      for (const k of ['list', 'items', 'backups', 'history']) if (Array.isArray(x[k])) best = Math.max(best, newestT(x[k], depth + 1));
      return best;
    }
    return 0;
  }

  // ---------------------------------------------------------------- analyse de la configuration
  // Blocs « interface 1/1/N » : lignes indentées jusqu'à la ligne non indentée suivante.
  function parseConfig(text) {
    const ifs = {}, top = [];
    let cur = null;
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      if (!raw.trim() || raw.startsWith('» ')) continue;
      if (/^\s/.test(raw)) { if (cur) for (const p of cur) ifs[p].push(raw.trim()); continue; }
      const m = raw.trim().match(/^interface\s+(1\/1\/[\d/,-]+)$/i);
      cur = m ? expandPorts(m[1]).filter((p) => PORT_RE.test(p)) : null;
      if (cur) for (const p of cur) ifs[p] ||= [];
      else top.push(raw.trim());
    }
    const has = (lines, re) => arr(lines).some((l) => re.test(l));
    return {
      ifs, nIfs: Object.keys(ifs).length,
      ntpServers: top.map((l) => (l.match(/^ntp\s+server\s+(\S+)/i) || [])[1]).filter(Boolean),
      ntpEnabled: has(top, /^ntp\s+enable\b/i),
      stp: has(top, /^spanning-tree\s*$/i),
      // « community ciphertext X » (valeur chiffrée) : invérifiable, notée *** ; « plaintext X » : valeur en clair
      communities: top.map((l) => l.match(/^snmp-server\s+community\s+(?:(ciphertext|plaintext)\s+)?(\S+)/i)).filter(Boolean)
        .map((m) => (/^cipher/i.test(m[1] || '') ? '***' : m[2])),
      prot: (port) => ({
        loop: has(ifs[port], /^loop-protect(\s+vlan\b.*)?$/i),
        edge: has(ifs[port], /^spanning-tree\s+port-type\s+admin-edge$/i),
        bpdu: has(ifs[port], /^spanning-tree\s+bpdu-guard(\s+enable)?$/i),
      }),
    };
  }
  // Configuration utilisée : la plus récente entre la sauvegarde et une lecture directe (show running-config).
  function currentCfg() {
    const run = LOG.find((c) => c.kind === 'auto:health' && c.status === 'done' && typeof OUT[c.id] === 'string');
    if (run && HL.direct.id !== run.id) {
      const parsed = parseConfig(arr(sections(OUT[run.id])['show running-config']).join('\n'));
      HL.direct = { id: run.id, v: parsed.nIfs ? { t: run.finished || run.created, parsed, src: 'direct' } : null };
    }
    const d = run ? HL.direct.v : null, b = HL.cfg;
    return d && (!b || d.t > b.t) ? d : b;
  }

  // Commande : un bloc par port (jamais de plage), ports vérifiés.
  const blocks = (map) => ['configure terminal', ...Object.entries(map).filter(([port]) => PORT_RE.test(port))
    .sort((a, b) => portNum(a[0]) - portNum(b[0])).flatMap(([port, lines]) => [`interface ${port}`, ...lines, 'exit']), 'end'].join('\n');

  // Ports de postes : cuivre, hors ports sensibles, avec un appareil (présent ou dernier vu), une description
  // ou un nom (prise murale ou note du plan de brassage).
  function lastMacOf(port) { return (isFn(ADMIN.lastMac) && ADMIN.lastMac(port)) || X.lastmac?.[port]?.mac || ''; }
  const used = (p) => Boolean(arr(S.macs).some((m) => m.port === p.port) || lastMacOf(p.port) || String(p.desc || '').trim() || X.plan?.[p.port]?.jack || X.plan?.[p.port]?.note);
  // Équipement réseau probable (borne Wi-Fi, petit switch sans nom reconnu) : trunk (relevé ou configuration),
  // plus de 3 appareils, ou voisin LLDP nommé. Une protection de poste (BPDU guard surtout) le couperait.
  function netGear(p, cfg) {
    if (p.mode === 'trunk' || arr(cfg?.ifs?.[p.port]).some((l) => /^vlan\s+trunk\b/i.test(l))) return true;
    if (new Set(arr(S.macs).filter((m) => m.port === p.port).map((m) => m.mac)).size > 3) return true;
    return arr(S.lldp).some((l) => l.port === p.port && String(l.name || '').trim());
  }
  function stationPorts(cfg) {
    const cu = arr(S?.ports).filter((p) => p.type === '1GbT' && PORT_RE.test(p.port) && !sensitive(p) && used(p));
    return { stations: cu.filter((p) => !netGear(p, cfg)), gear: cu.filter((p) => netGear(p, cfg)) };
  }
  const onPorts = (ps) => `${ps.length > 1 ? 'les ports' : 'le port'} ${nums(ps.map((p) => p.port))}`;
  const Ports = (ps) => `${ps.length > 1 ? 'Ports' : 'Port'} ${nums(ps.map((p) => p.port))}`;

  // ---------------------------------------------------------------- vérifications
  // Chaque vérification : { id, title, st: ok|watch|fix|unknown, text, ports?, fix?, fixAll?, act?, cfg? }.
  function checks(cfgText) {
    if (!S) return [];
    const src = cfgText != null ? { t: NOW, parsed: parseConfig(cfgText), src: 'test' } : currentCfg();
    const cfg = src?.parsed?.nIfs ? src.parsed : null;
    const ports = arr(S.ports).filter((p) => PORT_RE.test(p.port));
    const list = [];
    const add = (c) => { const x = { ports: [], ...c }; list.push(x); return x; };
    const noCfg = HL.asked ? 'Lecture de la configuration du switch en cours…' : 'Dépend de la configuration du switch, pas encore lue.';

    // configuration sauvegardée
    const saved = DIAG?.saved;
    add({ id: 'saved', title: 'Configuration sauvegardée', st: saved === true ? 'ok' : saved === false ? 'fix' : 'unknown',
      text: saved === true ? 'Les changements sont enregistrés : ils survivront à un redémarrage du switch.'
        : saved === false ? 'Des changements ne sont pas sauvegardés : ils seront perdus au prochain redémarrage du switch (coupure de courant…).' : 'Relevé du switch en attente.',
      fix: saved === false && { title: 'Sauvegarder la configuration ?', text: 'La configuration actuelle devient celle chargée au démarrage du switch.', cmd: 'write memory', label: 'Bilan : configuration sauvegardée' } });

    // spanning-tree : activé si le relevé ou la configuration le dit ; désactivé seulement si la configuration le confirme
    // (un relevé incomplet, sans la section spanning-tree, ressemble à un spanning-tree désactivé)
    const stpOn = DIAG?.stp?.enabled === true || Object.values(DIAG?.ports || {}).some((v) => v?.stp) || cfg?.stp === true;
    const stpOff = !stpOn && Boolean(cfg) && !cfg.stp;
    add({ id: 'stp', title: 'Protection contre les boucles (spanning-tree)', st: stpOn ? 'ok' : stpOff ? 'fix' : 'unknown',
      text: stpOn ? `Activé${DIAG?.stp?.protocol ? ` (${DIAG.stp.protocol})` : ''}.`
        : stpOff ? 'Le spanning-tree est désactivé : un câble branché en boucle (ou un petit switch mal branché) peut bloquer tout le réseau de la salle.'
          : DIAG ? 'Le relevé ne montre pas de spanning-tree actif : à confirmer avec la configuration du switch.' : 'Relevé du switch en attente.',
      fix: stpOff && { title: 'Activer le spanning-tree ?', text: 'Protège le réseau contre les boucles. Le lien vers l’autre switch peut se couper quelques secondes pendant la mise en route.',
        cmd: 'configure terminal\nspanning-tree\nend', label: 'Bilan : spanning-tree activé' } });

    // protections des ports de postes
    const { stations, gear } = stationPorts(cfg), gaps = {};
    const skip = gear.length ? ` ${gear.length > 1 ? `Ports ${nums(gear.map((p) => p.port))} non touchés` : `Port ${portNum(gear[0].port)} non touché`} : borne Wi-Fi ou switch probable (trunk, plusieurs appareils ou voisin LLDP).` : '';
    const PROT = [
      ['loop', 'protect-loop', 'Anti-boucle sur les ports de postes (loop-protect)', 'loop-protect',
        'Si un câble est branché en boucle sur une prise de la salle, le switch coupe seulement ce port au lieu de laisser tomber tout le réseau.'],
      ['edge', 'protect-edge', 'Ports de postes en mode périphérie (admin-edge)', 'spanning-tree port-type admin-edge',
        'Le PC a le réseau tout de suite à son démarrage, sans attendre le spanning-tree.'],
      ['bpdu', 'protect-bpdu', 'Garde BPDU sur les ports de postes (BPDU guard)', 'spanning-tree bpdu-guard',
        'Si quelqu’un branche un switch sur une prise de la salle, ce port est coupé avant de perturber le réseau.'],
    ];
    const prot = [];
    for (const [k, id, title, line, why] of PROT) {
      if (!cfg) { add({ id, title, st: 'unknown', text: noCfg, cfg: true }); continue; }
      const miss = stations.filter((p) => !cfg.prot(p.port)[k]).map((p) => p.port);
      for (const port of miss) (gaps[port] ||= []).push(line);
      prot.push(add({ id, title, cfg: true, ports: miss, st: miss.length ? 'fix' : 'ok',
        text: (!stations.length ? 'Aucun port de poste repéré (port cuivre avec un appareil, une description ou un nom).'
          : miss.length ? `${why} Manque sur ${miss.length} ${plural(miss.length, 'port')} de poste.` : `${why} En place sur ${stations.length > 1 ? `les ${stations.length} ports` : 'le port'} de poste.`) + skip,
        fix: miss.length && { title: `${line} sur ${miss.length} ${plural(miss.length, 'port')} ?`, ports: miss,
          text: `${why} Ports ${nums(miss)}. Les liens vers d’autres switches et le port du PC de l’agent ne sont pas touchés.${skip} Pense à sauvegarder la configuration ensuite.`,
          cmd: blocks(Object.fromEntries(miss.map((p) => [p, [line]]))), label: `Bilan : ${line} (ports ${nums(miss)})` } }));
    }
    const fixing = prot.filter((c) => c.st === 'fix');
    if (fixing.length > 1) {
      const gp = Object.keys(gaps);
      fixing[0].fixAll = { title: `Protéger ${gp.length} ${plural(gp.length, 'port')} de poste ?`, ports: gp,
        text: `Ajoute en une fois les protections qui manquent (loop-protect, admin-edge, BPDU guard) sur les ports ${nums(gp)}. Les liens vers d’autres switches et le port du PC de l’agent ne sont pas touchés.${skip}`,
        cmd: blocks(gaps), label: `Bilan : protections des ports (${nums(gp)})` };
    }

    // NTP
    if (!cfg) add({ id: 'ntp', title: 'Heure du switch (NTP)', st: 'unknown', text: noCfg, cfg: true });
    else if (!cfg.ntpServers.length || !cfg.ntpEnabled) {
      const lines = [!cfg.ntpServers.length && `ntp server ${NTP_IP} iburst`, 'ntp enable'].filter(Boolean);
      add({ id: 'ntp', title: 'Heure du switch (NTP)', st: 'fix', cfg: true,
        text: cfg.ntpServers.length ? 'Un serveur de temps est configuré mais NTP n’est pas activé : l’heure du switch peut dériver.'
          : 'Aucun serveur de temps : après une coupure de courant, l’horloge du switch repart de zéro et les dates du journal et des alertes deviennent fausses.',
        fix: { title: 'Configurer l’heure du switch ?', cmd: ['configure terminal', ...lines, 'end'].join('\n'), label: 'Bilan : heure du switch (NTP)',
          text: `${cfg.ntpServers.length ? '' : `${NTP_IP} est le serveur de temps public de Cloudflare : le switch doit pouvoir joindre Internet (passerelle configurée). `}Pense à sauvegarder la configuration ensuite.` } });
    } else add({ id: 'ntp', title: 'Heure du switch (NTP)', st: 'ok', cfg: true, text: `${plural(cfg.ntpServers.length, 'Serveur')} de temps : ${cfg.ntpServers.join(', ')}.` });

    // communauté SNMP par défaut : la sauvegarde (et la lecture directe) masque les communautés mais laisse en clair
    // « public » et « private », connues de tous ; une valeur <masqué> est donc une communauté personnelle.
    if (!cfg) add({ id: 'snmp', title: 'Communauté SNMP par défaut', st: 'unknown', text: noCfg, cfg: true });
    else {
      const comms = cfg.communities.map((c) => c.replace(/^"(.*)"$/, '$1'));
      const weak = [...new Set(comms.filter((c) => /^(public|private)$/i.test(c)))];
      const hidden = comms.some((c) => c === MASK);
      const masked = comms.some((c) => c !== MASK && (!/^[\w.-]+$/.test(c) || /^\*+$|masqu/i.test(c))); // autre masquage : invérifiable
      if (weak.length) add({ id: 'snmp', title: 'Communauté SNMP par défaut', st: 'fix', cfg: true,
        text: `Communauté « ${weak.join(' », « ')} » : n’importe quel appareil du réseau peut lire les informations du switch avec ce mot de passe connu de tous.`,
        fix: { title: 'Supprimer la communauté SNMP par défaut ?', cmd: ['configure terminal', ...weak.map((c) => `no snmp-server community ${c}`), 'end'].join('\n'), label: 'Bilan : communauté SNMP par défaut supprimée',
          text: 'Si un logiciel de supervision interroge le switch en SNMP, donne-lui ensuite une communauté personnelle. Pense à sauvegarder la configuration.' } });
      else if (masked) add({ id: 'snmp', title: 'Communauté SNMP par défaut', st: 'unknown', cfg: true, text: 'La communauté SNMP est masquée ou chiffrée dans la configuration lue : impossible de vérifier qu’elle n’est pas « public ».' });
      else add({ id: 'snmp', title: 'Communauté SNMP par défaut', st: 'ok', cfg: true, text: !comms.length ? 'Aucune communauté SNMP : rien n’est lisible par ce moyen.'
        : hidden ? 'Communauté SNMP personnelle (masquée dans la sauvegarde : ce n’est ni « public » ni « private »).' : 'Communauté SNMP personnelle.' });
    }

    // ports inutilisés activés (correction optionnelle)
    const unused = ports.filter((p) => p.type === '1GbT' && p.enabled && !p.up && !String(p.desc || '').trim() && !sensitive(p)
      && cableOf(p.port)?.kind === 'empty' && !lastMacOf(p.port));
    add({ id: 'unused', title: 'Ports inutilisés activés', st: unused.length ? 'watch' : 'ok', ports: unused.map((p) => p.port),
      text: unused.length ? `${unused.length} ${plural(unused.length, 'port')} sans câble, sans description et sans appareil connu ${plural(unused.length, 'reste', 'restent')} ${plural(unused.length, 'activé', 'activés')} : n’importe qui peut y brancher un appareil. Les désactiver est optionnel ; il faudra les réactiver avant d’y brancher un PC.`
        : 'Aucun port inutilisé activé parmi ceux dont le câble a été vérifié.',
      fix: unused.length && { title: `Désactiver ${unused.length} ${plural(unused.length, 'port')} inutilisé${unused.length > 1 ? 's' : ''} ?`, ports: unused.map((p) => p.port),
        text: `Ports ${nums(unused.map((p) => p.port))} : aucun câble branché d’après le dernier test. Un appareil branché plus tard n’aura pas de réseau tant que le port n’est pas réactivé.`,
        cmd: blocks(Object.fromEntries(unused.map((p) => [p.port, ['shutdown']]))), label: `Bilan : ports inutilisés désactivés (${nums(unused.map((p) => p.port))})` },
      fixLabel: 'Désactiver (optionnel)' });

    // informations sur les ports (lien qui ouvre le port)
    const down = ports.filter((p) => pState(p) === 'down');
    const fault = down.filter((p) => cableOf(p.port)?.kind === 'fault'), partial = down.filter((p) => cableOf(p.port)?.kind === 'partial');
    add({ id: 'cables', title: 'Câbles en défaut', st: fault.length ? 'fix' : partial.length ? 'watch' : 'ok', ports: [...fault, ...partial].map((p) => p.port),
      text: fault.length ? `Câble abîmé (court-circuit ou fil coupé) sur ${onPorts(fault)} : change le cordon ou fais vérifier la prise.${partial.length ? ` Fil coupé sur ${onPorts(partial)}.` : ''}`
        : partial.length ? `Un fil est coupé sur ${onPorts(partial)} : le lien ne pourra pas monter à 1 Gb/s.` : 'Aucun câble en défaut parmi les ports testés.' });
    const slow = ports.filter(isSlow);
    add({ id: 'slow', title: 'Ports lents (10 ou 100 Mb/s)', st: slow.length ? 'watch' : 'ok', ports: slow.map((p) => p.port),
      text: slow.length ? `${Ports(slow)} : souvent un PC en veille (sa carte réseau ralentit). Sinon, câble abîmé ou vieille carte réseau.` : 'Tous les liens cuivre sont à 1 Gb/s.' });
    const flappy = DIAG ? ports.filter((p) => (DIAG.flaps?.[p.port] || 0) >= 4) : [];
    add({ id: 'flaps', title: 'Ports instables', st: !DIAG ? 'unknown' : flappy.length ? 'watch' : 'ok', ports: flappy.map((p) => p.port),
      text: !DIAG ? 'Relevé du switch en attente.' : flappy.length ? `Le lien se coupe et revient sans arrêt sur ${onPorts(flappy)} : câble, prise ou appareil qui redémarre en boucle.` : 'Aucun port instable ces dernières minutes.' });
    const blocked = DIAG ? ports.filter(stpBlocked) : [];
    add({ id: 'blocked', title: 'Ports bloqués par le spanning-tree', st: !DIAG ? 'unknown' : blocked.length ? 'watch' : 'ok', ports: blocked.map((p) => p.port),
      text: !DIAG ? 'Relevé du switch en attente.' : blocked.length ? `${Ports(blocked)} : le switch ${plural(blocked.length, 'le', 'les')} coupe pour éviter une boucle. Normal pour un lien de secours entre switches, sinon cherche un câble en trop.` : 'Aucun port bloqué.' });
    // ports activés mais coupés par une protection (BPDU guard, loop-protect) : règle du diagnostic (ADMIN.portGuard)
    if (isFn(ADMIN.portGuard)) {
      const guarded = ports.filter((p) => ADMIN.portGuard(p));
      add({ id: 'guarded', title: 'Ports coupés par une protection', st: guarded.length ? 'watch' : 'ok', ports: guarded.map((p) => p.port),
        text: guarded.length ? `${Ports(guarded)} : le switch ${plural(guarded.length, 'l’a coupé', 'les a coupés')} (BPDU guard ou loop-protect) : petit switch, borne Wi-Fi ou câble en boucle sur la prise. Ouvre le port pour savoir quoi faire et le réactiver.`
          : 'Aucun port coupé par une protection du switch.' });
    }

    // température et processeur
    const temps = arr(S.temps).filter((t) => Number.isFinite(Number(t.temp)));
    if (!temps.length) add({ id: 'temp', title: 'Température', st: 'unknown', text: 'Pas encore de mesure.' });
    else {
      const max = temps.reduce((a, b) => (Number(b.temp) > Number(a.temp) ? b : a)), lim = Number(SETTINGS?.tempMax) || 70;
      const alarm = temps.filter((t) => t.status && t.status !== 'normal'), m = Number(max.temp);
      add({ id: 'temp', title: 'Température', st: alarm.length || m >= lim ? 'fix' : m >= lim - 10 ? 'watch' : 'ok',
        text: `${nf.format(m)} °C au plus (${max.sensor || 'capteur'}), seuil d’alerte ${lim} °C.${alarm.length ? ` ${alarm.length} ${plural(alarm.length, 'capteur')} en alerte.` : ''}${alarm.length || m >= lim - 10 ? ' Vérifie la ventilation de la baie et que rien ne bouche les aérations du switch.' : ''}` });
    }
    if (S.cpu == null || !Number.isFinite(Number(S.cpu))) add({ id: 'cpu', title: 'Processeur et mémoire', st: 'unknown', text: 'Pas encore de mesure.' });
    else {
      const cpu = Number(S.cpu), mem = Number(S.mem);
      add({ id: 'cpu', title: 'Processeur et mémoire', st: cpu >= 90 ? 'fix' : cpu >= 70 || mem >= 90 ? 'watch' : 'ok',
        text: `Processeur ${nf0.format(cpu)} %${Number.isFinite(mem) && S.mem != null ? `, mémoire ${nf0.format(mem)} %` : ''}.${cpu >= 70 ? ' Un processeur très chargé vient souvent d’une boucle réseau ou d’un flot de broadcast : regarde les ports bloqués et instables.' : ''}` });
    }

    // agent
    const av = S.agent?.version, semver = /^\d+\.\d+/.test(String(av ?? '')), maj = S.agent?.maj;
    if (!S.agent) add({ id: 'agent', title: 'Agent à jour', st: 'unknown', text: 'L’agent n’a pas encore donné sa version.' });
    else if (!semver || verNum(av) < verNum(AGENT_LATEST)) {
      const auto = semver && verNum(av) >= verNum('1.3.0');
      add({ id: 'agent', title: 'Agent à jour', st: 'fix',
        text: `${semver ? `Agent v${av}` : 'Agent très ancien (avant la 1.0.0)'} : la version ${AGENT_LATEST} est disponible (ping, Wake-on-LAN, rythme réglable).${maj && !maj.ok && maj.msg ? ` La mise à jour automatique a échoué : ${maj.msg}.` : ''} ${auto
          ? 'Elle s’installe toute seule en 5 minutes environ ; pour forcer, lance mettre-a-jour.bat dans le dossier de l’agent, sur son PC.'
          : 'Sur le PC de l’agent, installe la nouvelle version en suivant agent/INSTALLATION-WINDOWS.md (les versions suivantes se mettront à jour toutes seules).'}` });
    } else add({ id: 'agent', title: 'Agent à jour', st: 'ok', text: `Agent v${av} sur ${S.agent.host || 'son PC'}.` });

    // dernière sauvegarde de la configuration
    const bt = Math.max(newestT(X.cfg), HL.cfg?.src === 'backup' ? HL.cfg.t : 0), canSave = isFn(ADMIN.requestBackup);
    const save = canSave && { id: 'backup', label: 'Sauvegarder maintenant' };
    if (!bt && !canSave && X.cfg == null) add({ id: 'backup', title: 'Sauvegarde de la configuration', st: 'unknown', text: 'La sauvegarde de la configuration n’est pas disponible dans ce dashboard.' });
    else if (!bt) add({ id: 'backup', title: 'Sauvegarde de la configuration', st: 'fix', act: save, text: 'Aucune sauvegarde de la configuration : en cas de panne ou d’erreur, impossible de revenir en arrière.' });
    else if (NOW - bt > WEEK) add({ id: 'backup', title: 'Sauvegarde de la configuration', st: 'fix', act: save, text: `Dernière sauvegarde le ${when(bt)}, il y a ${Math.floor((NOW - bt) / 86400)} jours : fais-en une nouvelle.` });
    else add({ id: 'backup', title: 'Sauvegarde de la configuration', st: 'ok', text: `Dernière sauvegarde le ${when(bt)}.` });

    return list.map((c) => withRun(c, src));
  }

  // État de la dernière correction envoyée depuis le bilan : en cours, refusée par le switch, ou appliquée
  // (une vérification qui dépend de la configuration reste « à surveiller » jusqu'à la prochaine lecture).
  function withRun(c, src) {
    if (!c.fix && !c.fixAll && !c.cfg) return c;
    const kinds = [`health:${c.id}`, ...(c.id.startsWith('protect-') ? ['health:protect-all'] : [])];
    const run = LOG.find((x) => kinds.includes(x.kind));
    if (!run) return c;
    const t = run.finished || run.created;
    if (RUNNING.includes(run.status)) return { ...c, run: 'Correction en cours sur le switch…' };
    const out = OUT[run.id], err = typeof out === 'string' ? switchError(out) : null;
    if ((err || run.status === 'error') && c.st !== 'ok' && NOW - t < 86400) {
      return { ...c, err: err ? `Le switch a refusé la correction${err.cmd ? ` (ligne « ${err.cmd} »)` : ''} : « ${err.line} ». Ce firmware ne reconnaît peut-être pas cette commande : corrige à la main dans la console.`
        : 'La correction a échoué (détail dans la console).' };
    }
    if (run.status === 'done' && !err && c.cfg && c.st === 'fix' && (!src || t > src.t)) {
      return { ...c, st: 'watch', fix: null, fixAll: null, done: `Correction appliquée le ${when(t)}. Le bilan la confirmera à la prochaine lecture de la configuration.` };
    }
    return c;
  }

  // ---------------------------------------------------------------- lecture de la configuration
  async function loadConfig() {
    if (ROLE !== 'admin') return;
    if (!isFn(ADMIN.latestConfig)) { HL.state = 'unavailable'; return refresh(); }
    if (HL.loading) return HL.loading;
    HL.lastTry = Date.now();
    if (!HL.cfg) HL.state = 'loading';
    HL.loading = (async () => {
      try {
        const c = await ADMIN.latestConfig();
        // Lue à la dernière relecture qui a trouvé ce texte (« last » de la version en tête de X.cfg), sinon à sa création.
        const top = arr(X.cfg)[0];
        const t = Math.max(newestT(c?.t), top && (!c?.id || top.id === c.id) ? newestT(top) : 0) || NOW;
        if (c && typeof c.text === 'string' && c.text.trim()) {
          const parsed = parseConfig(c.text);
          if (parsed.nIfs) HL.cfg = { t, parsed, src: 'backup' };
        }
        HL.state = HL.cfg ? 'ready' : 'none'; HL.err = '';
      } catch (e) {
        HL.err = String(e?.message || e || '').slice(0, 200);
        HL.state = HL.cfg ? 'ready' : 'error';
      } finally { HL.loading = null; }
      refresh();
    })();
    return HL.loading;
  }
  // « Lire la configuration du switch » : sauvegarde immédiate (tâche backup), sinon lecture directe silencieuse.
  async function readSwitchConfig() {
    if (!canAdmin()) return;
    Object.assign(HL, { asked: Date.now(), askedAt: NOW, askId: null, askDone: 0, askFail: false });
    renderDlg();
    try {
      // la sauvegarde affiche elle-même son suivi (toast « bk-req ») : aucun toast ici ; la lecture directe (sans
      // tâche backup) est masquée de la console, on la signale donc nous-mêmes
      if (isFn(ADMIN.requestBackup)) HL.askId = (await ADMIN.requestBackup())?.id || null;
      else {
        HL.askId = (await api('/api/command', { cmd: 'show running-config', label: 'Bilan de santé : lecture de la configuration', kind: 'auto:health' }))?.id || null;
        toast('Lecture de la configuration demandée', { sub: 'Le bilan se met à jour dès qu’elle arrive.' });
        setTimeout(poll, 800);
      }
    } catch (e) {
      HL.asked = 0;
      if (e?.message !== '401') toast('Impossible de lire la configuration', { type: 'error', sub: e?.message || '' });
    }
    renderDlg();
  }

  // ---------------------------------------------------------------- fenêtre
  function cfgLine(admin) {
    const c = currentCfg();
    const btn = (label) => (admin ? ` <button class="btn small" type="button" data-health-act="readcfg">${label}</button>` : '');
    if (HL.asked) return '<span class="spinner"></span> Lecture de la configuration du switch en cours…';
    if (c) return `${HL.askFail ? '<span class="warn">La lecture n’a rien donné : réessaie.</span> ' : ''}Configuration lue le ${when(c.t)} (${c.src === 'direct' ? 'lecture directe' : 'dernière sauvegarde'}).${NOW - c.t > 86400 ? ' Elle date un peu : relis-la pour un bilan à jour.' : ''}${btn('Relire la configuration')}`;
    if (HL.state === 'loading') return '<span class="spinner"></span> Lecture de la dernière sauvegarde…';
    const why = HL.askFail ? 'La lecture n’a rien donné : réessaie.' : HL.state === 'error' ? `Sauvegarde illisible (${esc(HL.err)}).` : 'La configuration du switch n’a pas encore été lue.';
    return `<span class="warn">${why}</span> Les vérifications qui en dépendent restent « inconnu ».${btn('Lire la configuration du switch')}`;
  }
  function rowHTML(c, admin) {
    const chips = c.ports.length ? `<div class="diagnose-hports">${c.ports.map((port) => `<button type="button" class="chip" data-health-port="${esc(port)}" title="Ouvrir le port ${portNum(port)}">${portNum(port)}</button>`).join('')}</div>` : '';
    const btns = admin && !c.run ? [
      c.fix && `<button class="btn small${c.st === 'fix' ? ' primary' : ''}" type="button" data-health-fix="${esc(c.id)}">${esc(c.fixLabel || 'Corriger')}</button>`,
      c.fixAll && '<button class="btn small" type="button" data-health-fix="protect-all">Corriger les trois protections</button>',
      c.act && `<button class="btn small" type="button" data-health-act="${esc(c.act.id)}">${esc(c.act.label)}</button>`,
    ].filter(Boolean).join('') : '';
    return `<div class="diagnose-hc"><span class="diagnose-hst ${c.st}">${ST[c.st][0]}</span><div class="diagnose-hb"><b>${esc(c.title)}</b>
      <div class="note">${esc(c.text)}</div>${chips}
      ${c.run ? `<div class="note"><span class="spinner"></span> ${esc(c.run)}</div>` : ''}
      ${c.done ? `<div class="alert green">${esc(c.done)}</div>` : ''}${c.err ? `<div class="alert red">${esc(c.err)}</div>` : ''}
      ${btns ? `<div class="row admin-only">${btns}</div>` : ''}</div></div>`;
  }
  function renderDlg(list) {
    if (!HL.dlg?.open || !HL.body) return;
    if (!S) return setHTML(HL.body, '<div class="empty">En attente des données du switch…</div>');
    const admin = canAdmin();
    list = (list || checks()).map((c, i) => ({ c, i })).sort((a, b) => ST[a.c.st][1] - ST[b.c.st][1] || a.i - b.i).map((x) => x.c);
    const count = (st) => list.filter((c) => c.st === st).length;
    const sum = [['fix', 'à corriger', 'badge red'], ['watch', 'à surveiller', 'badge amber'], ['unknown', 'inconnu', 'badge'], ['ok', 'OK', 'badge diagnose-ok']]
      .filter(([st]) => count(st)).map(([st, l, cls]) => `<span class="${cls}">${count(st)} ${l}</span>`).join('');
    const okList = list.filter((c) => c.st === 'ok'), rest = list.filter((c) => c.st !== 'ok');
    setHTML(HL.body, `<div class="diagnose-hsum">${sum}</div>
      <p class="note" style="margin:0 0 6px">${cfgLine(admin)}</p>
      <div class="diagnose-hlist">${rest.map((c) => rowHTML(c, admin)).join('') || '<div class="alert green" style="margin:8px 0">Rien à corriger : le switch est en bonne santé.</div>'}</div>
      ${okList.length ? `<details class="diagnose-hok"${HL.okOpen ? ' open' : ''}><summary>${okList.length} ${plural(okList.length, 'vérification')} OK</summary><div class="diagnose-hlist">${okList.map((c) => rowHTML(c, admin)).join('')}</div></details>` : ''}`);
  }
  function openDlg() {
    if (!canAdmin()) return;
    if (!HL.dlg) {
      const d = document.createElement('dialog');
      d.className = 'wide diagnose-health';
      d.setAttribute('aria-label', 'Bilan de santé du switch');
      const head = document.createElement('h3');
      head.textContent = 'Bilan de santé du switch';
      const body = document.createElement('div');
      const foot = document.createElement('div');
      foot.className = 'actions';
      foot.innerHTML = '<button class="btn" type="button" data-health-act="close">Fermer</button>';
      d.append(head, body, foot);
      document.body.append(d);
      d.addEventListener('click', onClick);
      // garde la liste des vérifications OK ouverte ou fermée d'un affichage à l'autre
      d.addEventListener('toggle', (e) => { if (e.target.classList?.contains('diagnose-hok')) HL.okOpen = e.target.open; }, true);
      Object.assign(HL, { dlg: d, body });
    }
    if (!HL.dlg.open) HL.dlg.showModal();
    renderDlg();
    if (Date.now() - HL.lastTry > 60000) loadConfig();
  }
  function onClick(e) {
    const a = e.target.closest('[data-health-act]'), f = e.target.closest('[data-health-fix]'), pt = e.target.closest('[data-health-port]');
    if (a?.dataset.healthAct === 'close') return HL.dlg.close();
    if (pt && PORT_RE.test(pt.dataset.healthPort || '') && portOf(pt.dataset.healthPort)) {
      HL.dlg.close();
      if (isFn(ADMIN.diagnose)) ADMIN.diagnose(pt.dataset.healthPort); else selectPort(pt.dataset.healthPort);
      return;
    }
    if (!canAdmin()) return;
    // « Sauvegarder maintenant » et « Lire la configuration » : une sauvegarde est aussi une lecture de la configuration.
    if (['readcfg', 'backup'].includes(a?.dataset.healthAct)) return void readSwitchConfig();
    if (f) fixIt(f.dataset.healthFix);
  }
  // Ouvre la confirmation avec les lignes exactes (recalculées à l'instant du clic).
  function fixIt(id) {
    const list = checks();
    const c = id === 'protect-all' ? list.find((x) => x.fixAll) : list.find((x) => x.id === id);
    const f = id === 'protect-all' ? c?.fixAll : c?.fix;
    if (!f) return toast('Plus rien à corriger ici', { sub: 'L’état du switch a changé depuis l’affichage.' });
    if (arr(f.ports).some((port) => !PORT_RE.test(port) || !portOf(port) || sensitive(portOf(port)))) {
      return toast('Correction refusée', { type: 'error', sub: 'Elle toucherait un lien vers un autre switch ou le port du PC de l’agent.' });
    }
    confirmCmd(f.title, f.text, f.cmd, String(f.label).slice(0, 120), { ports: arr(f.ports), kind: `health:${id}` });
  }

  // ---------------------------------------------------------------- badge, suivi des corrections
  function refresh(list) {
    if (!HL.tool) return;
    const c = HL.asked || HL.askFail ? currentCfg() : null, run = HL.asked && HL.askId ? LOG.find((x) => x.id === HL.askId) : null;
    if (c && c.t >= HL.askedAt - 5) Object.assign(HL, { asked: 0, askFail: false }); // la configuration demandée est arrivée
    else if (HL.asked) {
      if (run?.status === 'error') Object.assign(HL, { asked: 0, askFail: true });
      else if (run?.status === 'done' && Date.now() - (HL.askDone ||= Date.now()) > 30000) Object.assign(HL, { asked: 0, askFail: true });
    }
    list = list || (S ? checks() : []);
    const n = list.filter((c) => c.st === 'fix').length, b = n ? String(n) : '';
    if (HL.tool.badge !== b) { HL.tool.badge = b; renderTools(); }
    renderDlg(list);
  }
  // Correction « terminée » mais refusée par le switch (syntaxe) : on le dit au lieu de laisser croire à un succès.
  function warnRefused() {
    for (const c of LOG) {
      if (!String(c.kind || '').startsWith('health:') || c.status !== 'done' || HL.warned.has(c.id) || typeof OUT[c.id] !== 'string') continue;
      HL.warned.add(c.id);
      const err = switchError(OUT[c.id]);
      if (err && NOW - (c.finished || c.created) < 600) toast(c.label || 'Correction du bilan', { id: c.id, type: 'error', timeout: 15000, sub: `Refusée par le switch : « ${err.line} ». Rien n’a été changé pour cette ligne.` });
    }
  }

  const css = document.createElement('style');
  css.textContent = `
.diagnose-hsum { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 10px; }
.badge.diagnose-ok { background: var(--good-soft); color: var(--good); }
.diagnose-hc { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.diagnose-hlist > .diagnose-hc:last-child { border-bottom: 0; }
.diagnose-hb { display: grid; gap: 4px; min-width: 0; }
.diagnose-hb .note { overflow-wrap: anywhere; }
.diagnose-hb .alert { margin: 2px 0 0; }
.diagnose-hb .row { flex-wrap: wrap; margin-top: 2px; }
.diagnose-hst { justify-self: start; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; background: var(--surface-2); color: var(--text-3); }
.diagnose-hst.ok { background: var(--good-soft); color: var(--good); }
.diagnose-hst.watch { background: var(--warn-soft); color: var(--warn); }
.diagnose-hst.fix { background: var(--bad-soft); color: var(--bad); }
.diagnose-hports { display: flex; flex-wrap: wrap; gap: 4px; }
.diagnose-hports .chip { min-width: 30px; text-align: center; }
.diagnose-hok { margin-top: 8px; }
.diagnose-hok summary { cursor: pointer; font-size: 12.5px; color: var(--text-2); padding: 6px 0; }
.diagnose-health .warn { color: var(--warn); }
@media (max-width: 560px) { .diagnose-hc { grid-template-columns: minmax(0, 1fr); gap: 6px; } }`;
  document.head.append(css);

  HL.tool = { id: 'health', label: 'Bilan de santé', title: 'Vérifie la configuration et l’état du switch, et propose les corrections', open: openDlg,
    icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>' };
  addTool(HL.tool);
  HOOK.render.push(() => { if (ROLE === 'admin') { warnRefused(); refresh(); } }); // écran lecture seule : rien à calculer
  HOOK.poll.push((d) => {
    if (ROLE !== 'admin') return;
    if (HL.asked && Date.now() - HL.asked > 180000) { HL.asked = 0; HL.askFail = true; }
    // Première lecture de l'état, puis à chaque nouvelle sauvegarde (X.cfg change).
    if (!HL.first || (d?.x && Object.hasOwn(d.x, 'cfg'))) { HL.first = true; loadConfig(); }
    // Sauvegarde demandée mais pas de X.cfg pour la signaler : on relit toutes les 20 s pendant 3 min au plus.
    else if (HL.asked && !Object.hasOwn(XV, 'cfg') && isFn(ADMIN.requestBackup) && Date.now() - HL.lastTry > 20000) loadConfig();
  });
  HOOK.role.push((ro) => { if (ro) HL.dlg?.close(); });

  ADMIN.healthChecks = (cfgText) => checks(cfgText == null ? undefined : String(cfgText));
  ADMIN.openHealth = openDlg;
})();
