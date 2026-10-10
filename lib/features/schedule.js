// Actions planifiées : couper, rallumer ou redémarrer des ports, allumer les PC (Wake-on-LAN) à heure fixe.
// Exécutées par le passage toutes les 5 min (QStash), même si personne n'a le dashboard ouvert.
// Coût Redis : rien par envoi de l'agent ni par lecture de l'état. Au passage de 5 min : rien s'il n'y a aucune
// planification active, sinon 1 SET (heure du passage, lue et écrite d'un coup) ; une action due coûte en plus sa
// mise en file (3 par commande), 1 SET par passage pour demander une sauvegarde de la configuration (ports changés)
// et l'écriture du suivi (MGET + EVAL). Enregistrement : MGET + EVAL ; seconde confirmation : + SET (jeton) ou GETDEL.
import crypto from 'node:crypto';
import { K, upsert, LOG_MAX, getSettings } from '../redis.js';
import { analyze } from '../danger.js';
import { notify } from '../notify.js';
import { httpError } from './index.js';

export const name = 'schedule';

const KEY = 'aruba:schedules';
const LAST = 'aruba:sched:last';  // heure (s) du dernier passage : une action n'est jamais exécutée deux fois
const LASTMAC = 'aruba:lastmac';  // dernier appareil vu sur chaque port (annuaire), lu seulement pour un Wake-on-LAN
const CFG_WANT = 'aruba:cfg:want'; // dernier changement de configuration (s) : sauvegarde rapide (lib/features/backup.js)
const MAX = 30;
const LATE = 1800;    // une action en retard de plus de 30 min n'est plus exécutée
const OFFLINE = 180;  // agent sans nouvelles depuis 3 min (au moins, voir offlineAfter) : action non exécutée
const STALE = 900;    // commande sans résultat 15 min après sa mise en file : retirée de la file
const PER_CMD = 7;    // ports coupés par commande : chaque commande reste sous le seuil de danger.js (8 ports), la
                      // planification entière ayant reçu la seconde confirmation (CONFIRMER) à l'enregistrement
const CONFIRM_TTL = 120; // validité du jeton de seconde confirmation (s), comme api/command.js
const MAC_PER_PORT = 4;
const DEFAULT_TZ = 'Europe/Paris';

export const LABELS = { shutdown: 'Couper les ports', noshutdown: 'Rallumer les ports', bounce: 'Redémarrer les ports', wol: 'Allumer les PC (Wake-on-LAN)' };
const NOUN = { shutdown: 'coupure', noshutdown: 'remise en service', bounce: 'redémarrage' };
const LINES = { shutdown: ['shutdown'], noshutdown: ['no shutdown'], bounce: ['shutdown', 'no shutdown'] };
const KEEP = ['last', 'lastResult', 'lastStatus', 'run', 'pending']; // suivi d'exécution, conservé à l'enregistrement

const PORT = /^1\/1\/([1-9]|1\d|2[0-8])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z0-9-]{1,20}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const QUEUED = /^(Mis en file|Sans réponse de l’agent après 15 min) : /;

export const stateExtras = [{ name: 'schedules', key: KEY, viewer: false }];
export const cronKeys = [KEY]; // LAST est lu par le SET … GET du passage

// ---------------------------------------------------------------- textes et commandes
const portNum = (p) => Number(String(p).split('/').pop());
const plural = (n, one, many) => (n > 1 ? many : one);
const hex = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

// Texte libre : une ligne, sans caractère de contrôle ni « # » en tête, longueur limitée.
export function clean(s, max) {
  return String(s ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, max).trim();
}

// Ports résumés : « 1-12, 14 ».
export function fmtPorts(ports) {
  const nums = [...new Set(ports.map(portNum))].sort((a, b) => a - b), out = [];
  for (const n of nums) { const last = out.at(-1); if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]); }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}
const portsText = (ports) => `${plural(ports.length, 'port', 'ports')} ${fmtPorts(ports)}`;

function phrase(action, ports, macs = 0) {
  if (action === 'wol') return `Wake-on-LAN vers ${macs} ${plural(macs, 'appareil', 'appareils')} (${portsText(ports)})`;
  return ports.length > 1 ? `${NOUN[action]} de ${ports.length} ports (${fmtPorts(ports)})` : `${NOUN[action]} du port ${portNum(ports[0])}`;
}

// Un bloc « interface » par port, jamais de plage.
export function portCmd(action, ports) {
  return ['configure terminal', ...ports.flatMap((p) => [`interface ${p}`, ...LINES[action], 'exit']), 'end'].join('\n');
}
// Lignes exécutées par l'agent lui-même : 64 adresses au plus par ligne.
export function wolCmd(macs) {
  const lines = [];
  for (let i = 0; i < macs.length; i += 64) lines.push(`#wol ${macs.slice(i, i + 64).join(' ')}`);
  return lines.join('\n');
}

// Même règle que danger.js et la page : lien vers un autre switch.
const isUplink = (state, port) => (state?.ports || []).some((p) => p?.port === port && p.uplink)
  || (state?.lldp || []).some((l) => l?.port === port && l.name && /\d{4}|aruba|switch/i.test(l.name));

// Raisons de refuser une action sur un port (analyse port par port : ces ports sont toujours refusés). Le seuil
// « 8 ports d'un coup » de danger.js est traité à part (bulkReasons) : il demande une seconde confirmation.
export function portReasons(action, port, state) {
  if (action === 'wol') return isUplink(state, port) ? [`Le port ${portNum(port)} relie un autre switch : le Wake-on-LAN ne vise que les ports des PC.`] : [];
  return analyze(portCmd(action, [port]), state);
}

// Raisons de la planification entière (coupure ou redémarrage de 8 ports ou plus d'un coup, selon danger.js) :
// seconde confirmation (CONFIRMER) à l'enregistrement. Sans état : seulement ce qui ne dépend pas du switch.
export function bulkReasons(action, ports, state = null) {
  return action === 'shutdown' || action === 'bounce' ? analyze(portCmd(action, ports), state) : [];
}
// Ce qui a été confirmé : l'action et les ports. Changer l'heure, les jours, le nom ou suspendre ne redemande rien.
export const confirmSig = (s) => `${s.action} ${fmtPorts(s.ports)}`;
const isConfirmed = (s) => s.confirmed === confirmSig(s);

// Agent hors ligne : sans nouvelles depuis 3 min, ou depuis son rythme d'envoi le plus lent (réglages, 300 s au plus)
// plus 2 min de marge. Toujours bien en dessous de STALE.
export function offlineAfter(settings) {
  const a = settings?.agent || {};
  const slow = Math.max(0, ...['hot', 'warm', 'idle'].map((k) => Number(a[k])).filter(Number.isFinite));
  return Math.max(OFFLINE, Math.min(300, slow) + 120);
}

// Erreur du switch ou de l'agent dans la sortie d'une commande, expliquée ; '' si tout s'est bien passé.
const HINTS = [[/Invalid input/i, 'commande refusée (syntaxe non reconnue par cette version d’AOS-CX)'],
  [/Command incomplete/i, 'commande incomplète'], [/Session console non connectée/i, 'aucune session ouverte sur le switch']];
export function explainError(output, status) {
  let cmd = '';
  for (const raw of String(output ?? '').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('» ')) { cmd = l.slice(2); continue; }
    const agentLine = /^Erreur :|Session console non connectée/i.test(l);
    if (!agentLine && !/^%|^Error\b|Invalid input|Command incomplete/i.test(l)) continue;
    const byAgent = agentLine || cmd.startsWith('#'); // ligne « # » : faite par l'agent lui-même, pas par le switch
    const hint = HINTS.find(([re]) => re.test(l))?.[1];
    const where = cmd && !byAgent ? ` sur « ${cmd.slice(0, 40)} »` : '';
    return `${byAgent ? 'Échec de l’agent' : 'Erreur du switch'}${where} : ${hint ? `${hint} (${l.slice(0, 100)})` : l.slice(0, 160)}`;
  }
  return status === 'error' ? 'Échec signalé par l’agent (détail dans la console)' : '';
}

// Identifiant de commande « sch-<planification>-<exécution><n°><hasard> » (36 caractères comme un UUID) :
// le résultat est rattaché à sa planification sans rien lire dans Redis pour les autres commandes.
export function cmdId(sid, run, i) {
  const base = `sch-${sid}-${run}${i.toString(16)}`;
  return base + hex(36 - base.length);
}
export function parseCmdId(id) {
  const s = String(id ?? '');
  const m = s.length === 36 && s.match(/^sch-([a-z0-9-]{1,20})-([0-9a-f]{8})[0-9a-f]{3,}$/);
  return m ? { sid: m[1], run: m[2] } : null;
}

// ---------------------------------------------------------------- fuseau horaire (Intl, sans bibliothèque)
const FMT = new Map();
export function zoneOk(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { zonedParts(0, tz); return true; } catch { return false; }
}
function fmt(tz) {
  let f = FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    FMT.set(tz, f);
  }
  return f;
}
// Date et heure locales d'un instant (ms) dans un fuseau.
export function zonedParts(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}
// Décalage (ms) du fuseau à un instant donné : heure locale moins heure UTC.
function offsetAt(ms, tz) {
  const t = Math.floor(ms / 1000) * 1000, p = zonedParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
}
// Date et heure locales d'un fuseau -> instant (s). Heure qui n'existe pas (passage à l'heure d'été) : décalée
// d'autant (02:30 -> 03:30). Heure qui existe deux fois (passage à l'heure d'hiver) : la première.
export function zonedEpoch(y, m, d, h, mi, tz) {
  const local = Date.UTC(y, m - 1, d, h, mi);
  const before = offsetAt(local - 86400000, tz), after = offsetAt(local + 86400000, tz);
  const ok = [local - before, local - after].filter((t) => offsetAt(t, tz) === local - t);
  return (ok.length ? Math.min(...ok) : local - before) / 1000;
}
// Jour de la semaine d'une date (1 = lundi, 7 = dimanche) et date décalée de k jours.
function shiftDay(y, m, d, k) {
  const t = new Date(Date.UTC(y, m - 1, d + k));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: ((t.getUTCDay() + 6) % 7) + 1 };
}

// Instant prévu (s) si la planification est due à ce passage (hier ou aujourd'hui), sinon null.
export function dueAt(s, prevRun, now, tz) {
  const [hh, mm] = s.time.split(':').map(Number), today = zonedParts(now * 1000, tz);
  let due = null;
  for (const k of [-1, 0]) {
    const day = shiftDay(today.y, today.m, today.d, k);
    if (!s.days.includes(day.dow)) continue;
    const t = zonedEpoch(day.y, day.m, day.d, hh, mm, tz);
    if (t > prevRun && t <= now && now - t <= LATE && t > (Number(s.since) || 0) && t > (Number(s.last) || 0)) due = t;
  }
  return due;
}

// ---------------------------------------------------------------- validation et enregistrement
// Planification stockée exécutable (relue depuis Redis : on revérifie la forme).
function usable(s) {
  return Boolean(s && typeof s === 'object' && s.enabled === true && typeof s.id === 'string' && Object.hasOwn(LABELS, s.action)
    && typeof s.time === 'string' && TIME.test(s.time) && Array.isArray(s.days) && s.days.some((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    && Array.isArray(s.ports) && s.ports.length && s.ports.every((p) => typeof p === 'string' && PORT.test(p)));
}

export function validate(input, state) {
  if (!Array.isArray(input)) throw httpError(400, 'Liste des planifications manquante.');
  if (input.length > MAX) throw httpError(400, `${MAX} planifications au maximum.`);
  const ids = new Set();
  return input.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw httpError(400, `Planification n° ${i + 1} invalide.`);
    const name = typeof x.name === 'string' ? clean(x.name, 60) : '';
    if (!name) throw httpError(400, `Donne un nom à la planification n° ${i + 1}.`);
    const who = `« ${name} »`;
    const id = x.id === undefined || x.id === null || x.id === '' ? `s${hex(10)}` : x.id;
    if (typeof id !== 'string' || !ID.test(id)) throw httpError(400, `${who} : identifiant invalide (20 caractères au plus : a à z, 0 à 9, tiret).`);
    if (ids.has(id)) throw httpError(400, `${who} : identifiant en double.`);
    ids.add(id);
    if (x.enabled !== undefined && typeof x.enabled !== 'boolean') throw httpError(400, `${who} : état actif ou inactif invalide.`);
    if (typeof x.action !== 'string' || !Object.hasOwn(LABELS, x.action)) throw httpError(400, `${who} : action inconnue.`);
    if (typeof x.time !== 'string' || !TIME.test(x.time)) throw httpError(400, `${who} : heure invalide (format HH:MM).`);
    if (!Array.isArray(x.days) || !x.days.length) throw httpError(400, `${who} : choisis au moins un jour.`);
    if (x.days.length > 7 || x.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw httpError(400, `${who} : jours invalides (1 = lundi à 7 = dimanche).`);
    if (!Array.isArray(x.ports) || !x.ports.length) throw httpError(400, `${who} : choisis au moins un port.`);
    if (x.ports.length > 28 || x.ports.some((p) => typeof p !== 'string' || !PORT.test(p))) throw httpError(400, `${who} : ports invalides (1/1/1 à 1/1/28).`);
    if (new Set(x.ports).size !== x.ports.length) throw httpError(400, `${who} : un port est en double.`);
    const ports = [...x.ports].sort((a, b) => portNum(a) - portNum(b));
    const reasons = [...new Set(ports.flatMap((p) => portReasons(x.action, p, state)))];
    if (reasons.length) throw httpError(400, `${who} : ${reasons.join(' ')}`);
    return { id, name, enabled: x.enabled !== false, days: [...new Set(x.days)].sort((a, b) => a - b), time: x.time, action: x.action, ports };
  });
}

// Garde le suivi d'exécution des planifications existantes (même id). « since » : heure du dernier changement de
// l'horaire, des ports, de l'action ou de l'état actif ; une heure passée avant n'est jamais rattrapée.
// « confirmed » (seconde confirmation) n'est gardé que si l'action et les ports n'ont pas changé.
export function merge(list, prev, now) {
  const old = new Map((Array.isArray(prev) ? prev : []).filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
  const sig = (s) => JSON.stringify([s.enabled, s.days, s.time, s.action, s.ports]);
  return list.map((s) => {
    const o = old.get(s.id);
    const out = { ...s, since: o && sig(o) === sig(s) ? Number(o.since) || 0 : now };
    for (const k of KEEP) if (o?.[k] !== undefined && o[k] !== null) out[k] = o[k];
    if (o && o.confirmed === confirmSig(s)) out.confirmed = o.confirmed;
    return out;
  });
}

// Comparaison indépendante de l'ordre des champs.
const canon = (list) => JSON.stringify(list.map((s) => Object.keys(s || {}).sort().map((k) => [k, s[k]])));
const same = (a, b) => canon(a) === canon(b);

// Écriture sûre de la liste : MGET (liste + version) puis EVAL qui n'écrit que si la version n'a pas bougé entre-temps
// (sinon on recommence avec la liste à jour). Un résultat de commande ou un passage du cron n'écrase donc jamais une
// suspension faite au même moment depuis la page, et inversement. Même coût qu'un GET + writeJSON.
// fn(liste) -> nouvelle liste, ou null pour ne rien écrire.
const CAS = `if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[2] then return -1 end
redis.call('SET', KEYS[1], ARGV[1])
return redis.call('INCR', KEYS[2])`;
async function save(r, fn) {
  for (let i = 0; i < 5; i++) {
    const [raw, ver] = await r.mget(KEY, K.ver(KEY));
    const list = Array.isArray(raw) ? raw : [];
    const next = await fn(list);
    if (!next) return { list, wrote: false };
    if (Number(await r.eval(CAS, [KEY, K.ver(KEY)], [JSON.stringify(next), String(Number(ver) || 0)])) !== -1) return { list: next, wrote: true };
  }
  throw httpError(503, 'La liste des planifications change sans arrêt en ce moment : réessaie dans quelques secondes.');
}

// Seconde confirmation (même mécanisme qu'api/command.js) : jeton à usage unique valable 2 min, lié au contenu exact
// des planifications concernées. Sans jeton valide : erreur 409 avec les raisons et un nouveau jeton.
const digest = (need) => `sched:${crypto.createHash('sha256').update(JSON.stringify(need.map((s) => [s.name, s.enabled, s.days, s.time, s.action, s.ports]))).digest('hex')}`;
async function checkToken(r, body, hash, need, state) {
  const token = typeof body?.danger_token === 'string' && body.danger_token ? body.danger_token.slice(0, 64) : null;
  if (token && body?.confirm === 'CONFIRMER' && (await r.getdel(K.confirm(token))) === hash) return;
  const fresh = crypto.randomUUID();
  await r.set(K.confirm(fresh), hash, { ex: CONFIRM_TTL });
  const reasons = need.map((s) => `« ${s.name} » : ${phrase(s.action, s.ports)} à ${s.time}. ${bulkReasons(s.action, s.ports, state).join(' ')}`);
  throw Object.assign(httpError(409, 'Planification sensible : seconde confirmation requise (tape CONFIRMER).'), { data: { danger: true, reasons, token: fresh } });
}

// Retire de la file les commandes planifiées que l'agent n'a pas encore prises (pred(ref) vrai) et les note
// « Annulée » au journal. Renvoie celles vraiment retirées : LREM à 0, l'agent l'a prise entre-temps et elle s'exécute.
async function takeBack(r, pred, now, why) {
  const out = [];
  for (const x of [].concat((await r.lrange(K.queue, 0, -1)) || [])) {
    let raw = x, item = x;
    if (typeof x === 'string') { try { item = JSON.parse(x); } catch { continue; } } else raw = JSON.stringify({ id: x?.id, cmd: x?.cmd });
    const ref = parseCmdId(item?.id);
    if (!ref || !pred(ref)) continue;
    if (!(Number(await r.lrem(K.queue, 0, raw)) > 0)) continue;
    await r.set(K.out(item.id), `Annulée : ${why}`, { ex: 3 * 86400 });
    await upsert(K.log, { id: item.id, status: 'error', finished: now, v: Date.now() }, LOG_MAX);
    out.push(ref);
  }
  return out;
}

// Coût : MGET + EVAL (rien n'est écrit si la liste n'a pas changé), en plus des 2 lectures d'api/settings.js.
// Seconde confirmation demandée : + 1 SET (jeton) ; confirmée : + 1 GETDEL. Planification supprimée alors que ses
// commandes attendent l'agent : + LRANGE, puis LREM + SET + EVAL par commande retirée.
export const actions = {
  'schedules-save': async ({ r, body, state }) => {
    const list = validate(body?.schedules, state);
    const now = Date.now() / 1000;
    let okHash = null, gone = [];
    const res = await save(r, async (prev) => {
      const next = merge(list, prev, now);
      // Coupure ou redémarrage de 8 ports ou plus, nouveau ou dont l'action ou les ports ont changé.
      const need = next.filter((s) => !isConfirmed(s) && bulkReasons(s.action, s.ports, state).length);
      if (need.length) {
        const hash = digest(need);
        if (okHash !== hash) { await checkToken(r, body, hash, need, state); okHash = hash; }
        for (const s of need) s.confirmed = confirmSig(s);
      }
      const ids = new Set(next.map((s) => s.id));
      gone = prev.filter((s) => s && typeof s.id === 'string' && !ids.has(s.id) && s.lastStatus === 'queued' && s.run);
      return same(next, prev) ? null : next;
    });
    // Planification supprimée : ses commandes encore en file ne partiront pas au retour de l'agent.
    if (res.wrote && gone.length) {
      await takeBack(r, (ref) => gone.some((s) => s.id === ref.sid && s.run === ref.run), now, 'la planification a été supprimée avant que l’agent ne relève la commande.');
    }
    return { ok: true, schedules: res.list };
  },
};

// Suivi d'exécution (dernier passage, résultat…) : n'écrit que ces champs, sur la liste relue juste avant.
async function patch(r, updates) {
  if (!updates.size) return;
  await save(r, (list) => {
    let hit = false;
    for (const s of list) if (s && updates.has(s.id)) { Object.assign(s, updates.get(s.id)); hit = true; }
    return hit ? list : null;
  });
}

// ---------------------------------------------------------------- exécution (passage toutes les 5 min)
async function execute(s, { r, now, state, settings, events, enqueue }) {
  const who = `Action planifiée « ${s.name} »`;
  const skip = (why) => {
    events.push({ type: 'schedule', level: 'warning', text: `${who} non exécutée : ${why}` });
    return { last: now, lastStatus: 'skipped', lastResult: `Non exécutée : ${why}`, pending: 0 };
  };
  // Beaucoup de ports d'un coup sans seconde confirmation (enregistrée avant cette règle, ou écrite à la main) : jamais.
  if (bulkReasons(s.action, s.ports).length && !isConfirmed(s)) {
    return skip(`elle modifie ${s.ports.length} ports d’un coup sans avoir reçu la seconde confirmation. Ouvre-la et enregistre-la en tapant CONFIRMER.`);
  }
  const age = state?.received ? now - Number(state.received) : Infinity;
  if (!(age <= offlineAfter(settings))) return skip(`agent hors ligne${Number.isFinite(age) ? ` (aucune nouvelle depuis ${Math.max(1, Math.round(age / 60))} min)` : ''}.`);
  const notes = [], cmds = [];
  let what;
  if (s.action === 'wol') {
    if (!(Array.isArray(state.agent?.caps) && state.agent.caps.includes('wol'))) return skip('l’agent est trop ancien pour allumer les PC (Wake-on-LAN : agent 1.4.0 ou plus).');
    const ports = s.ports.filter((p) => !isUplink(state, p));
    if (!ports.length) return skip('ces ports relient d’autres switches, le Wake-on-LAN ne vise que les ports des PC.');
    if (ports.length < s.ports.length) notes.push(`${portsText(s.ports.filter((p) => !ports.includes(p)))} vers un autre switch ignoré`);
    const known = (await r.get(LASTMAC)) || {};
    const macs = [], none = [];
    for (const p of ports) {
      const found = [...new Set([known?.[p]?.mac, ...(state.macs || []).filter((m) => m?.port === p).map((m) => m.mac)]
        .map((m) => String(m ?? '').toLowerCase()).filter((m) => MAC.test(m) && !(parseInt(m.slice(0, 2), 16) & 1)))].slice(0, MAC_PER_PORT);
      if (!found.length) none.push(p);
      for (const m of found) if (!macs.includes(m)) macs.push(m);
    }
    if (!macs.length) return skip(`aucune adresse MAC connue sur ${plural(ports.length, 'le', 'les')} ${portsText(ports)} (un PC doit avoir été allumé une fois sur son port pour que le dashboard retienne son adresse).`);
    if (none.length) notes.push(`${portsText(none)} sans adresse connue`);
    cmds.push(wolCmd(macs));
    what = phrase('wol', ports.filter((p) => !none.includes(p)), macs.length);
  } else {
    let ports = s.ports;
    if (s.action === 'bounce') { // un port désactivé reste désactivé
      const off = ports.filter((p) => (state.ports || []).find((x) => x?.port === p)?.enabled === false);
      if (off.length) { ports = ports.filter((p) => !off.includes(p)); notes.push(`${portsText(off)} désactivé${plural(off.length, '', 's')}, laissé${plural(off.length, '', 's')} tel${plural(off.length, '', 's')} quel${plural(off.length, '', 's')}`); }
    }
    // L'état a pu changer depuis l'enregistrement (nouveau switch branché, PC de l'agent déplacé…) : on revérifie.
    const bad = new Map();
    for (const p of ports) { const why = analyze(portCmd(s.action, [p]), state); if (why.length) bad.set(p, why); }
    if (bad.size) {
      const reasons = [...new Set([...bad.values()].flat())].join(' ');
      ports = ports.filter((p) => !bad.has(p));
      if (!ports.length) return skip(reasons);
      events.push({ type: 'schedule', level: 'warning', text: `${who} : ${portsText([...bad.keys()])} laissé${plural(bad.size, '', 's')} de côté. ${reasons}` });
      notes.push(`${portsText([...bad.keys()])} ignoré${plural(bad.size, '', 's')} par sécurité`);
    }
    if (!ports.length) return skip('aucun port à traiter.');
    const per = s.action === 'noshutdown' ? 28 : PER_CMD; // rallumer n'est jamais sensible : une seule commande
    for (let i = 0; i < ports.length; i += per) {
      const cmd = portCmd(s.action, ports.slice(i, i + per));
      if (!analyze(cmd, state).length) cmds.push(cmd); // jamais de commande sensible sans confirmation humaine
    }
    if (!cmds.length) return skip('commande jugée sensible par le dashboard.');
    what = phrase(s.action, ports);
  }
  const run = hex(8);
  for (const [i, cmd] of cmds.entries()) {
    await enqueue({ id: cmdId(s.id, run, i), cmd, label: `Planifié : ${s.name}${cmds.length > 1 ? ` (${i + 1}/${cmds.length})` : ''}`, kind: 'sched', meta: { sched: s.id } });
  }
  return { last: now, run, pending: cmds.length, lastStatus: 'queued', lastResult: `Mis en file : ${what}${notes.length ? ` (${notes.join(', ')})` : ''}.` };
}

// Commande restée sans résultat 15 min : retirée de la file si l'agent ne l'a pas encore prise (sinon elle partirait
// au retour du PC, des heures plus tard). Seules les commandes vraiment retirées sont annoncées « Annulée ».
async function dropStuck(r, stuck, now, events) {
  const updates = new Map();
  const removed = await takeBack(r, (ref) => stuck.some((s) => s.id === ref.sid && s.run === ref.run), now,
    'l’agent n’a pas relevé cette commande planifiée dans les 15 min.');
  for (const s of stuck) {
    const who = `Action planifiée « ${s.name} »`;
    const n = removed.filter((ref) => ref.sid === s.id).length, total = Math.max(n, Number(s.pending) || 0);
    let why;
    if (!n) why = 'pas de résultat de l’agent 15 min après l’envoi : vérifie dans la console.';
    else if (n < total) why = `l’agent n’a pas relevé ${n} commande${plural(n, '', 's')} sur ${total} dans les 15 min (hors ligne ?) : ${plural(n, 'elle est retirée', 'elles sont retirées')} de la file, les autres ont pu être exécutées.`;
    else why = `l’agent n’a pas relevé ${plural(n, 'la commande', `les ${n} commandes`)} dans les 15 min (hors ligne ?), ${plural(n, 'elle est retirée', 'elles sont retirées')} de la file.`;
    events.push({ type: 'schedule', level: 'warning', text: `${who} : ${why}` });
    updates.set(s.id, n ? { lastStatus: 'skipped', pending: 0, lastResult: `${n < total ? 'Annulée en partie' : 'Annulée'} : ${why}` }
      : { lastStatus: 'late', lastResult: String(s.lastResult || '').replace(QUEUED, 'Sans réponse de l’agent après 15 min : ') });
  }
  return updates;
}

export async function onCron({ r, now, state, settings, vals, events, enqueue }) {
  const list = Array.isArray(vals?.[KEY]) ? vals[KEY] : [];
  const active = list.filter(usable);
  const stuck = list.filter((s) => s?.lastStatus === 'queued' && typeof s.id === 'string' && now - (Number(s.last) || 0) > STALE);
  if (!active.length && !stuck.length) return; // aucune planification active : aucune commande Redis
  const updates = stuck.length ? await dropStuck(r, stuck, now, events) : new Map();
  if (active.length) {
    // Heure du passage précédent lue et remplacée d'un coup (SET … GET) : deux passages simultanés (livraison QStash
    // en double) ne trouvent jamais la même action due.
    const prevRun = Number(await r.set(LAST, now, { get: true })) || 0;
    if (prevRun > 0) { // premier passage : on ne rattrape rien
      const tz = zoneOk(settings?.tz) ? settings.tz : DEFAULT_TZ;
      const due = active.map((s) => [s, dueAt(s, prevRun, now, tz)]).filter(([, t]) => t).sort((a, b) => a[1] - b[1]);
      let changed = false;
      for (const [s] of due) {
        const u = await execute(s, { r, now, state, settings, events, enqueue });
        if (u.lastStatus === 'queued' && s.action !== 'wol') changed = true;
        updates.set(s.id, { ...updates.get(s.id), ...u });
      }
      // Ports changés : sauvegarde rapide de la configuration au passage suivant (lib/features/backup.js), 1 commande.
      if (changed) await r.set(CFG_WANT, Math.floor(now));
    }
  }
  await patch(r, updates);
}

// Résultat d'une commande : seules les commandes planifiées (id « sch-… ») coûtent quelque chose (MGET + EVAL).
export async function onResult({ r, id, output, status }) {
  const ref = parseCmdId(id);
  if (!ref) return;
  const err = explainError(output, status);
  let alert = '';
  await save(r, (list) => {
    alert = '';
    const s = list.find((x) => x?.id === ref.sid);
    if (!s || s.run !== ref.run) return null; // planification supprimée ou exécution plus ancienne
    if (err) {
      if (s.lastStatus === 'error') return null; // première erreur de cette exécution déjà notée
      Object.assign(s, { lastStatus: 'error', pending: 0, lastResult: err });
      alert = `Action planifiée « ${s.name} » : ${err}`;
      return list;
    }
    if (!['queued', 'late'].includes(s.lastStatus)) return null;
    const pending = Math.max(0, (Number(s.pending) || 1) - 1);
    Object.assign(s, pending ? { pending } : { pending: 0, lastStatus: 'ok', lastResult: String(s.lastResult || '').replace(QUEUED, 'Fait : ') });
    return list;
  });
  if (alert) await notify([{ type: 'schedule', level: 'warning', text: alert }], await getSettings());
}
