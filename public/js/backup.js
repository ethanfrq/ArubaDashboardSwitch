// Sauvegardes de la configuration : historique des versions (X.cfg), différences ligne par ligne, téléchargement,
// sauvegarde immédiate et points de restauration gardés par le switch (show checkpoint).
// Fournit ADMIN.latestConfig() et ADMIN.requestBackup().
(() => {
  // ---------------------------------------------------------------- fonctions pures (début)
  const BK_ERR = /^\s*(% |%Invalid|Invalid input|Error|ERROR|Erreur|Session console non connectée)/;
  const BK_DATE = /^\d{4}[-/]\d{2}[-/]\d{2}(?:[T_]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;
  const BK_TIME = /^\d{2}:\d{2}(?::\d{2})?Z?$/;
  const BK_LIMIT = 1500; // au-delà de 1 500 lignes différentes, on affiche tout l'écart comme retiré puis ajouté

  // Différence ligne par ligne (algorithme de Myers, après avoir écarté le début et la fin identiques).
  // Renvoie [{ t: '=', a, b } | { t: '-', a } | { t: '+', b }] (a, b : numéros de ligne à partir de 0).
  function diffLines(a, b) {
    const ids = new Map(), code = (l) => { let v = ids.get(l); if (v === undefined) ids.set(l, (v = ids.size)); return v; };
    const A = a.map(code), B = b.map(code), ops = [];
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    for (let i = 0; i < s; i++) ops.push({ t: '=', a: i, b: i });
    for (const o of diffMiddle(A, B, s, ea, s, eb)) ops.push(o);
    for (let i = 0; i < A.length - ea; i++) ops.push({ t: '=', a: ea + i, b: eb + i });
    return ops;
  }
  function diffMiddle(A, B, a0, a1, b0, b1) {
    const n = a1 - a0, m = b1 - b0, out = [];
    const all = () => {
      for (let i = a0; i < a1; i++) out.push({ t: '-', a: i });
      for (let j = b0; j < b1; j++) out.push({ t: '+', b: j });
      return out;
    };
    if (!n || !m) return all();
    const max = n + m, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
    let end = -1;
    search: for (let d = 0; d <= Math.min(max, BK_LIMIT); d++) {
      trace.push(v.slice(off - d - 1, off + d + 2)); // état avant le tour d (diagonales -d-1 à d+1)
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A[a0 + x] === B[b0 + y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { end = d; break search; }
      }
    }
    if (end < 0) return all();
    const rev = [];
    let x = n, y = m;
    for (let d = end; d > 0; d--) {
      const snap = trace[d], at = (k) => snap[k + d + 1], k = x - y;
      const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const px = at(pk), py = px - pk;
      while (x > px && y > py) { rev.push({ t: '=', a: a0 + x - 1, b: b0 + y - 1 }); x--; y--; }
      rev.push(x === px ? { t: '+', b: b0 + py } : { t: '-', a: a0 + px });
      x = px; y = py;
    }
    while (x > 0 && y > 0) { rev.push({ t: '=', a: a0 + x - 1, b: b0 + y - 1 }); x--; y--; }
    for (let i = rev.length - 1; i >= 0; i--) out.push(rev[i]);
    return out;
  }
  // Replie les lignes identiques à plus de `ctx` lignes d'un changement : { t: 'fold', from, n } (from : indice dans ops).
  function foldOps(ops, ctx = 3, open = new Set()) {
    const n = ops.length, keep = new Uint8Array(n), rows = [];
    for (let i = 0; i < n; i++) {
      if (ops[i].t === '=') continue;
      for (let j = Math.max(0, i - ctx); j <= Math.min(n - 1, i + ctx); j++) keep[j] = 1;
    }
    for (let i = 0; i < n;) {
      if (keep[i]) { rows.push(ops[i]); i++; continue; }
      let j = i;
      while (j < n && !keep[j]) j++;
      if (open.has(i) || j - i < 2) for (let k = i; k < j; k++) rows.push(ops[k]);
      else rows.push({ t: 'fold', from: i, n: j - i });
      i = j;
    }
    return rows;
  }
  const diffStats = (ops) => ops.reduce((s, o) => (o.t === '+' ? s.added++ : o.t === '-' ? s.removed++ : 0, s), { added: 0, removed: 0 });

  // Date d'un point de restauration (« 2024-05-02T10:15:00Z », « 2024/05/02 10:15:00 ») -> secondes, sinon null.
  function cpTime(s) {
    const m = String(s || '').match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T_ ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?(Z)?/);
    if (!m) return null;
    const p = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)];
    const ms = m[7] ? Date.UTC(...p) : new Date(...p).getTime();
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  // Nom utilisable dans « checkpoint rollback <nom> » : lettres, chiffres, « _ », « . », « - », 64 caractères au plus.
  const cpName = (name) => (/^[A-Za-z0-9][\w.-]{0,63}$/.test(String(name ?? '')) ? String(name) : null);
  // Sortie de « show checkpoint » : { rows: [{ name, type, date, t }], error }. Lignes non reconnues ignorées.
  function parseCheckpoints(text) {
    const lines = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
    const error = lines.find((l) => BK_ERR.test(l))?.trim() || null;
    const hi = lines.findIndex((l) => /\bNAME\b/i.test(l) && /\bTYPE\b/i.test(l));
    const rows = [];
    for (const l of hi >= 0 ? lines.slice(hi + 1) : lines) {
      const tk = l.trim().split(/\s+/);
      if (tk.length < 2 || /^-+$/.test(tk[0]) || BK_ERR.test(l) || tk[1] === ':' || tk[0].endsWith(':')) continue; // « Date : … »
      const di = tk.findIndex((x, i) => i > 0 && BK_DATE.test(x));
      if (hi < 0 && di < 0) continue; // sans en-tête, une ligne sans date n'est pas un point de restauration
      const name = cpName(tk[0]);
      if (!name) continue;
      let date = di > 0 ? tk[di] : '';
      if (di > 0 && BK_TIME.test(tk[di + 1] || '')) date += ' ' + tk[di + 1];
      rows.push({ name, type: tk.slice(1, di > 0 ? di : 2).join(' '), date, t: cpTime(date) });
    }
    return { rows, error };
  }
  // Nom du fichier téléchargé : <hostname>-config-AAAA-MM-JJ_HHhMM.txt (heure locale du navigateur).
  function bkFileName(host, t) {
    const h = String(host || '').replace(/[^\w.-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 40) || 'switch';
    const d = new Date(Number.isFinite(Number(t)) && Number(t) > 0 ? Number(t) * 1000 : Date.now()), p = (x) => String(x).padStart(2, '0');
    return `${h}-config-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}.txt`;
  }
  // ---------------------------------------------------------------- fonctions pures (fin)

  const KIND = 'auto:backup', CP_KIND = 'auto:checkpoints', LABEL = 'Sauvegarde de la configuration';
  const TEXT = new Map();    // id -> { id, t, text } ou null (version expirée) : une version ne change jamais
  const LOADING = new Set(), FAILED = new Map();
  let dlg = null, sel = [], picked = false, unfolded = new Set(), memo = { key: '', ops: null }, watch = null;
  let cp = { state: 'idle' }; // points de restauration : idle | wait | done | fail

  const versions = () => arr(X.cfg).filter((v) => v && typeof v.id === 'string');
  const when = (t) => (t ? new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
  const agentOff = () => !S?.received || (NOW || Date.now() / 1000) - S.received > 180;
  // Sauvegarde en cours : une entrée perdue par l'agent (PC éteint, agent redémarré) ne bloque plus après 15 min,
  // comme côté serveur (aruba:cfg:pending).
  const running = () => LOG.find((c) => (c.kind === KIND || c.kind === 'backup') && ['pending', 'running'].includes(c.status)
    && (NOW || Date.now() / 1000) - (Number(c.created) || 0) < 900);
  const errLine = (out) => String(out || '').split('\n').find((l) => BK_ERR.test(l))?.trim() || '';
  const counts = (v) => (v.added == null ? '<span class="muted">-</span>'
    : `<span class="bk-plus">+${nf0.format(v.added)}</span> <span class="bk-minus">-${nf0.format(v.removed)}</span>`);

  async function fetchVersion(id) {
    if (TEXT.has(id)) return TEXT.get(id);
    const v = await api(`/api/output?part=cfg&id=${encodeURIComponent(id)}`);
    const ok = v && typeof v.text === 'string' ? { id: String(v.id || id), t: Number(v.t) || 0, text: v.text } : null;
    TEXT.set(id, ok);
    return ok;
  }
  function load(ids) {
    for (const id of ids) {
      if (LOADING.has(id) || TEXT.has(id) || FAILED.has(id)) continue;
      LOADING.add(id);
      fetchVersion(id).catch((e) => FAILED.set(id, e.message === '401' ? 'Session expirée.' : e.message))
        .finally(() => { LOADING.delete(id); if (dlg?.open) drawView(); });
    }
  }

  // ---------------------------------------------------------------- fonctions partagées
  // Dernière configuration sauvegardée (secrets masqués) : { t, text, id }, ou null s'il n'y en a pas (ou plus),
  // en lecture seule ou si la session a expiré. Rejette sur une vraie erreur (réseau, serveur).
  ADMIN.latestConfig = async () => {
    if (ROLE !== 'admin') return null;
    try {
      const top = versions()[0];
      if (top) { const v = await fetchVersion(top.id); return v ? { t: v.t, text: v.text, id: v.id } : null; }
      const v = await api('/api/output?part=cfg'); // X.cfg pas encore reçu : le serveur donne la dernière
      if (!v || typeof v.text !== 'string') return null;
      const rec = { id: String(v.id), t: Number(v.t) || 0, text: v.text };
      TEXT.set(rec.id, rec);
      return { t: rec.t, text: rec.text, id: rec.id };
    } catch (e) {
      if (e.message === '401' || e.status === 403) return null;
      throw e;
    }
  };
  // Met en file une sauvegarde immédiate (une seule à la fois) et affiche son suivi (toast « bk-req » : nouvelle
  // version, configuration inchangée ou erreur). Renvoie l'entrée du journal ; rejette si l'envoi échoue.
  ADMIN.requestBackup = async () => {
    if (!canAdmin()) throw Object.assign(new Error('Action réservée à l’administrateur.'), { status: 403 });
    const rec = await api('/api/command', { cmd: 'show running-config', label: LABEL, kind: KIND });
    watch = { id: rec.id, since: Date.now(), seen: false };
    toast(rec.dedup ? 'Sauvegarde déjà en cours' : 'Sauvegarde demandée', { id: 'bk-req', spinner: true, timeout: 0,
      sub: agentOff() ? 'L’agent ne répond pas pour l’instant : elle partira à son retour.' : 'Le switch envoie sa configuration, la liste se met à jour dans quelques secondes.' });
    setTimeout(poll, 600);
    if (dlg?.open) drawTop();
    return rec;
  };

  // Suivi de la sauvegarde demandée : nouvelle version, configuration identique ou erreur.
  function checkWatch() {
    if (!watch) return;
    const c = LOG.find((x) => x.id === watch.id);
    if (!c || !['done', 'error'].includes(c.status)) {
      if (Date.now() - watch.since > 300000) { dropToast('bk-req'); watch = null; }
      return;
    }
    const v = versions().find((x) => x.id === watch.id), out = OUT[c.id];
    if (v) {
      const prev = versions()[versions().indexOf(v) + 1];
      if (dlg?.open) { sel = prev ? [prev.id, v.id] : [v.id]; picked = true; unfolded = new Set(); draw(); } // montre le changement
      toast('Nouvelle version enregistrée', { id: 'bk-req', type: 'success', sub: v.added == null ? `${nf0.format(v.lines)} lignes de configuration.` : `+${v.added} / -${v.removed} lignes par rapport à la précédente.` });
    } else if (out === undefined && Date.now() - watch.since < 300000) return; // sortie pas encore chargée
    else if (c.status === 'error' || errLine(out)) {
      toast('Sauvegarde impossible', { id: 'bk-req', type: 'error', timeout: 9000, sub: errLine(out) || 'Le switch a renvoyé une erreur. Détail dans la console.' });
    } else if (!watch.seen) { watch.seen = true; return; } // l'historique arrive au plus tard au relevé suivant
    else toast('Configuration inchangée', { id: 'bk-req', type: 'info', sub: 'Identique à la dernière sauvegarde : aucune nouvelle version.' });
    watch = null;
  }

  // ---------------------------------------------------------------- fenêtre
  const css = document.createElement('style');
  css.textContent = `
dialog.bk-dlg { width: min(980px, calc(100% - 32px)); max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); }
.bk-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.bk-head h3 { margin: 0; flex: 1; }
.bk-acts { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 12px; }
.bk-status { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: 13px; color: var(--text-2); }
.bk-list { max-height: 232px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.bk-list th, .bk-list td, .bk-cp th, .bk-cp td { padding: 6px 8px; }
.bk-list th { position: sticky; top: 0; background: var(--surface); z-index: 1; }
.bk-list td.bk-reason { white-space: normal; min-width: 150px; }
.bk-list input { margin: 0; vertical-align: middle; }
.bk-plus { color: var(--good); font-weight: 500; } .bk-minus { color: var(--bad); font-weight: 500; }
.bk-view { margin-top: 12px; display: grid; gap: 8px; min-width: 0; }
.bk-vhead { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 13px; }
dialog .bk-pre, .bk-diff { font: 12px/1.5 var(--mono); background: var(--surface-2); border-radius: 8px; max-height: 52vh; overflow: auto; margin: 0; }
dialog .bk-pre { padding: 10px; white-space: pre; }
.bk-in { display: inline-block; min-width: 100%; padding: 6px 0; }
.bk-l { display: grid; grid-template-columns: 3.4em 3.4em 1.6em auto; white-space: pre; padding-right: 10px; }
.bk-l .bk-n { color: var(--text-3); text-align: right; padding-right: 6px; user-select: none; }
.bk-l .bk-s { text-align: center; user-select: none; }
.bk-l.add { background: var(--good-soft); } .bk-l.add .bk-s { color: var(--good); }
.bk-l.del { background: var(--bad-soft); } .bk-l.del .bk-s { color: var(--bad); }
.bk-fold { display: block; width: 100%; text-align: left; border: 0; border-block: 1px dashed var(--border); background: transparent; color: var(--info); font: inherit; padding: 2px 10px; cursor: pointer; }
.bk-fold:hover { background: var(--info-soft); }
.bk-scroll { overflow-x: auto; }
.bk-cp .alert { margin: 0; }
.bk-cp td { vertical-align: middle; }
@media (max-width: 560px) {
  .bk-sm-hide { display: none; } .bk-l { grid-template-columns: 2.6em 2.6em 1.2em auto; }
  .bk-acts .btn { flex: 1 1 auto; }
  .bk-list th, .bk-list td { padding: 6px 5px; }
  .bk-list td.bk-date { white-space: normal; min-width: 5.6em; }
  .bk-list td.bk-reason { min-width: 0; font-size: 12px; }
  .bk-cp thead { display: none; }
  .bk-cp tr, .bk-cp td { display: block; }
  .bk-cp tr { border-bottom: 1px solid var(--border); padding: 6px 0; }
  .bk-cp tr:last-child { border-bottom: 0; }
  .bk-cp td { border: 0; padding: 2px 0; white-space: normal; overflow-wrap: anywhere; }
  .bk-cp td.r { text-align: left; padding-top: 6px; }
}`;
  document.head.append(css);

  function open() {
    if (!canAdmin()) return;
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'bk-dlg';
      dlg.setAttribute('aria-labelledby', 'bkTitle');
      dlg.innerHTML = `<div class="bk-head"><h3 id="bkTitle">Sauvegardes de la configuration</h3>
        <button class="btn icon" type="button" data-bk="close" aria-label="Fermer" title="Fermer">×</button></div>
        <p class="note" style="margin:0">Copie automatique de la configuration du switch toutes les 6 h et quelques minutes après chaque changement fait depuis le dashboard. Une version n’est gardée que si quelque chose a changé (60 versions au plus). Les mots de passe, clés et communautés SNMP sont remplacés par « &lt;masqué&gt; » (sauf les communautés par défaut « public » et « private », gardées pour que le bilan de santé les signale) : un fichier téléchargé ne peut donc pas être recollé tel quel sur le switch.</p>
        <div id="bkTop"></div><div id="bkList"></div><div id="bkView" class="bk-view"></div>
        <div class="section bk-cp" id="bkCp"></div>`;
      document.body.append(dlg);
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('change', (e) => { const c = e.target.closest('[data-bk-sel]'); if (c) toggle(c.dataset.bkSel, c.checked); });
    }
    if (!sel.length) picked = false;
    draw();
    if (!dlg.open) dlg.showModal();
  }

  function toggle(id, on) {
    sel = on ? [...sel.filter((x) => x !== id), id].slice(-2) : sel.filter((x) => x !== id);
    picked = true; unfolded = new Set();
    draw();
  }
  function onClick(e) {
    if (e.target.closest('[data-bk-sel]')) return; // la case à cocher est gérée par « change »
    const f = e.target.closest('[data-bk-fold]');
    if (f) { unfolded.add(Number(f.dataset.bkFold)); drawView(); return; }
    const rb = e.target.closest('[data-bk-rb]');
    if (rb) { rollback(rb.dataset.bkRb); return; }
    const b = e.target.closest('[data-bk]');
    if (b) { act(b.dataset.bk, b); return; }
    const row = e.target.closest('[data-bk-row]');
    if (row) { sel = [row.dataset.bkRow]; picked = true; unfolded = new Set(); draw(); }
  }
  function act(what, btn) {
    const vs = versions();
    if (what === 'close') dlg.close();
    if (what === 'now') {
      busy(btn, () => ADMIN.requestBackup().catch((e) => { if (e.message !== '401') toast('Sauvegarde impossible', { type: 'error', sub: e.message }); }));
    }
    if (what === 'retry') { FAILED.clear(); drawView(); }
    if (what === 'cp') readCheckpoints();
    if (what === 'prev') {
      const base = sel.length ? Math.min(...sel.map((id) => vs.findIndex((v) => v.id === id)).filter((i) => i >= 0)) : 0;
      if (!Number.isFinite(base) || !vs[base + 1]) { toast('Pas de version précédente', { sub: 'Il faut au moins deux versions pour comparer.' }); return; }
      sel = [vs[base + 1].id, vs[base].id]; picked = true; unfolded = new Set(); draw();
    }
    if (what === 'dl') {
      const pick = sel.map((id) => vs.find((v) => v.id === id)).filter(Boolean).sort((x, y) => y.t - x.t)[0] || vs[0];
      if (!pick) { toast('Aucune sauvegarde à télécharger', { type: 'warn' }); return; }
      busy(btn, async () => {
        try {
          const v = await fetchVersion(pick.id);
          if (!v) { toast('Version indisponible', { type: 'warn', sub: 'Elle a expiré (plus de 400 jours).' }); return; }
          const url = URL.createObjectURL(new Blob([v.text.endsWith('\n') ? v.text : `${v.text}\n`], { type: 'text/plain;charset=utf-8' }));
          const a = document.createElement('a');
          a.href = url; a.download = bkFileName(S?.hostname, v.t);
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        } catch (e) { if (e.message !== '401') toast('Téléchargement impossible', { type: 'error', sub: e.message }); }
      });
    }
  }

  function draw() {
    if (!dlg) return;
    const vs = versions(), ids = new Set(vs.map((v) => v.id));
    sel = sel.filter((id) => ids.has(id));
    if (!sel.length && !picked && vs[0]) sel = [vs[0].id]; // par défaut : la dernière version
    drawTop(); drawList(); drawView(); drawCp();
  }
  function drawTop() {
    const vs = versions(), top = vs[0], run = running();
    const last = LOG.find((c) => c.kind === KIND || c.kind === 'backup');
    const failed = last && last.status === 'error' && (!top || (last.finished || last.created) > top.t);
    const status = [
      top ? `Dernière version : <b>${esc(when(top.t))}</b> <span class="muted">(${esc(ago((NOW || Date.now() / 1000) - top.t))})</span>` : '',
      top && top.last > top.t + 60 ? `<span>Vérifiée sans changement ${esc(ago((NOW || Date.now() / 1000) - top.last))}</span>` : '',
      vs.length ? `<span class="muted">${vs.length} version${vs.length > 1 ? 's' : ''} gardée${vs.length > 1 ? 's' : ''}</span>` : '',
      run ? '<span><span class="spinner"></span> Sauvegarde en cours…</span>' : '',
    ].filter(Boolean).join('');
    setHTML(dlg.querySelector('#bkTop'), `
      ${agentOff() ? '<div class="alert amber" style="margin:10px 0 0">L’agent ne répond pas : les sauvegardes reprendront à son retour.</div>' : ''}
      ${failed ? `<div class="alert red" style="margin:10px 0 0">La dernière sauvegarde a échoué${errLine(OUT[last.id]) ? ` : ${esc(errLine(OUT[last.id]))}` : '.'}</div>` : ''}
      <div class="bk-acts">
        <button class="btn primary" type="button" data-bk="now"${run ? ' disabled' : ''}>Sauvegarder maintenant</button>
        <button class="btn" type="button" data-bk="dl"${top ? '' : ' disabled'}>Télécharger</button>
        <button class="btn" type="button" data-bk="prev"${vs.length > 1 ? '' : ' disabled'}>Comparer avec la précédente</button>
      </div>
      ${status ? `<div class="bk-status">${status}</div>` : ''}`);
  }
  function drawList() {
    const vs = versions();
    setHTML(dlg.querySelector('#bkList'), !vs.length
      ? `<div class="alert" style="background:var(--surface-2);margin:10px 0 0">Aucune sauvegarde pour l’instant. La première est faite automatiquement dans les minutes qui suivent quand l’agent est en ligne, ou clique sur « Sauvegarder maintenant ».</div>`
      : `<p class="note" style="margin:10px 0 6px">Clique sur une version pour l’afficher, ou coche deux versions pour voir leurs différences.</p>
      <div class="bk-list"><table>
        <thead><tr><th><span class="bk-sm-hide">Comparer</span></th><th>Date</th><th>Raison</th><th class="r bk-sm-hide">Lignes</th><th class="r">Écart</th></tr></thead>
        <tbody>${vs.map((v, i) => `<tr class="click${sel.includes(v.id) ? ' sel' : ''}" data-bk-row="${esc(v.id)}">
          <td><input type="checkbox" data-bk-sel="${esc(v.id)}"${sel.includes(v.id) ? ' checked' : ''} aria-label="Comparer la version du ${esc(when(v.t))}"></td>
          <td class="num bk-date">${esc(when(v.t))}${i === 0 ? ' <span class="badge">actuelle</span>' : ''}${v.cut ? ' <span class="badge amber" title="Sortie tronquée : la fin de la configuration manque">incomplète</span>' : ''}</td>
          <td class="bk-reason">${esc(v.reason || '-')}</td>
          <td class="r num bk-sm-hide">${v.lines != null ? nf0.format(v.lines) : '-'}</td>
          <td class="r num">${counts(v)}</td></tr>`).join('')}</tbody>
      </table></div>`);
  }
  function drawView() {
    const box = dlg.querySelector('#bkView'), vs = versions();
    const chosen = sel.map((id) => vs.find((v) => v.id === id)).filter(Boolean).sort((x, y) => x.t - y.t);
    if (!chosen.length) { setHTML(box, vs.length ? '<p class="note" style="margin:0">Aucune version choisie.</p>' : ''); return; }
    const bad = chosen.find((v) => FAILED.has(v.id));
    if (bad) {
      setHTML(box, `<div class="alert red" style="margin:0">Impossible de lire la version du ${esc(when(bad.t))} : ${esc(FAILED.get(bad.id))} <button class="btn small" type="button" data-bk="retry">Réessayer</button></div>`);
      return;
    }
    const need = chosen.filter((v) => !TEXT.has(v.id));
    if (need.length) { load(need.map((v) => v.id)); setHTML(box, '<p class="note" style="margin:0"><span class="spinner"></span> Chargement de la configuration…</p>'); return; }
    const gone = chosen.find((v) => !TEXT.get(v.id));
    if (gone) { setHTML(box, `<div class="alert amber" style="margin:0">La version du ${esc(when(gone.t))} n’est plus disponible (gardée 400 jours).</div>`); return; }
    if (chosen.length === 1) {
      const v = chosen[0], text = TEXT.get(v.id).text;
      setHTML(box, `<div class="bk-vhead"><b>Version du ${esc(when(v.t))}</b><span class="muted">${nf0.format(text.split('\n').length)} lignes</span><span class="muted">${esc(v.reason || '')}</span></div>
        <pre class="bk-pre">${esc(text)}</pre>`);
      return;
    }
    const [older, newer] = chosen, key = `${older.id}|${newer.id}`;
    if (memo.key !== key) memo = { key, ops: diffLines(TEXT.get(older.id).text.split('\n'), TEXT.get(newer.id).text.split('\n')) };
    const ops = memo.ops, st = diffStats(ops), A = TEXT.get(older.id).text.split('\n'), B = TEXT.get(newer.id).text.split('\n');
    const head = `<div class="bk-vhead"><b>Du ${esc(when(older.t))} au ${esc(when(newer.t))}</b>
      <span class="bk-plus">+${nf0.format(st.added)} ajoutée${st.added > 1 ? 's' : ''}</span><span class="bk-minus">-${nf0.format(st.removed)} retirée${st.removed > 1 ? 's' : ''}</span></div>`;
    if (!st.added && !st.removed) { setHTML(box, `${head}<div class="alert green" style="margin:0">Aucune différence entre ces deux versions.</div>`); return; }
    const rows = foldOps(ops, 3, unfolded).map((o) => {
      if (o.t === 'fold') return `<button class="bk-fold" type="button" data-bk-fold="${o.from}">… ${nf0.format(o.n)} ligne${o.n > 1 ? 's' : ''} identique${o.n > 1 ? 's' : ''} (afficher)</button>`;
      const cls = o.t === '+' ? ' add' : o.t === '-' ? ' del' : '', s = o.t === '=' ? ' ' : o.t;
      return `<div class="bk-l${cls}"><span class="bk-n">${o.a != null ? o.a + 1 : ''}</span><span class="bk-n">${o.b != null ? o.b + 1 : ''}</span><span class="bk-s">${s}</span><span>${esc(o.t === '+' ? B[o.b] : A[o.a])}</span></div>`;
    }).join('');
    setHTML(box, `${head}<div class="bk-diff" role="region" aria-label="Différences entre les deux versions"><div class="bk-in">${rows}</div></div>
      <p class="note" style="margin:0">En vert : lignes ajoutées dans la version du ${esc(when(newer.t))}. En rouge : lignes retirées. Numéros : ancienne version, puis nouvelle.</p>`);
  }

  // ---------------------------------------------------------------- points de restauration du switch
  function waitOutput(id, ms) {
    return new Promise((resolve, reject) => {
      const end = Date.now() + ms;
      const tick = () => {
        const c = LOG.find((x) => x.id === id);
        if (c && ['done', 'error'].includes(c.status) && OUT[id] !== undefined) return resolve({ status: c.status, out: OUT[id] });
        if (Date.now() > end) return reject(new Error('Pas de réponse du switch dans le délai. Réessaie dans un instant.'));
        setTimeout(tick, 500);
      };
      tick();
    });
  }
  async function readCheckpoints() {
    if (!canAdmin() || cp.state === 'wait') return;
    if (agentOff()) { cp = { state: 'fail', error: 'L’agent ne répond pas : impossible de lire le switch pour l’instant.' }; drawCp(); return; }
    cp = { ...cp, state: 'wait' };
    drawCp();
    try {
      const rec = await api('/api/command', { cmd: 'show checkpoint', label: 'Lecture des points de restauration', kind: CP_KIND });
      setTimeout(poll, 600);
      const res = await waitOutput(rec.id, 60000);
      const sec = sections(res.out)['show checkpoint'];
      const raw = (sec ? sec.join('\n') : String(res.out || '')).trim();
      const parsed = parseCheckpoints(raw);
      cp = { state: 'done', t: Date.now() / 1000, raw, rows: parsed.rows,
        error: parsed.error || (res.status === 'error' ? 'Le switch a renvoyé une erreur.' : null) };
    } catch (e) {
      cp = { state: 'fail', error: e.message === '401' ? 'Session expirée : reconnecte-toi.' : e.message };
    }
    if (dlg?.open) drawCp();
  }
  function rollback(raw) {
    const name = cpName(raw);
    if (!name || !canAdmin()) return;
    confirmCmd(`Revenir au point ${name} ?`,
      'Toute la configuration actuelle du switch sera remplacée par celle de ce point : les changements faits depuis (ports, VLAN, descriptions…) seront perdus. Certains ports peuvent être coupés quelques secondes. Pense à « Sauvegarder maintenant » avant.',
      `checkpoint rollback ${name}`, `Retour au point ${name}`, { kind: 'undo' });
  }
  function drawCp() {
    const box = dlg?.querySelector('#bkCp'); if (!box) return;
    const btn = `<button class="btn small" type="button" data-bk="cp"${cp.state === 'wait' ? ' disabled' : ''}>${cp.state === 'idle' ? 'Lire les points de restauration' : 'Relire'}</button>`;
    let body = '';
    if (cp.state === 'wait') body = '<p class="note" style="margin:0"><span class="spinner"></span> Lecture sur le switch…</p>';
    if (cp.state === 'fail') body = `<div class="alert red">${esc(cp.error)}</div>`;
    if (cp.state === 'done') {
      if (cp.error) body += `<div class="alert red">Le switch n’a pas accepté « show checkpoint » : ${esc(cp.error)}. Cette version d’AOS-CX ne gère peut-être pas les points de restauration sous ce nom.</div>`;
      if (cp.rows.length) {
        body += `<div class="bk-scroll"><table><thead><tr><th>Nom</th><th>Type</th><th>Date</th><th></th></tr></thead><tbody>
          ${cp.rows.map((r) => `<tr><td class="mono">${esc(r.name)}</td><td>${esc(r.type || '-')}</td><td class="num">${esc(r.t ? when(r.t) : r.date || '-')}</td>
            <td class="r"><button class="btn small danger" type="button" data-bk-rb="${esc(r.name)}">Revenir à ce point</button></td></tr>`).join('')}
        </tbody></table></div>
        <details><summary class="note">Sortie brute du switch</summary><pre class="bk-pre">${esc(cp.raw)}</pre></details>`;
      } else if (!cp.error) {
        body += cp.raw ? `<p class="note" style="margin:0">Présentation en tableau impossible : voici la réponse du switch.</p><pre class="bk-pre">${esc(cp.raw)}</pre>`
          : '<p class="note" style="margin:0">Le switch n’a aucun point de restauration.</p>';
      }
    }
    setHTML(box, `<h3>Points de restauration du switch</h3>
      <p class="note" style="margin:0">Copies complètes de la configuration gardées par le switch lui-même (créées par AOS-CX ou avant un changement). Revenir à un point remplace toute la configuration actuelle : une seconde confirmation est demandée.</p>
      <div class="row">${btn}${cp.state === 'done' ? `<span class="note">lu à ${esc(new Date(cp.t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))}</span>` : ''}</div>${body}`);
  }

  // ---------------------------------------------------------------- branchements
  addTool({ id: 'backup', label: 'Sauvegardes de la configuration', icon: '🗂', title: 'Sauvegardes de la configuration : historique, différences, téléchargement, points de restauration', open });
  HOOK.poll.push(() => { checkWatch(); if (dlg?.open) draw(); });
  HOOK.role.push((ro) => { if (ro && dlg?.open) dlg.close(); });
})();
