// Annuler une modification : avant chaque changement de configuration envoyé depuis le dashboard, le switch garde un
// point de restauration (« copy running-config checkpoint dash-AAMMJJHHMMSS »). L'administrateur peut ensuite revenir
// à l'un d'eux (« checkpoint rollback »). Filet de sécurité : un changement sensible (confirmé avec CONFIRMER) est
// précédé de « checkpoint auto 5 » : sans « checkpoint auto confirm » dans les 5 min, le switch l'annule tout seul.
//   mam:undo          [{ name, t, id, label, status: 'pending'|'ok'|'failed'|'rolledback', cp?, undone?, error? }]
//                       (12, récent en tête ; cp : le point existe sur le switch ; undone : changement sans point annulé)
//   mam:autocp        { id, minutes, t, label, on?, at?, failed?, error? } annulation automatique en cours, ou null
//                       on : agent joignable à l'envoi ; at : début du compte à rebours au plus tard (voir timing)
//   mam:undo:noprune  1 : le switch a refusé tout l'élagage, on arrête d'élaguer (7 jours)
//   mam:undo:gc       [noms] points sortis de la liste (plus de 12), à effacer au prochain passage du cron
//   mam:undo:off      { cp?, auto?, error } le switch a refusé le point ou le filet : plus ajouté pendant 24 h
//                       (sinon chaque changement reviendrait « en erreur » alors qu'il est appliqué)
// La liste est modifiée par upsert (atomique, par id) : un résultat de l'agent peut arriver pendant un nouvel envoi.
// Seuls les points « dash-… » et les lignes ajoutées par le module (id d'une entrée ou du filet) comptent : une commande
// « checkpoint » tapée dans la console ne coupe ni les points, ni le filet, ni l'élagage, et n'est jamais effacée.
import { writeJSON, upsert, K } from '../db.js';
import { analyze } from '../danger.js';

export const name = 'undo';

const KEY = 'mam:undo', AUTO = 'mam:autocp', NOPRUNE = 'mam:undo:noprune', GC = 'mam:undo:gc', OFF = 'mam:undo:off';
const MAX = 12;               // entrées gardées dans la liste
const KEEP_OK = 10;           // points disponibles gardés sur le switch
const MAX_AGE = 7 * 86400;    // au-delà, le point est effacé
const DROP_AFTER = 86400;     // entrées sans point utilisable (échec, déjà annulée, jamais exécutée)
const AUTO_MIN = 5;           // délai de l'annulation automatique (min)
const AUTO_STALE = 3600;      // filet jamais démarré ou indisponible : oublié au bout d'1 h
const NOPRUNE_TTL = 7 * 86400;
const OFF_TTL = 86400;        // nouvel essai du point ou du filet refusé par le switch
const PRUNE_MAX = 20;         // lignes « erase checkpoint » par passage
const GC_MAX = 40;
const LABEL = 'Nettoyage des points de restauration';
// Le compte à rebours démarre quand l'agent exécute « checkpoint auto », mais le serveur ne l'apprend qu'au résultat,
// qui arrive après toutes les lignes, ou jamais si le changement coupe l'agent du dashboard.
const ONLINE = 150;           // agent joignable : état reçu il y a moins de 150 s (il l'envoie toutes les 120 s au plus)
const PICKUP = 180;           // agent joignable : commande relevée et compte à rebours lancé moins de 3 min après l'envoi
const FIN_GRACE = 5;          // résultat tout juste reçu : son analyse (onResult, quelques ms) peut être en cours

export const cronKeys = [KEY, NOPRUNE, GC, AUTO];
export const stateExtras = [{ name: 'undo', key: KEY, viewer: false }, { name: 'autocp', key: AUTO, viewer: false }];

const arr = (x) => (Array.isArray(x) ? x : []);
const nowS = () => Math.floor(Date.now() / 1000);
const minutesOf = (a) => Math.min(60, Math.max(1, Number(a?.minutes) || AUTO_MIN));
const ended = (c) => c?.status === 'done' || c?.status === 'error';

// ---------------------------------------------------------------- fonctions pures (testées à part)

export const NAME_RE = /^[A-Za-z0-9-]{1,32}$/;
// Points créés par le module (les seuls qu'il efface ou propose) : dash-AAMMJJHHMMSS, puis -2, -3… en cas de doublon.
export const DASH_RE = /^dash-\d{12}(-\d{1,3})?$/;
// Entrée en mode configuration : « configure terminal », « conf t », « configure »…
const CONF_RE = /^conf(ig(ure)?)?(\s+t(erm(inal)?)?)?$/i;
// Lignes qui interdisent le filet de sécurité : redémarrage, effacement, remplacement complet de la configuration,
// retour à un point ou annulation automatique déjà demandée par la commande elle-même.
const RISKY_RE = /^(reload|boot|erase|zeroize|write\s+erase|checkpoint\s+(rollback|auto))\b|^copy\b.*\s(startup|running)-config(\s+vrf\s+\S+)?\s*$/i;
// Ligne d'erreur du switch (même règle que l'agent).
const ERR_RE = /^\s*(%\s|Invalid|Error|ERROR)/;
// Sections de sortie qui concernent ce module (« checkpoint diff » et « show checkpoint » ne coûtent rien).
const HEAD_RE = /^» (copy running-config checkpoint|checkpoint (auto|rollback)|erase checkpoint)\b/m;

export const isConfigCmd = (lines) => lines.some((l) => CONF_RE.test(l));
export const isRisky = (lines) => lines.some((l) => RISKY_RE.test(l));
export const errLine = (lines) => (arr(lines).find((l) => ERR_RE.test(l)) || '').trim() || null;
export const validEntry = (e) => Boolean(e) && typeof e === 'object' && DASH_RE.test(String(e.name)) && Number.isFinite(Number(e.t));
// Liste utilisable par upsert (le script Lua échoue sur un élément qui n'est pas un objet) ; sinon on la réécrit.
const tidy = (raw) => raw.every((e) => e && typeof e === 'object' && !Array.isArray(e));

// Texte libre gardé dans nos données (jamais envoyé au switch) : une ligne, sans caractère de contrôle ni « # » initial.
export function clean(s, max = 80) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, max).trim();
}

// Horodatage UTC AAMMJJHHMMSS.
export function stamp(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// Nom unique : dash-AAMMJJHHMMSS, puis -2, -3… s'il existe déjà.
export function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// Libellé d'un changement sans titre : première ligne qui change vraiment quelque chose (avec son interface).
export function firstConfigLine(lines) {
  const skip = (l) => CONF_RE.test(l) || /^(exit|end)$/i.test(l) || /^copy running-config checkpoint\b/i.test(l);
  const i = lines.findIndex((l) => !skip(l));
  if (i < 0) return '';
  const l = lines[i], next = lines[i + 1];
  if (/^(interface|vlan)\s/i.test(l) && next && !skip(next) && !/^(interface|vlan)\s/i.test(next)) return clean(`${l} : ${next}`);
  return clean(l);
}

// Découpe une sortie de l'agent (« » ligne » puis la réponse) en sections.
export function sections(out) {
  const sec = {}; let cur = null;
  for (const l of String(out ?? '').split('\n')) {
    const m = l.match(/^» (.*)$/);
    if (m) { cur = m[1].trim(); sec[cur] = []; } else if (cur) sec[cur].push(l);
  }
  return sec;
}

// Ce que la sortie d'une commande dit des points de restauration.
export function parseOutput(out) {
  const res = { copy: null, auto: null, confirm: null, roll: null, erased: [] };
  for (const [line, body] of Object.entries(sections(out))) {
    let m;
    if ((m = line.match(/^copy running-config checkpoint (\S+)$/i))) res.copy = { name: m[1], err: errLine(body) };
    else if ((m = line.match(/^checkpoint auto (\d+)$/i))) res.auto = { minutes: Number(m[1]), err: errLine(body) };
    else if (/^checkpoint auto confirm$/i.test(line)) res.confirm = { err: errLine(body) };
    else if ((m = line.match(/^checkpoint rollback (\S+)$/i))) res.roll = { name: m[1], err: errLine(body) };
    else if ((m = line.match(/^erase checkpoint (\S+)$/i))) res.erased.push({ name: m[1], err: errLine(body) });
  }
  return res;
}

// Élagage du module (uniquement des lignes « erase checkpoint dash-… ») refusé en entier : syntaxe inconnue du switch.
// Un seul point absent parmi d'autres effacés n'arrête pas l'élagage.
export function pruneRefused(out) {
  const keys = Object.keys(sections(out)), er = parseOutput(out).erased;
  return er.length > 0 && er.length === keys.length && er.every((e) => DASH_RE.test(e.name) && e.err);
}

// Où en est l'agent avec la commande du filet, d'après le journal (mam:log). L'agent exécute les commandes une par
// une, dans l'ordre d'envoi : celle du filet démarre au plus tôt à la fin des précédentes (busy). Si l'agent était
// joignable à l'envoi (on), il l'a relevée et a lancé le compte à rebours au plus tard à hi.
export function timing(a, log) {
  const list = arr(log).filter((c) => c && typeof c === 'object');
  const t = Number(a?.t) || 0, me = list.find((c) => c.id === a?.id) || null, t0 = Number(me?.created) || t;
  let busy = 0, waiting = false;
  for (const c of list) {
    if (c.id === a?.id || !(Number(c.created) < t0)) continue;
    if (ended(c)) busy = Math.max(busy, Number(c.finished) || 0);
    else if (t0 - Number(c.created) < AUTO_STALE) waiting = true; // une commande d'avant n'est pas finie
  }
  return { me, busy, waiting, hi: Math.max(t + PICKUP, busy + 30) };
}

// Début du compte à rebours au plus tard, quand le résultat arrive (now) : un résultat retardé ou envoyé après le retour
// en arrière du switch ne repousse pas l'échéance.
export function latestStart(a, now, log) {
  return a?.on ? Math.min(now, timing(a, log).hi) : now;
}

// Filet de sécurité encore en cours (en attente d'exécution, ou compte à rebours pas terminé).
// log : journal des commandes ; received : dernier envoi de l'état par l'agent (s).
export function autoActive(a, now, { log, received } = {}) {
  if (!a || typeof a !== 'object' || a.failed) return false;
  const min = minutesOf(a);
  if (a.at) return now < Number(a.at) + min * 60 + 60;
  const { me, waiting, hi } = timing(a, log);
  // commande terminée sans compte à rebours : jamais exécutée (session non connectée, switch injoignable…)
  if (ended(me) && now - (Number(me.finished) || 0) > FIN_GRACE) return false;
  // pas de résultat alors que l'agent, joignable à l'envoi et sans commande d'avant en cours, donne des nouvelles après
  // la fin du délai : le changement l'a coupé du dashboard, le résultat s'est perdu, le switch a déjà tout annulé
  if (a.on && !waiting && Number(received) > hi + min * 60 + 60) return false;
  return now - (Number(a.t) || 0) < AUTO_STALE;
}

// Prépare la commande et l'entrée de la liste (sans rien écrire). list : liste telle qu'enregistrée ;
// off : ce que le switch a refusé récemment (point de restauration, filet) ; log, received : voir autoActive.
export function planWrap({ id, cmd, label, reasons, list, gc, auto, off, log, received, now }) {
  const lines = String(cmd ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!isConfigCmd(lines)) return null;
  const t = Math.floor(now / 1000);
  const name = clean(label) || firstConfigLine(lines) || 'Changement de configuration';
  const pre = [], meta = {};
  let entry = null, lost = [], next = list;
  if (!off?.cp) {
    const cp = uniqueName(`dash-${stamp(now)}`, new Set([...list.filter(validEntry).map((e) => e.name), ...gc]));
    entry = { name: cp, t, id, label: name, status: 'pending' };
    pre.push(`copy running-config checkpoint ${cp}`); meta.checkpoint = cp;
    next = [entry, ...list];
    // points sortis de la liste : ils existent sur le switch (disponibles ou déjà annulés), on les effacera plus tard
    lost = next.slice(MAX).filter((e) => validEntry(e) && (e.status === 'ok' || (e.status === 'rolledback' && e.cp))).map((e) => e.name);
  }
  const safety = !off?.auto && arr(reasons).length > 0 && !isRisky(lines) && !autoActive(auto, t, { log, received });
  if (safety) { pre.push(`checkpoint auto ${AUTO_MIN}`); meta.autoConfirm = AUTO_MIN; }
  if (!pre.length) return null;
  return {
    cmd: `${pre.join('\n')}\n${cmd}`, meta, entry, list: next.slice(0, MAX),
    gc: lost.length ? [...gc, ...lost].slice(-GC_MAX) : null,
    auto: safety ? { id, minutes: AUTO_MIN, t, label: name, ...(Number(received) > t - ONLINE ? { on: true } : {}) } : null,
  };
}

// Refus du switch à retenir (point de restauration ou filet) : null si rien de nouveau.
// ours : la ligne refusée a bien été ajoutée par le module ({ cp, auto }) et pas tapée dans la console.
export function offAfter(parsed, off, now, ours = {}) {
  const cpErr = ours.cp ? parsed.copy?.err : null, autoErr = ours.auto ? parsed.auto?.err : null;
  if (!cpErr && !autoErr) return null;
  const next = { ...(off && typeof off === 'object' ? off : {}) };
  if (cpErr) Object.assign(next, { cp: now, error: clean(cpErr, 160) });
  if (autoErr) Object.assign(next, { auto: now, error: clean(autoErr, 160) });
  return next;
}

// Entrée dont le changement vient d'être annulé par le switch : un point créé passe en « déjà annulée » (il reste à
// effacer) ; un changement sans point (copie refusée) est seulement marqué, il n'y a rien à effacer.
const undoneFields = (x) => (x.status === 'ok' ? { status: 'rolledback', cp: true } : x.status === 'failed' && !x.undone ? { undone: true } : null);

// Applique un résultat de commande à la liste et au filet de sécurité. Renvoie ce qui a changé
// (updates : champs modifiés de chaque entrée, par id, pour upsert).
export function applyResult({ id, parsed, list, auto, log, now }) {
  let a = auto && typeof auto === 'object' ? auto : null, autoChanged = false;
  const updates = new Map(), put = (e, f) => { Object.assign(e, f); updates.set(e.id, { ...(updates.get(e.id) || { id: e.id }), ...f }); };
  const { copy, roll } = parsed;
  if (copy) {
    const e = list.find((x) => x.id === id) || list.find((x) => x.name === copy.name);
    if (e && e.status === 'pending' && e.id) put(e, copy.err ? { status: 'failed', error: clean(copy.err, 160) } : { status: 'ok', cp: true });
  }
  if (roll && !roll.err) { // ce point et tous les plus récents sont annulés (les commandes encore en file passent après)
    const i = list.findIndex((x) => x.name === roll.name);
    for (const x of list.slice(0, i + 1)) { const f = x.id && undoneFields(x); if (f) put(x, f); }
  }
  if (parsed.auto) {
    if (parsed.auto.err) {
      if (a && a.id === id && !a.failed) { a = { ...a, failed: true, error: clean(parsed.auto.err, 160) }; autoChanged = true; }
    } else if (!a || (a.id === id && !a.at)) {
      // le compte à rebours du switch a démarré (recréé s'il avait été oublié : le switch annulera quand même)
      const e = list.find((x) => x.id === id), at = latestStart(a, now, log);
      a = { ...(a || { id, t: now, label: e?.label || 'Changement de configuration' }), minutes: minutesOf(parsed.auto), at };
      delete a.failed; delete a.error;
      autoChanged = true;
    }
  }
  return { list, listChanged: updates.size > 0, updates: [...updates.values()], auto: a, autoChanged };
}

// Passage du cron : filet expiré, points à effacer, entrées à oublier.
export function planCron({ list, auto, gc, noprune, now }) {
  list = arr(list).filter(validEntry).map((x) => ({ ...x })); // copie : la liste d'origine sert au second calcul
  gc = arr(gc).filter((n) => DASH_RE.test(String(n)));
  let changed = false, clearAuto = false;
  if (auto && typeof auto === 'object') {
    const end = Number(auto.at) + minutesOf(auto) * 60;
    if (!auto.failed && auto.at && now > end + 120) {
      // pas de confirmation : le switch a remis la configuration d'avant ce changement (et ceux faits pendant le délai)
      const i = list.findIndex((x) => x.id === auto.id);
      for (const x of list.slice(0, i + 1)) { const f = x.t <= end && undoneFields(x); if (f) { Object.assign(x, f); changed = true; } }
      clearAuto = true;
    } else if ((auto.failed || !auto.at) && now - (Number(auto.t) || 0) > AUTO_STALE) clearAuto = true;
  }
  const keep = [], erase = [];
  let ok = 0;
  for (const x of list) {
    const age = now - Number(x.t);
    if (x.status === 'ok') {
      ok++;
      if (!noprune && (ok > KEEP_OK || age > MAX_AGE)) { erase.push(x.name); continue; }
    } else if (x.status === 'rolledback' && x.cp) {
      if (!noprune && age > DROP_AFTER) { erase.push(x.name); continue; }
    } else if (age > DROP_AFTER) { changed = true; continue; } // aucun point sur le switch (échec, jamais exécutée…)
    keep.push(x);
  }
  const todo = [...new Set([...(noprune ? [] : gc), ...erase])];
  return { keep, changed: changed || erase.length > 0, clearAuto, batch: todo.slice(0, PRUNE_MAX), later: todo.slice(PRUNE_MAX) };
}

// Seuls les points du module sont effacés, jamais « startup-config » ni un point créé à la main.
export const eraseCmd = (names) => names.filter((n) => DASH_RE.test(n)).map((n) => `erase checkpoint ${n}`).join('\n');

// ---------------------------------------------------------------- points d'accroche

export async function wrapCommand({ r, id, cmd, kind, label, reasons, state }) {
  const text = String(cmd ?? '').trim();
  // « Tout fonctionne, garder » : plus d'annulation automatique en cours
  if (/^checkpoint\s+auto\s+confirm$/i.test(text)) { await writeJSON(AUTO, null); return; }
  if (String(kind ?? '').startsWith('undo') || !/^[\w-]{36}$/.test(String(id)) || !text) return;
  if (!isConfigCmd(text.split('\n').map((l) => l.trim()))) return; // lecture : rien à faire, aucune commande Redis
  const [list0, auto0, gc0, off, log] = await r.mget(KEY, AUTO, GC, OFF, K.log);
  const raw = arr(list0);
  const p = planWrap({ id: String(id), cmd: String(cmd), label, reasons, list: raw, gc: arr(gc0).filter((n) => DASH_RE.test(String(n))),
    auto: auto0, off, log, received: state?.received, now: Date.now() });
  if (!p) return;
  if (p.entry) {
    if (tidy(raw)) await upsert(KEY, p.entry, MAX); // insertion en tête, 12 entrées au plus
    else await writeJSON(KEY, [p.entry, ...raw.filter(validEntry)].slice(0, MAX));
  }
  if (p.gc) await r.set(GC, p.gc);
  if (p.auto) await writeJSON(AUTO, p.auto);
  return { cmd: p.cmd, meta: p.meta };
}

export async function onResult({ r, id, output }) {
  const out = String(output ?? '');
  if (!out.includes('checkpoint') || !HEAD_RE.test(out)) return; // cas habituel : aucune commande Redis
  const parsed = parseOutput(out);
  // élagage refusé en entier (syntaxe inconnue) : on arrête d'élaguer pendant 7 jours
  if (pruneRefused(out)) await r.set(NOPRUNE, 1, { ex: NOPRUNE_TTL });
  if (!parsed.copy && !parsed.auto && !(parsed.roll && !parsed.roll.err)) return;
  const [list0, auto0, off0, log] = await r.mget(KEY, AUTO, OFF, K.log);
  const raw = arr(list0), list = raw.filter(validEntry), now = nowS(), sid = String(id);
  // refus à retenir seulement pour les lignes ajoutées par le module à cette commande
  const ours = { cp: Boolean(parsed.copy && list.some((e) => e.id === sid && e.name === parsed.copy.name)),
    auto: Boolean(auto0 && typeof auto0 === 'object' && auto0.id === sid) };
  const res = applyResult({ id: sid, parsed, list, auto: auto0, log, now });
  if (res.updates.length) await (tidy(raw) ? upsert(KEY, res.updates, MAX) : writeJSON(KEY, res.list));
  if (res.autoChanged) await writeJSON(AUTO, res.auto);
  const off = offAfter(parsed, off0, now, ours);
  if (off) await r.set(OFF, off, { ex: OFF_TTL });
}

export async function onCron({ r, now, state, vals, enqueue }) {
  const t = Math.floor(Number(now) || nowS());
  const raw = arr(vals?.[KEY]), list = raw.filter(validEntry), gc = arr(vals?.[GC]).filter((n) => DASH_RE.test(String(n)));
  const auto = vals?.[AUTO], noprune = Boolean(vals?.[NOPRUNE]);
  if (!raw.length && !gc.length && !auto) return; // rien à faire : aucune commande Redis
  let p = planCron({ list, auto, gc, noprune, now: t });
  // une action automatique n'exécute jamais une commande jugée sensible : on attend (points gardés)
  if (p.batch.length && (typeof enqueue !== 'function' || analyze(eraseCmd(p.batch), state).length)) {
    p = planCron({ list, auto, gc, noprune: true, now: t });
  }
  if (p.clearAuto) await writeJSON(AUTO, null);
  // liste d'abord : si la mise en file échoue, un point reste sur le switch (jamais effacé deux fois)
  if (p.changed || p.keep.length !== raw.length) await writeJSON(KEY, p.keep); // entrées abîmées retirées aussi
  const cmd = eraseCmd(p.batch);
  if (p.batch.length) {
    if (p.later.length) await r.set(GC, p.later);
    else if (gc.length) await r.del(GC);
    if (cmd) await enqueue({ cmd, label: LABEL, kind: 'auto:undo-prune' });
  }
}
