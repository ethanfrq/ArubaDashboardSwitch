// Annuler une modification : points de restauration créés par le switch avant chaque changement fait depuis le
// dashboard, comparaison avec la configuration actuelle et retour en arrière. Filet de sécurité : après un changement
// sensible, bandeau « Tout fonctionne ? » avec compte à rebours avant l'annulation automatique par le switch.
// Données (serveur, lib/features/undo.js) : X.undo = [{ name, t, id, label, status, cp?, undone?, error? }],
// X.autocp = { id, minutes, t, label, on?, at?, failed?, error? } (at : début du compte à rebours au plus tard).
// Fonction immédiate en mode strict : rien ne fuit dans l'espace global (seuls ADMIN.undoList et ADMIN.saveWarning).
(() => {
  'use strict';
  const NAME = /^dash-\d{12}(-\d{1,3})?$/; // points créés par le dashboard
  const ERR = /^\s*(%\s|Invalid|Error|ERROR)/;
  const AUTO_LINE = /^checkpoint auto \d+$/i;
  const SAVE_RE = /^\s*(wr(ite)?\s+mem(ory)?|copy\s+running-config\s+startup-config)\s*$/im;
  const BANNER = 'undo-autocp';   // id fixe du bandeau du filet de sécurité
  const DIFF_WAIT = 60000;        // délai max d'une comparaison (ms)
  const PICKUP = 180, STALE = 3600; // mêmes bornes que le serveur (agent joignable : compte à rebours lancé en 3 min)
  const STATUS = {
    ok: ['disponible', 'undo-ok'], pending: ['point en cours de création', ''], lost: ['point non créé', 'amber'],
    failed: ['échec de création du point', 'red'], rolledback: ['déjà annulée', ''], undone: ['déjà annulée, sans point', ''],
  };

  const css = document.createElement('style');
  css.textContent = `
.undo-intro { margin: 0 0 12px; }
.undo-list { display: grid; }
.undo-item { padding: 10px 0; border-bottom: 1px solid var(--border); display: grid; gap: 6px; min-width: 0; }
.undo-item:last-child { border-bottom: 0; }
.undo-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.undo-top b { flex: 1 1 180px; min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.undo-acts { display: flex; gap: 6px; flex-wrap: wrap; }
.undo-safety .undo-acts { margin-top: 8px; }
.undo-item .alert { margin: 0; }
.badge.undo-ok { background: var(--good-soft); color: var(--good); }
dialog pre.undo-diff { margin: 0; max-height: 260px; }
.undo-diff .undo-add { color: var(--bad); }
.undo-diff .undo-del { color: var(--good); }
.undo-cd { font: 600 13px var(--mono); align-self: center; min-width: 42px; }`;
  document.head.append(css);

  let skew = 0; // heure du serveur moins heure du navigateur (s), mise à jour à chaque lecture de l'état
  const serverNow = () => Date.now() / 1000 + skew;
  const hhmm = (t) => new Date((t - skew) * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const short = (s, n = 60) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const labelOf = (e) => String(e?.label || '').trim() || 'Changement de configuration';
  const ended = (c) => c?.status === 'done' || c?.status === 'error';

  const entries = () => arr(X.undo).filter((e) => e && typeof e === 'object' && NAME.test(String(e.name)) && Number.isFinite(Number(e.t)));
  const available = () => entries().filter((e) => e.status === 'ok');
  // Un point resté « en cours » alors que la commande est terminée n'a pas pu être créé.
  function statusOf(e) {
    if (e.status === 'failed' && e.undone) return 'undone';
    // statut venu du serveur : jamais une clé héritée (« constructor »…), qui casserait l'affichage de la liste
    if (e.status !== 'pending') return Object.hasOwn(STATUS, e.status) ? e.status : 'pending';
    const c = LOG.find((x) => x.id === e.id);
    return c && ended(c) && serverNow() - (Number(c.finished) || serverNow()) > 15 ? 'lost' : 'pending';
  }
  ADMIN.undoList = () => available().map((e) => ({ name: e.name, t: Number(e.t), id: e.id, label: labelOf(e), status: e.status }));

  // ---------------------------------------------------------------- outil « Annuler une modification »
  const tool = { id: 'undo', label: 'Annuler une modification', icon: '↶', open: openDialog,
    title: 'Revenir à la configuration d’avant un changement fait depuis le dashboard' };
  addTool(tool);
  function updateBadge() {
    const n = canAdmin() ? available().length : 0, b = n ? String(n) : '';
    if ((tool.badge || '') !== b) { tool.badge = b; renderTools(); }
  }

  let dlg = null;
  function openDialog() {
    if (!canAdmin()) return;
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'wide undo-dlg';
      dlg.setAttribute('aria-labelledby', 'undoTitle');
      dlg.innerHTML = `<h3 id="undoTitle">Annuler une modification</h3>
<p class="note undo-intro">Avant chaque changement de configuration fait depuis le dashboard, le switch garde un point de restauration. Si quelque chose ne marche plus, reviens à la configuration d’avant.</p>
<div id="undoBody"></div>
<div class="actions"><button class="btn" type="button" data-undo-close>Fermer</button></div>`;
      document.body.append(dlg);
      dlg.addEventListener('click', (ev) => {
        const b = ev.target.closest('button'); if (!b || b.disabled) return;
        if (b.hasAttribute('data-undo-close')) dlg.close();
        else if (b.dataset.undoDiff) askDiff(b.dataset.undoDiff);
        else if (b.dataset.undoRoll) rollback(b.dataset.undoRoll);
      });
    }
    renderBody();
    if (!dlg.open) dlg.showModal();
  }

  // Le HTML ne dépend pas de l'heure : il n'est remplacé que si la liste change (une comparaison en cours de lecture
  // garde son défilement, un bouton garde le focus). Les durées « il y a … » sont mises à jour à part.
  function renderBody() {
    const body = dlg?.querySelector('#undoBody'); if (!body) return;
    const list = entries(), info = autoInfo();
    const waiting = pendingKeep(info);
    const busyUndo = LOG.some((c) => c.kind === 'undo' && ['pending', 'running', 'confirm'].includes(c.status));
    let h = '';
    if (waiting) h += `<div class="alert amber undo-safety">Un changement sensible attend ta confirmation : sans réponse, le switch l’annulera tout seul vers ${esc(hhmm(info.deadline))}. Garde-le avant de revenir plus loin en arrière ou de sauvegarder la configuration.<div class="undo-acts"><button class="btn small primary" type="button" data-undo-keep="${esc(info.a.id)}">Tout fonctionne, garder</button></div></div>`;
    if (busyUndo) h += '<div class="alert amber">Une annulation est en cours sur le switch. Attends son résultat avant d’en lancer une autre.</div>';
    // point refusé par le switch : le serveur n'en ajoute plus pendant 24 h (sinon chaque changement finirait « en erreur »)
    const last = list[0];
    if (last?.status === 'failed' && serverNow() - Number(last.t) < 86400) {
      h += `<div class="alert amber">Le switch a refusé de créer le dernier point de restauration${last.error ? ` (<span class="mono">${esc(short(last.error, 120))}</span>)` : ''}. Pour que tes changements ne finissent pas en erreur, ils partent sans point de restauration pendant 24 h, puis le dashboard réessaie.</div>`;
    }
    if (!list.length) h += '<p class="note">Aucune modification récente faite depuis le dashboard. Les prochaines auront automatiquement un point de restauration.</p>';
    else h += `<div class="undo-list">${list.map((e) => itemHtml(e, waiting || busyUndo)).join('')}</div>`;
    setHTML(body, h);
    for (const s of body.querySelectorAll('[data-undo-ago]')) {
      const txt = ago(serverNow() - Number(s.dataset.undoAgo));
      if (s.textContent !== txt) s.textContent = txt;
    }
  }

  function itemHtml(e, locked) {
    const st = statusOf(e), [txt, cls] = STATUS[st], d = DIFF[e.name];
    let h = `<div class="undo-item"><div class="undo-top"><b>${esc(labelOf(e))}</b><span class="badge ${cls}">${esc(txt)}</span></div>
<div class="note"><span data-undo-ago="${Number(e.t)}"></span> · point <span class="mono">${esc(e.name)}</span>${st === 'failed' && e.error ? ` · <span class="mono">${esc(short(e.error, 120))}</span>` : ''}</div>`;
    if (st === 'ok') {
      h += `<div class="undo-acts"><button class="btn small" type="button" data-undo-diff="${esc(e.name)}"${d?.state === 'wait' ? ' disabled' : ''}>Voir ce qui sera annulé</button>`
        + `<button class="btn small danger" type="button" data-undo-roll="${esc(e.name)}"${locked ? ' disabled' : ''}>Revenir avant ce changement</button></div>`;
      if (d) h += diffHtml(d);
    }
    return `${h}</div>`;
  }

  // ---------------------------------------------------------------- comparaison avec la configuration actuelle
  const DIFF = {}; // nom du point -> { state: 'wait'|'done'|'same'|'error'|'fail'|'timeout'|'busy', id, t0, cmd, lines, err }

  function diffHtml(d) {
    if (d.state === 'wait') return '<p class="note"><span class="spinner"></span> Comparaison demandée au switch…</p>';
    if (d.state === 'busy') return '<p class="note">Une autre comparaison est déjà en cours. Réessaie dans quelques secondes.</p>';
    if (d.state === 'timeout') return '<div class="alert amber">Pas de réponse du switch en 60 s : l’agent est peut-être hors ligne. Réessaie plus tard.</div>';
    if (d.state === 'error') return `<div class="alert red">Le switch n’a pas accepté la comparaison${d.err ? ` : <span class="mono">${esc(d.err)}</span>` : ''}. Le retour en arrière reste possible, mais sans aperçu.</div>`;
    if (d.state === 'fail') return `<div class="alert red">Comparaison impossible : ${esc(d.err)}</div>`;
    if (d.state === 'same') return '<div class="alert green">Aucune différence : la configuration actuelle est déjà celle de ce point.</div>';
    const cls = (l) => (/^\s*\+(?!\+\+)/.test(l) ? 'undo-add' : /^\s*-(?!--)/.test(l) ? 'undo-del' : '');
    return `<p class="note" style="margin:0">Lignes en + : présentes maintenant, elles disparaîtront. Lignes en - : elles reviendront.</p>
<pre class="undo-diff">${d.lines.map((l) => `<span class="${cls(l)}">${esc(l)}</span>`).join('\n')}${d.cut ? '\n…' : ''}</pre>`;
  }

  // Lit la sortie de « checkpoint diff <nom> running-config ».
  function readDiff(out, cmd, status) {
    const sec = sections(out), keys = Object.keys(sec);
    const key = keys.find((k) => k === cmd) || keys.find((k) => /^checkpoint diff\b/i.test(k));
    if (!key) return { state: 'error', err: String(out || '').split('\n').map((l) => l.trim()).find(Boolean) || (status === 'error' ? '' : 'réponse vide') };
    const lines = sec[key].map((l) => l.replace(/\s+$/, ''));
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    const err = lines.find((l) => ERR.test(l));
    if (err) return { state: 'error', err: err.trim() };
    if (!lines.length) return { state: 'error', err: 'réponse vide' };
    if (lines.some((l) => /No difference/i.test(l))) return { state: 'same' };
    return { state: 'done', lines: lines.slice(0, 400), cut: lines.length > 400 };
  }

  async function askDiff(name) {
    const e = entries().find((x) => x.name === name);
    if (!e || e.status !== 'ok' || !canAdmin() || !NAME.test(name) || DIFF[name]?.state === 'wait') return;
    const cmd = `checkpoint diff ${name} running-config`;
    DIFF[name] = { state: 'wait', t0: Date.now(), cmd };
    renderBody();
    try {
      const rec = await api('/api/command', { cmd, label: 'Comparaison avant annulation', kind: 'auto:undo-diff' });
      // une seule comparaison à la fois (dédoublonnée par le serveur) : celle en cours peut concerner un autre point
      if (rec.dedup && String(rec.cmd || '').trim() !== cmd) DIFF[name] = { state: 'busy' };
      else { DIFF[name].id = rec.id; setTimeout(poll, 800); setTimeout(checkDiffs, DIFF_WAIT + 500); }
    } catch (err) {
      if (err.message === '401') delete DIFF[name];
      else DIFF[name] = { state: 'fail', err: err.message };
    }
    renderBody();
  }

  function checkDiffs() {
    let changed = false;
    for (const d of Object.values(DIFF)) {
      if (d.state !== 'wait') continue;
      const c = d.id ? LOG.find((x) => x.id === d.id) : null;
      if (c && ended(c) && OUT[d.id] !== undefined) { Object.assign(d, readDiff(OUT[d.id], d.cmd, c.status)); changed = true; }
      else if (Date.now() - d.t0 > DIFF_WAIT) { d.state = 'timeout'; changed = true; }
    }
    if (changed && dlg?.open) renderBody();
  }

  // ---------------------------------------------------------------- retour à un point
  function rollback(name) {
    const list = entries(), i = list.findIndex((x) => x.name === name), e = list[i];
    if (!e || e.status !== 'ok' || !NAME.test(name) || !canAdmin()) return;
    const newer = list.slice(0, i).filter((x) => x.status === 'ok' || (x.status === 'failed' && !x.undone)).length;
    const label = labelOf(e);
    const text = `Le switch reviendra à sa configuration d’avant « ${short(label, 80)} » (${ago(serverNow() - Number(e.t))}). `
      + `Cette modification ET toutes celles faites après seront annulées${newer ? ` (${newer} autre${newer > 1 ? 's' : ''} depuis le dashboard, et tout changement fait ailleurs)` : ', y compris un changement fait hors du dashboard'}. `
      + 'Seule la configuration active change : sauvegarde-la ensuite pour garder ce retour après un redémarrage.';
    dlg?.close();
    confirmCmd(`Revenir avant « ${short(label, 50)} » ?`, text, `checkpoint rollback ${name}`, `Annulation : ${short(label, 100)}`, { kind: 'undo' });
  }

  // ---------------------------------------------------------------- filet de sécurité
  const seen = { note: new Set(), expired: new Set(), keep: new Set(), shown: new Set(), saved: new Set() };
  let tick = null, bannerKey = '', confirmRec = null;

  // Même calcul que le serveur (timing) : l'agent exécute les commandes dans l'ordre d'envoi.
  function timing(a) {
    const t = Number(a.t) || 0, me = LOG.find((c) => c.id === a.id) || null, t0 = Number(me?.created) || t;
    let busy = 0, waiting = false;
    for (const c of LOG) {
      if (c.id === a.id || !(Number(c.created) < t0)) continue;
      if (ended(c)) busy = Math.max(busy, Number(c.finished) || 0);
      else if (t0 - Number(c.created) < STALE) waiting = true;
    }
    return { me, busy, waiting, hi: Math.max(t + PICKUP, busy + 30) };
  }
  // Lignes exécutées après « checkpoint auto » (durée d'exécution estimée quand l'agent était hors ligne à l'envoi).
  function linesAfter(cmd) {
    const l = String(cmd || '').split('\n').map((x) => x.trim()).filter(Boolean), i = l.findIndex((x) => AUTO_LINE.test(x));
    return i < 0 ? 0 : l.length - i - 1;
  }
  // Dernière ligne utile d'une sortie (erreur de l'agent : « Session console non connectée… », « Erreur : … »).
  const lastLine = (out) => String(out || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('» ')).pop() || '';

  // État de l'annulation automatique : 'wait' (pas encore exécutée), 'run' (compte à rebours), 'failed' (refusée par
  // le switch), 'notrun' (commande arrêtée avant, rien d'appliqué), 'lost' (agent coupé, résultat jamais reçu).
  // En mode 'run' : deadline = fin au plus tôt (affichée), end = fin au plus tard (après, le switch a annulé).
  function autoInfo() {
    const a = X.autocp;
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') return null;
    const label = labelOf(a), now = serverNow(), t = Number(a.t) || 0, wait = { a, label, mode: 'wait' };
    if (a.failed) return { a, label, mode: 'failed', err: String(a.error || '') };
    const min = Math.min(60, Math.max(1, Number(a.minutes) || 5));
    const { me: c, busy, waiting, hi } = timing(a);
    const fin = ended(c) ? Number(c.finished) || 0 : 0;
    let at = Number(a.at) || 0;
    if (!at && fin) { // résultat reçu, le serveur ne l'a pas encore analysé (ou la ligne n'a pas été exécutée)
      if (c.status === 'error') {
        const out = OUT[c.id];
        if (out === undefined && now - fin < 30) return wait; // sortie pas encore chargée
        const sec = sections(out), key = Object.keys(sec).find((k) => AUTO_LINE.test(k));
        // l'agent s'est arrêté avant « checkpoint auto » : les lignes du changement, après, n'ont pas été exécutées
        if (out !== undefined && !key) return { a, label, mode: 'notrun', err: lastLine(out) };
        if (now - fin < 12) return wait;
        const bad = key && sec[key].find((l) => ERR.test(l));
        if (bad) return { a, label, mode: 'failed', err: bad.trim() };
      }
      at = a.on ? Math.min(fin, hi) : fin;
    }
    if (!at) {
      // aucun résultat alors que l'agent a redonné des nouvelles bien après la fin du délai
      if (a.on && !waiting && Number(S?.received) > hi + min * 60 + 60) return { a, label, mode: 'lost', min };
      return wait;
    }
    // début au plus tôt : à l'envoi, après la commande d'avant ; agent hors ligne à l'envoi : estimé d'après la durée
    const lo = Math.min(at, Math.max(t, busy, a.on ? 0 : at - 30 - 2 * linesAfter(c?.cmd)));
    return { a, label, mode: 'run', deadline: lo + min * 60, end: at + min * 60 };
  }
  // Filet en cours, pas encore gardé dans cet onglet.
  const pendingKeep = (info) => info?.mode === 'run' && !seen.keep.has(info.a.id) && serverNow() < info.end + 15;

  // Configuration sauvegardée (write memory, seule ou à la fin du changement lui-même) pendant le délai : elle contient
  // le changement que le switch peut encore annuler.
  const savedDuring = (info) => LOG.some((c) => c.status === 'done' && SAVE_RE.test(String(c.cmd || ''))
    && Number(c.created) >= Number(info.a.t) && Number(c.created) <= info.end);
  // Pour index.html (avant « Sauvegarder la configuration ») : avertissement, ou null.
  ADMIN.saveWarning = () => {
    const info = canAdmin() ? autoInfo() : null;
    if (!pendingKeep(info)) return null;
    return `« ${short(info.label)} » attend ta confirmation. Si tu sauvegardes maintenant et que le switch l’annule ensuite, il reviendra au prochain redémarrage. Garde-le d’abord avec « Tout fonctionne, garder ».`;
  };

  function stopBanner() {
    if (TOASTS[BANNER]) dropToast(BANNER);
    bannerKey = ''; clearInterval(tick); tick = null;
  }

  // Message unique pour un filet qui n'a pas fonctionné (refusé, changement non exécuté, résultat jamais reçu).
  function noteOnce(info) {
    const { a, label } = info, id = a.id, age = serverNow() - (Number(a.t) || 0);
    if (seen.note.has(id) || age > (info.mode === 'lost' ? STALE : 900)) return;
    seen.note.add(id);
    if (info.mode === 'failed') {
      toast('Annulation automatique indisponible sur ce switch', { type: 'warn', timeout: 15000,
        sub: `${info.err ? `${info.err} · ` : ''}« ${short(label)} » est appliqué sans filet : vérifie que tout fonctionne. Tu peux encore revenir en arrière avec « Annuler une modification ».${a.failed ? ' Les prochains changements sensibles partiront sans filet pendant 24 h.' : ''}` });
    } else if (info.mode === 'notrun') {
      toast('Changement sensible non appliqué', { type: 'warn', timeout: 15000,
        sub: `${info.err ? `${short(info.err, 120)} · ` : ''}« ${short(label)} » n’a pas été exécuté : la configuration du switch n’a pas changé et aucune annulation automatique n’est en cours. Relance-le quand l’agent pourra joindre le switch.` });
    } else {
      toast('Pas de résultat pour un changement sensible', { type: 'warn', timeout: 15000,
        sub: `L’agent n’a jamais renvoyé le résultat de « ${short(label)} ». S’il a été coupé du switch par ce changement, le switch l’a annulé tout seul au bout de ${info.min} min : vérifie l’état des ports avant de le refaire.` });
    }
  }

  function updateSafety(fromPoll) {
    const info = canAdmin() ? autoInfo() : null;
    if (!info || info.mode === 'wait' || seen.keep.has(info.a.id)) return stopBanner();
    const id = info.a.id;
    if (info.mode !== 'run') { stopBanner(); noteOnce(info); return; }
    const now = serverNow(), left = info.deadline - now, saved = savedDuring(info);
    if (now > info.end + 15) { // le switch a remis la configuration d'avant
      stopBanner();
      if (!seen.expired.has(id) && (seen.shown.has(id) || now - info.end < 600)) {
        seen.expired.add(id);
        toast('Le switch a annulé le changement non confirmé', { type: 'warn', timeout: saved ? 0 : 15000,
          sub: `« ${short(info.label)} » : la configuration d’avant est revenue. Refais le changement si besoin.${saved ? ' Attention : la configuration a été sauvegardée pendant le délai et contient encore ce changement. Sauvegarde de nouveau pour qu’il ne revienne pas au prochain redémarrage.' : ''}` });
        setTimeout(poll, 0);
      }
      return;
    }
    seen.shown.add(id);
    if (saved && !seen.saved.has(id)) {
      seen.saved.add(id);
      toast('Configuration sauvegardée avant la confirmation', { type: 'warn', timeout: 15000,
        sub: `« ${short(info.label)} » n’est pas encore gardé. Garde-le maintenant, sinon le switch l’annulera mais il reviendra au prochain redémarrage.` });
    }
    // fin au plus tôt passée : le switch annule peut-être déjà, mais la confirmation peut encore arriver à temps
    const late = left <= 0, key = `${id}|${Math.round(info.deadline)}|${late}`;
    if (bannerKey !== key || (fromPoll && !TOASTS[BANNER])) { // recréé à chaque lecture s'il a été fermé
      bannerKey = key;
      toast(late ? 'Le délai est peut-être écoulé : si tout fonctionne, garde ce changement tout de suite.'
        : `Tout fonctionne ? Garde ce changement, sinon le switch l’annulera tout seul vers ${hhmm(info.deadline)}.`, {
        id: BANNER, type: 'warn', timeout: 0, sub: `${info.label}. Ne sauvegarde pas la configuration avant de l’avoir gardé.`,
        actions: `<span class="undo-cd num" data-undo-cd>${mmss(left)}</span><button class="btn small primary" type="button" data-undo-keep="${esc(id)}">Tout fonctionne, garder</button>` });
    }
    const cd = TOASTS[BANNER]?.querySelector('[data-undo-cd]');
    if (cd) cd.textContent = mmss(left);
    if (!tick) tick = setInterval(() => updateSafety(false), 1000);
  }

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-undo-keep]');
    if (b && !b.disabled) keepChange(b.dataset.undoKeep, b);
  });
  function keepChange(id, btn) {
    if (!canAdmin()) return;
    const info = autoInfo();
    busy(btn, async () => {
      try {
        const rec = await send('checkpoint auto confirm', 'Changement confirmé', { kind: 'undo:confirm' });
        if (!rec?.id) return;
        seen.keep.add(id);
        confirmRec = { id: rec.id, end: info?.mode === 'run' ? info.end : 0, label: info?.label || '' };
        stopBanner(); renderBody();
      } catch {} // send affiche déjà l'erreur
    });
  }
  // La confirmation elle-même peut échouer (délai déjà écoulé, syntaxe refusée) : on le dit clairement.
  function watchConfirm() {
    if (!confirmRec) return;
    const c = LOG.find((x) => x.id === confirmRec.id);
    if (!ended(c)) return;
    if (c.status === 'error') {
      toast('Le switch n’a pas accepté la confirmation', { type: 'error', timeout: 15000,
        sub: confirmRec.end > serverNow() ? `Il annulera sans doute « ${short(confirmRec.label)} » vers ${hhmm(confirmRec.end)}. Détail dans la console.`
          : 'Le délai était peut-être déjà écoulé. Détail dans la console.' });
    }
    confirmRec = null;
  }

  // ---------------------------------------------------------------- points d'accroche
  HOOK.poll.push((d) => {
    if (Number.isFinite(Number(d?.now)) && Number(d.now) > 0) skew = Number(d.now) - Date.now() / 1000;
    updateBadge(); checkDiffs(); watchConfirm(); updateSafety(true);
    if (dlg?.open) renderBody();
  });
  HOOK.render.push(() => checkDiffs()); // sortie d'une comparaison arrivée entre deux lectures de l'état
  HOOK.role.push((ro) => {
    if (ro) { stopBanner(); if (dlg?.open) dlg.close(); } else updateSafety(true);
    updateBadge();
  });
})();
