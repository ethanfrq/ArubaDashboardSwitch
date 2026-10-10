// Allumer des PC à distance (Wake-on-LAN) et ping depuis le PC de l'agent (agent 1.4.0 et plus, capacités 'wol' et 'ping').
// Fournit ADMIN.wake(ports) et ADMIN.ping(ip) ; ajoute la section « Allumer à distance » au volet d'un port éteint
// et l'outil « Allumer des PC » dans la carte Administration. L'agent fait lui-même les lignes « #wol » et « #ping »
// (rien n'est envoyé au switch, aucune session SSH n'est ouverte pour elles).
// IIFE en mode strict : seules ADMIN.wake et ADMIN.ping sont exposées.
(() => {
  'use strict';
  const PER_LINE = 64;  // adresses au plus par ligne « #wol » (limite de l'agent et du serveur)
  const PER_PORT = 4;   // adresses au plus par port (PC et machine virtuelle, téléphone IP et PC derrière…)
  const PING_MAX = 30000, PING_RELOAD = 2000; // ping : attente maximale, relecture de l'état pendant l'attente (ms)
  const NEED_AGENT = 'Allumer un PC à distance demande l’agent 1.4.0 ou plus. Il se met à jour tout seul (mise à jour automatique, quelques minutes) : réessaie ensuite.';
  const ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>';

  // ---------------------------------------------------------------- outils
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  // « AA-BB-CC-DD-EE-FF » -> « aa:bb:cc:dd:ee:ff » ; null si invalide, multicast ou nulle (aucune carte réseau n'a ces adresses).
  function normMac(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase().replace(/-/g, ':');
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s) || parseInt(s.slice(0, 2), 16) & 1 || s === '00:00:00:00:00:00') return null;
    return s;
  }
  // « 1/1/12 » ou 12 -> « 1/1/12 » (ports 1 à 28) ; null sinon.
  function normPort(v) {
    const m = String(v ?? '').trim().match(/^(?:1\/1\/)?(\d{1,2})$/);
    return m && Number(m[1]) >= 1 && Number(m[1]) <= 28 ? `1/1/${Number(m[1])}` : null;
  }
  // Adresse IPv4 d'un appareil (pas 0.x.x.x, pas de multicast ni de diffusion) ; null sinon.
  function normIp(v) {
    const s = String(v ?? '').trim(), m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m || m.slice(1).some((x) => Number(x) > 255 || (x.length > 1 && x[0] === '0'))) return null;
    return Number(m[1]) === 0 || Number(m[1]) >= 224 ? null : s;
  }
  const portObj = (port) => arr(S?.ports).find((p) => p.port === port) || null;
  const nums = (ports) => ports.map(portNum).join(', ');
  const plural = (n, one, many) => (n > 1 ? many : one);

  // Adresses connues d'un port : présentes dans la table du switch, sinon le dernier appareil vu (annuaire).
  // Jamais sur un lien vers un autre switch : les appareils derrière ne sont pas « sur » ce port.
  function macsOf(port) {
    const p = portObj(port);
    if (p && isUplink(p)) return [];
    const live = [...new Set(arr(S?.macs).filter((m) => m.port === port).map((m) => normMac(m.mac)).filter(Boolean))];
    if (live.length) return live.slice(0, PER_PORT);
    let last = null;
    try { last = typeof ADMIN.lastMac === 'function' ? normMac(ADMIN.lastMac(port)) : null; } catch (e) { last = null; }
    last = last || normMac(obj(obj(X.lastmac)[port]).mac);
    return last ? [last] : [];
  }
  const lastOf = (port, mac) => { const e = obj(obj(X.lastmac)[port]); return normMac(e.mac) === mac ? e : {}; };
  function nameOf(port, mac) {
    let n = null;
    try { n = typeof ADMIN.deviceName === 'function' ? ADMIN.deviceName(mac) : null; } catch (e) { n = null; }
    const v = n || obj(S?.ips)[mac]?.name || lastOf(port, mac).host || '';
    return typeof v === 'string' ? v : '';
  }
  function ipOf(port, mac) {
    const v = obj(S?.ips)[mac]?.ip || lastOf(port, mac).ip || '';
    return typeof v === 'string' ? v : '';
  }
  const readonlyToast = () => toast(ROLE === 'viewer' ? 'Lecture seule' : 'Vue monitoring',
    { type: 'warn', sub: ROLE === 'viewer' ? 'Action réservée à l’administrateur.' : 'Repasse en vue admin pour gérer le switch.' });

  // ---------------------------------------------------------------- allumer (Wake-on-LAN)
  // Ports à allumer -> { found: [{ port, macs }], missing, uplink, off } (ports triés, sans doublon).
  function plan(ports) {
    const items = ports == null ? [] : typeof ports === 'object' && typeof ports[Symbol.iterator] === 'function' ? [...ports] : [ports];
    const list = [...new Set(items.map(normPort).filter(Boolean))].sort((a, b) => portNum(a) - portNum(b));
    const res = { found: [], missing: [], uplink: [], off: [] };
    for (const port of list) {
      const p = portObj(port);
      if (p && isUplink(p)) { res.uplink.push(port); continue; }
      const macs = macsOf(port);
      if (!macs.length) res.missing.push(port);
      else if (p && !p.enabled) res.off.push(port); // port coupé : le signal ne passerait pas
      else res.found.push({ port, macs });
    }
    return res;
  }
  // Lignes de commande : « #wol <mac> … », 64 adresses au plus par ligne.
  function wolLines(macs) {
    const all = [...new Set(macs.map(normMac).filter(Boolean))], out = [];
    for (let i = 0; i < all.length; i += PER_LINE) out.push(`#wol ${all.slice(i, i + PER_LINE).join(' ')}`);
    return out;
  }
  function skippedText(r) {
    return [
      r.missing.length && `aucun appareil connu sur ${plural(r.missing.length, 'le port', 'les ports')} ${nums(r.missing)} (jamais vu depuis la mise en service de l’annuaire)`,
      r.off.length && `${plural(r.off.length, 'le port', 'les ports')} ${nums(r.off)} ${plural(r.off.length, 'est désactivé', 'sont désactivés')} : active-${plural(r.off.length, 'le', 'les')} d’abord, sinon le signal ne passe pas`,
      r.uplink.length && `${plural(r.uplink.length, 'le port', 'les ports')} ${nums(r.uplink)} ${plural(r.uplink.length, 'relie', 'relient')} un autre switch`,
    ].filter(Boolean).join(' ; ');
  }

  ADMIN.wake = (ports) => {
    if (!canAdmin()) return void readonlyToast();
    const r = plan(ports), skipped = skippedText(r);
    if (!r.found.length) return void toast('Rien à allumer', { type: 'warn', sub: skipped ? `${skipped[0].toUpperCase()}${skipped.slice(1)}.` : 'Aucun port choisi.', timeout: 9000 });
    if (!agentHas('wol')) return void toast('Agent à mettre à jour', { type: 'warn', sub: NEED_AGENT, timeout: 10000 });
    const lines = wolLines(r.found.flatMap((f) => f.macs));
    const who = r.found.length <= 6
      ? r.found.map((f) => `port ${portNum(f.port)} (${f.macs.map((m) => nameOf(f.port, m) || m).join(', ')})`).join(', ')
      : `${plural(r.found.length, 'port', 'ports')} ${nums(r.found.map((f) => f.port))}`;
    const one = r.found.length === 1 ? portNum(r.found[0].port) : null;
    confirmCmd(one ? `Allumer l’appareil du port ${one} ?` : `Allumer ${r.found.length} appareils ?`,
      `Le PC de l’agent envoie le signal de réveil (Wake-on-LAN) : ${who}. L’appareil doit avoir le Wake-on-LAN activé (BIOS et carte réseau) et rester branché au secteur ; il démarre en général en moins d’une minute. Rien n’est modifié sur le switch.`
        + (skipped ? ` Ignorés : ${skipped}.` : ''),
      lines.join('\n'), one ? `Allumer le port ${one}` : `Allumer ${r.found.length} appareils`,
      { ports: r.found.map((f) => f.port), kind: 'wol' });
  };

  // Message de fin d'un réveil : l'agent a envoyé le signal (le message général parlerait du switch).
  const announced = new Set();
  function wolToasts() {
    for (const c of LOG) {
      if (c.kind !== 'wol' || announced.has(c.id) || !['done', 'error'].includes(c.status)) continue;
      announced.add(c.id);
      if (typeof TOASTS === 'undefined' || !TOASTS[c.id]) continue; // envoyé d'un autre écran ou avant le chargement
      if (c.status === 'done') toast(c.label || 'Allumer', { id: c.id, type: 'success', sub: 'Signal de réveil envoyé par l’agent : l’appareil démarre en général en moins d’une minute.', timeout: 7000 });
      else toast(c.label || 'Allumer', { id: c.id, type: 'error', sub: 'L’agent n’a pas pu envoyer le signal de réveil. Détail dans la console.', timeout: 9000 });
    }
  }

  // ---------------------------------------------------------------- ping depuis le PC de l'agent
  // ADMIN.ping(ip) -> Promise { ok (l'appareil a répondu), sent, received, avgMs (null sans réponse), raw (sortie) }.
  // Rejette si l'adresse est invalide, si l'agent n'a pas la capacité « ping », en lecture seule, en cas d'erreur
  // ou sans résultat au bout de 30 s. Un seul ping à la fois (le serveur n'en garde qu'un en attente).
  const waiters = new Set();
  let chain = Promise.resolve(), lastRead = 0;
  function settle(w, err, c) {
    waiters.delete(w); clearInterval(w.timer);
    if (err) w.reject(err); else w.resolve(c);
  }
  function checkWaiters() {
    for (const w of [...waiters]) {
      const c = LOG.find((x) => x.id === w.id);
      if (c && ['done', 'error'].includes(c.status) && (!w.needOut || OUT[w.id] !== undefined)) settle(w, null, c);
      else if (Date.now() > w.end) settle(w, Object.assign(new Error('L’agent n’a pas donné de résultat en 30 s (PC de l’agent éteint, hors ligne ou occupé).'), { code: 'timeout' }));
    }
  }
  function waitFor(id, end, needOut) {
    return new Promise((resolve, reject) => {
      const w = { id, end, needOut, resolve, reject };
      waiters.add(w);
      w.timer = setInterval(() => {
        checkWaiters();
        if (waiters.has(w) && Date.now() - lastRead > PING_RELOAD - 200) poll(); // relit l'état si la page ne l'a pas fait
      }, PING_RELOAD);
      checkWaiters();
    });
  }
  // Sortie de l'agent -> résultat. La ligne « Résultat : 3/4 réponses, 1.5 ms en moyenne » fait foi.
  function parsePing(raw, ip) {
    const text = String(raw ?? '');
    const lines = sections(text)[`#ping ${ip}`] || text.split('\n');
    let res = null;
    for (const l of lines) { const m = l.trim().match(/^Résultat : (\d+)\/(\d+) réponses(?:, (\d+(?:[.,]\d+)?) ms en moyenne)?/); if (m) { res = m; break; } }
    const err = lines.map((l) => l.trim()).find((l) => /^% |^Erreur :/.test(l));
    if (!res) return { error: err ? err.replace(/^% /, '') : 'Résultat du ping illisible.' };
    const sent = Number(res[2]), received = Number(res[1]), avg = res[3] != null ? Number(res[3].replace(',', '.')) : null;
    return { ok: received > 0, sent, received, avgMs: received > 0 && Number.isFinite(avg) ? avg : null, raw: text, ...(err ? { error: err.replace(/^% /, '') } : {}) };
  }
  async function doPing(input) {
    const ip = normIp(input);
    if (!ip) throw Object.assign(new Error('Adresse IP invalide.'), { code: 'ip' });
    if (!agentHas('ping')) throw Object.assign(new Error('Le ping demande l’agent 1.4.0 ou plus (il se met à jour tout seul, quelques minutes).'), { code: 'agent' });
    if (ROLE !== 'admin') throw Object.assign(new Error('Action réservée à l’administrateur.'), { code: 'role' });
    const cmd = `#ping ${ip}`, end = Date.now() + PING_MAX;
    let rec = null;
    for (;;) {
      rec = await api('/api/command', { cmd, label: `Ping ${ip}`, kind: 'auto:ping' });
      if (!rec?.dedup || rec.cmd === cmd) break;
      await waitFor(rec.id, end, false); // un autre ping (autre onglet) est en attente : on passe après lui
    }
    if (!rec?.id) throw new Error('Envoi du ping refusé.');
    setTimeout(poll, 600);
    const c = await waitFor(rec.id, end, true);
    const r = parsePing(OUT[rec.id], ip);
    if (r.ok === undefined) throw Object.assign(new Error(c.status === 'error' ? r.error : 'Résultat du ping illisible.'), { code: 'agent-error' });
    return r;
  }
  ADMIN.ping = (ip) => {
    const run = chain.then(() => doPing(ip));
    chain = run.catch(() => {});
    return run;
  };

  // ---------------------------------------------------------------- volet d'un port : « Allumer à distance »
  // Port sans lien, désactivé ou sans trafic (PC en veille) dont un appareil est connu ; administrateur seulement.
  HOOK.panel.push((p) => {
    if (!p?.port || !S || !canAdmin() || isUplink(p)) return '';
    if (p.enabled && p.up && pState(p) !== 'idle') return '';
    const macs = macsOf(p.port);
    if (!macs.length) return '';
    const live = arr(S.macs).some((m) => m.port === p.port), last = obj(obj(X.lastmac)[p.port]);
    const devs = macs.map((m) => {
      const name = nameOf(p.port, m), ip = ipOf(p.port, m);
      return `<div><b>${esc(name || 'Appareil sans nom')}</b> <span class="mono muted">${esc(m)}</span>${ip ? ` · <span class="mono">${esc(ip)}</span>` : ''}</div>`;
    }).join('');
    const ls = typeof ADMIN.lastSeen === 'function' ? Number(ADMIN.lastSeen(p.port)) || 0 : Number(last.t) || 0;
    const seen = !live && ls > 0 && NOW ? `<span class="note">Vu pour la dernière fois ${esc(ago(NOW - ls))}.</span>` : '';
    const run = LOG.find((c) => c.kind === 'wol' && (arr(c.ports).includes(p.port) || macs.some((m) => String(c.cmd || '').toLowerCase().includes(m))));
    const age = run && NOW - (run.finished || run.created);
    const state = !run ? ''
      : ['pending', 'running', 'confirm'].includes(run.status) ? '<div class="alert amber wol-alert"><span class="spinner"></span> Envoi du signal de réveil…</div>'
      : run.status === 'error' && age < 600 ? '<div class="alert red wol-alert">L’agent n’a pas pu envoyer le signal. Détail dans la console.</div>'
      : run.status === 'done' && age < 600 ? `<div class="alert green wol-alert">Signal envoyé ${esc(ago(age))}. Sans réaction après 2 minutes : vérifie que le Wake-on-LAN est activé dans le BIOS et sur la carte réseau, et que le PC est branché au secteur.</div>`
      : '';
    const off = !p.enabled ? '<div class="alert amber wol-alert">Le port est désactivé : active-le d’abord (bouton « Activer » ci-dessus), sinon le signal ne passe pas.</div>' : '';
    const need = agentHas('wol') ? '' : '<p class="note" style="margin:0">Demande l’agent 1.4.0 ou plus (mise à jour automatique en cours).</p>';
    return `<div class="section wol-sec"><h3>Allumer à distance</h3>${devs}${seen}${state}${off}
      <div class="row"><button class="btn" type="button" data-wol-wake="${esc(p.port)}" ${p.enabled ? '' : 'disabled'}>${ICON}Allumer l’appareil</button></div>${need}</div>`;
  });
  $('#ppBody')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wol-wake]');
    if (b && !b.disabled) ADMIN.wake([b.dataset.wolWake]);
  });

  // ---------------------------------------------------------------- outil « Allumer des PC »
  const ST_FR = { up: 'allumé', idle: 'en veille ?', down: 'éteint', off: 'port désactivé' };
  let dlg = null, pick = new Set();
  // Ports proposés : appareil connu, hors liens vers d'autres switches.
  function candidates() {
    return arr(S?.ports).filter((p) => normPort(p.port) && !isUplink(p))
      .map((p) => ({ p, macs: macsOf(p.port) })).filter((x) => x.macs.length)
      .sort((a, b) => portNum(a.p.port) - portNum(b.p.port));
  }
  function renderTool() {
    if (!dlg?.open) return;
    const list = candidates(), ok = new Set(list.filter((x) => x.p.enabled).map((x) => x.p.port));
    for (const port of [...pick]) if (!ok.has(port)) pick.delete(port);
    const body = dlg.querySelector('[data-wol-body]'), go = dlg.querySelector('[data-wol-go]');
    const all = ok.size > 0 && [...ok].every((port) => pick.has(port));
    setHTML(body, !S ? '<p class="note">En attente des données de l’agent.</p>' : `
      ${agentHas('wol') ? '' : `<div class="alert amber">${esc(NEED_AGENT)}</div>`}
      ${!list.length ? '<p class="note">Aucun appareil connu pour l’instant : un PC apparaît ici après avoir été vu au moins une fois branché et allumé.</p>' : `
      <div class="row wol-quick">
        <button type="button" class="chip${all ? ' on' : ''}" data-wol-all>Tous</button>
        <button type="button" class="chip" data-wol-sel="asleep" title="Ports sans lien ou sans trafic">Éteints</button>
        <button type="button" class="chip" data-wol-sel="none">Aucun</button>
        <span class="note">${pick.size} / ${ok.size} ${plural(pick.size, 'choisi', 'choisis')}</span>
      </div>
      <div class="wol-list">${list.map(({ p, macs }) => {
        const st = pState(p), name = nameOf(p.port, macs[0]) || macs[0];
        return `<button type="button" class="chip wol-item${pick.has(p.port) ? ' on' : ''}" data-wol-pick="${esc(p.port)}" ${p.enabled ? '' : 'disabled'} aria-pressed="${pick.has(p.port)}"
          title="${esc(`Port ${portNum(p.port)} · ${macs.join(', ')}`)}"><b class="num">${portNum(p.port)}</b><span class="wol-name">${esc(name)}</span><span class="wol-st ${st}">${ST_FR[st]}</span></button>`;
      }).join('')}</div>`}`);
    go.textContent = pick.size ? `Allumer (${pick.size})` : 'Allumer';
    go.disabled = !pick.size || !agentHas('wol');
  }
  const asleep = (p) => p.enabled && (!p.up || pState(p) === 'idle');
  function openTool() {
    if (!canAdmin()) return void readonlyToast();
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'wide wol-dlg';
      dlg.setAttribute('aria-labelledby', 'wolTitle');
      dlg.innerHTML = `<h3 id="wolTitle">Allumer des PC</h3>
        <p class="note" style="margin:0 0 12px">Le PC de l’agent envoie le signal de réveil (Wake-on-LAN) aux appareils choisis. Ils doivent avoir le Wake-on-LAN activé (BIOS et carte réseau) et être branchés au secteur.</p>
        <div data-wol-body></div>
        <div class="actions"><button type="button" class="btn" data-wol-close>Fermer</button><button type="button" class="btn primary" data-wol-go>Allumer</button></div>`;
      document.body.append(dlg);
      dlg.addEventListener('click', (e) => {
        if (e.target.closest('[data-wol-close]')) return dlg.close();
        const list = candidates().filter((x) => x.p.enabled);
        const b = e.target.closest('[data-wol-pick],[data-wol-all],[data-wol-sel],[data-wol-go]');
        if (!b || b.disabled) return;
        if (b.dataset.wolPick) { if (pick.has(b.dataset.wolPick)) pick.delete(b.dataset.wolPick); else pick.add(b.dataset.wolPick); }
        else if (b.hasAttribute('data-wol-all')) pick = list.every((x) => pick.has(x.p.port)) ? new Set() : new Set(list.map((x) => x.p.port));
        else if (b.dataset.wolSel) pick = new Set(b.dataset.wolSel === 'asleep' ? list.filter((x) => asleep(x.p)).map((x) => x.p.port) : []);
        else if (b.hasAttribute('data-wol-go')) { const sel = [...pick]; dlg.close(); return ADMIN.wake(sel); }
        renderTool();
      });
    }
    pick = new Set(candidates().filter((x) => asleep(x.p)).map((x) => x.p.port)); // par défaut : les PC éteints
    dlg.showModal();
    renderTool();
  }
  addTool({ id: 'wol', label: 'Allumer des PC', icon: ICON, title: 'Allumer à distance les PC éteints (Wake-on-LAN)', open: openTool });

  // ---------------------------------------------------------------- styles et rafraîchissement
  const style = document.createElement('style');
  style.textContent = `
.wol-sec .alert.wol-alert { margin: 0; }
.wol-sec .btn svg, .tools .btn .ic svg { vertical-align: -2px; }
.wol-quick { flex-wrap: wrap; margin-bottom: 10px; }
.wol-quick .note { margin-left: auto; }
.wol-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px; max-height: min(52vh, 420px); overflow: auto; }
.wol-item { display: flex; align-items: center; gap: 7px; text-align: left; font-family: inherit; min-width: 0; padding: 6px 9px; }
.wol-item b { font-family: var(--mono); min-width: 18px; }
.wol-item .wol-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wol-item .wol-st { font-size: 11px; color: var(--text-3); white-space: nowrap; }
.wol-item.on .wol-st { color: inherit; opacity: .75; }
.wol-item .wol-st.up { color: var(--good); }
.wol-item.on .wol-st.up { color: inherit; }
.wol-item:disabled { opacity: .5; cursor: default; }
@media (max-width: 420px) { .wol-list { grid-template-columns: 1fr; } }`;
  document.head.append(style);

  HOOK.poll.push(() => { lastRead = Date.now(); wolToasts(); checkWaiters(); renderTool(); });
  HOOK.render.push(() => { checkWaiters(); });
})();
