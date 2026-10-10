// Annuaire des appareils, plan de brassage et dernier appareil vu sur chaque port.
// Registre (aruba:devices) : { mac: { first, last, port, ports: [[port, t]…], ip, host, on } } (on : branché à la dernière
// écriture). Résumé (aruba:devhash) : appareils branchés par port et liens vers d'autres switches, lu dans le MGET de
// chaque envoi de l'agent (0 commande en plus). Le registre n'est relu et réécrit que si un appareil arrive, change de
// port ou part pour de bon (lien du port coupé) : une adresse qui vieillit dans la table du switch alors que le lien reste
// établi (PC en veille, imprimante silencieuse) ne coûte rien, ni quand elle disparaît ni quand elle revient.
// Seuls les ports qui ne relient pas un autre switch comptent (sinon tout le réseau voisin entrerait dans l'annuaire).
// Toutes les écritures sont conditionnelles (script CAS) : deux requêtes simultanées ne s'écrasent jamais.
import { K } from '../redis.js';
import { httpError } from './index.js';

export const name = 'devices';

const KEY = { devices: 'aruba:devices', hash: 'aruba:devhash', lastmac: 'aruba:lastmac', names: 'aruba:names', plan: 'aruba:plan' };
const MAX_DEVICES = 500;  // adresses gardées dans le registre (les plus anciennes en dernier vu sont oubliées)
const MAX_NAMES = 500;
const HISTORY = 8;        // derniers changements de port gardés par appareil
const ALERT_MACS = 4;     // au-delà, le port mène sans doute à un petit switch ou à un point d'accès : pas d'alerte
const ALERT_MAX = 5;      // alertes « nouvel appareil » détaillées par envoi (au-delà : un résumé)
const MAX_PORT_MACS = 8;  // au-delà, le port est ignoré tant qu'il en a autant (switch pas encore reconnu, point d'accès chargé)
const UPLINK_GRACE = 900; // un lien vers un switch qui perd son voisin LLDP reste ignoré 15 min (l'agent relit le LLDP toutes les 2 à 8 min)
const LIMITS = { name: 60, jack: 40, room: 60, note: 200 };

export const syncKeys = [KEY.hash];
export const stateExtras = [
  { name: 'names', key: KEY.names, viewer: true },
  { name: 'plan', key: KEY.plan, viewer: true },
  { name: 'lastmac', key: KEY.lastmac, viewer: true },
];

const PORT_RE = /^1\/1\/([1-9]|1\d|2[0-8])$/;
const SWITCH_RE = /\d{4}|aruba|switch/i; // même règle que l'agent et lib/danger.js pour reconnaître un switch voisin
const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const portNum = (p) => Number(String(p).split('/').pop());
const byPort = (a, b) => portNum(a) - portNum(b);

// « AA-BB-CC-DD-EE-FF », « aabb.ccdd.eeff », « aabbcc-ddeeff »… -> « aa:bb:cc:dd:ee:ff » (null si invalide,
// multicast, nulle ou diffusion).
export function normMac(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!/^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$|^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$|^[0-9a-f]{6}-[0-9a-f]{6}$/.test(s)) return null;
  const hex = s.replace(/[^0-9a-f]/g, '');
  if (parseInt(hex.slice(0, 2), 16) & 1 || /^0{12}$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

// Texte saisi : une seule ligne, sans caractère de contrôle ni « # » en tête, espaces resserrés.
// Renvoie null si le type est invalide (ni texte, ni nombre, ni vide).
export function cleanText(v) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  return String(v).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[#\s]+/, '');
}

// IP et nom réseau connus de l'agent pour une adresse (state.ips).
function ipInfo(ips, mac) {
  const v = isObj(ips) ? ips[mac] : null;
  const ip = typeof v?.ip === 'string' && /^[0-9a-f.:]{3,45}$/i.test(v.ip) ? v.ip : '';
  const host = typeof v?.name === 'string' ? (cleanText(v.name) || '').slice(0, 64) : '';
  return { ip, host };
}

// ---------------------------------------------------------------- résumé (aruba:devhash)
// Stocké : { v: 2, on: { '1/1/N': ['aabbccddeeff'…] }, up: ['1/1/24'…], left: { '1/1/N': t } }
//   on   : appareils considérés branchés à la dernière écriture (présents, ou adresse vieillie sur un lien resté établi)
//   up   : ports traités comme liens vers d'autres switches, délai de grâce compris
//   left : heure à laquelle un lien a perdu son voisin LLDP (début du délai de grâce)
// Lu : mêmes champs avec des adresses « aa:bb:… » ; null si absent ou d'un ancien format (tout est réécrit une fois).
export function readSummary(v) {
  if (!isObj(v) || v.v !== 2) return null;
  const on = {}, left = {};
  for (const [port, list] of Object.entries(isObj(v.on) ? v.on : {})) {
    const macs = PORT_RE.test(port) && Array.isArray(list) ? list.map((h) => normMac(String(h))).filter(Boolean) : [];
    if (macs.length) on[port] = macs;
  }
  for (const [port, t] of Object.entries(isObj(v.left) ? v.left : {})) if (PORT_RE.test(port) && Number(t) > 0) left[port] = Number(t);
  const up = Array.isArray(v.up) ? v.up.filter((p) => PORT_RE.test(p)) : [];
  return { on, up, left };
}
export function packSummary({ on, up, left }) {
  return { v: 2, on: Object.fromEntries(Object.entries(on).map(([p, l]) => [p, l.map((m) => m.replace(/:/g, ''))])), up, left };
}
// Forme comparable d'un résumé : il faut écrire si elle change.
function canon(s) {
  if (!s) return '';
  const pairs = Object.entries(s.on).flatMap(([p, l]) => l.map((m) => `${m}@${p}`)).sort();
  return JSON.stringify([pairs, [...s.up].sort(byPort), Object.entries(s.left).sort(([a], [b]) => byPort(a, b))]);
}

// Répartition des ports pour un relevé de l'agent, d'après le résumé précédent (prev, peut être null) :
//   ports  : Map('1/1/N' -> [mac…]) des ports d'appareils, avec les adresses présentes (dans l'ordre des ports ;
//            une adresse vue sur deux ports n'est comptée que sur le premier)
//   frozen : ports qui portent trop d'adresses pour être une prise d'appareil : rien n'y change tant qu'ils en ont autant
//   up, left : liens vers d'autres switches (drapeau de l'agent ou voisin LLDP, puis délai de grâce après la perte du
//            voisin : pendant que l'agent relit son LLDP, la table du switch se remplit déjà de tout le réseau voisin)
//   on     : appareils considérés branchés, par port
export function scan(state, prev = null, now = 0) {
  const lldp = Array.isArray(state?.lldp) ? state.lldp : [];
  const all = (Array.isArray(state?.ports) ? state.ports : []).filter((p) => PORT_RE.test(p?.port)).sort((a, b) => byPort(a.port, b.port));
  const up = [], left = {};
  for (const p of all) {
    if (p.uplink ?? lldp.some((l) => l?.port === p.port && l.name && SWITCH_RE.test(l.name))) { up.push(p.port); continue; }
    if (!prev?.up.includes(p.port)) continue;
    const since = prev.left[p.port] ?? now;
    if (now - since < UPLINK_GRACE) { up.push(p.port); left[p.port] = since; }
  }
  const raw = new Map(all.filter((p) => !up.includes(p.port)).map((p) => [p.port, []]));
  for (const m of Array.isArray(state?.macs) ? state.macs : []) {
    const mac = normMac(m?.mac), list = raw.get(m?.port);
    if (mac && list && !list.includes(mac)) list.push(mac);
  }
  const ports = new Map(), frozen = new Set(), seen = new Set();
  for (const [port, macs] of raw) {
    if (macs.length > MAX_PORT_MACS) { frozen.add(port); continue; }
    ports.set(port, macs.filter((m) => !seen.has(m) && seen.add(m)));
  }
  const linked = new Map(all.map((p) => [p.port, Boolean(p.up)])), on = {};
  for (const [port, macs] of ports) {
    // adresse notée avant et absente de la table : toujours là si le lien est resté établi et qu'elle n'est pas ailleurs
    const kept = linked.get(port) ? (prev?.on[port] || []).filter((m) => !seen.has(m)) : [];
    const list = [...macs, ...kept].slice(0, MAX_PORT_MACS);
    if (list.length) on[port] = list;
  }
  for (const port of frozen) if (prev?.on[port]) on[port] = prev.on[port];
  return { ports, frozen, up, left, on };
}
export const changed = (prev, cur) => !prev || canon(prev) !== canon(cur);

// Met à jour le registre (copie, l'original n'est pas modifié). fresh : appareils jamais vus, à signaler.
export function mergeRegistry(prev, cur, ips, now) {
  const reg = {};
  for (const [mac, e] of Object.entries(isObj(prev) ? prev : {})) {
    if (normMac(mac) === mac && isObj(e)) reg[mac] = { ...e, ports: Array.isArray(e.ports) ? e.ports.slice(-HISTORY) : [] };
  }
  const firstRun = !Object.keys(reg).length; // premier passage : on mémorise sans alerter
  const fresh = [];
  for (const [port, macs] of cur.ports) {
    for (const mac of macs) {
      const { ip, host } = ipInfo(ips, mac);
      const e = reg[mac];
      if (!e) {
        reg[mac] = { first: now, last: now, port, ports: [[port, now]], ...(ip && { ip }), ...(host && { host }), on: true };
        if (!firstRun && macs.length <= ALERT_MACS) fresh.push({ mac, port, ip, host });
        continue;
      }
      if (e.port !== port) { e.ports = [...e.ports, [port, now]].slice(-HISTORY); e.port = port; }
      e.last = now; e.on = true;
      if (ip) e.ip = ip;
      if (host) e.host = host;
    }
  }
  // parti pour de bon (lien coupé, autre port, port devenu un lien vers un switch) : vu pour la dernière fois à peu près
  // maintenant. Une adresse simplement vieillie reste « branchée » avec sa dernière date de présence.
  const on = new Set(Object.values(cur.on).flat());
  for (const [mac, e] of Object.entries(reg)) if (e.on && !on.has(mac)) { e.on = false; e.last = now; }
  const all = Object.keys(reg);
  if (all.length > MAX_DEVICES) {
    all.sort((a, b) => (Number(reg[a].last) || 0) - (Number(reg[b].last) || 0));
    for (const mac of all.slice(0, all.length - MAX_DEVICES)) delete reg[mac];
  }
  return { reg, fresh, firstRun };
}

// Dernier appareil vu sur chaque port : { '1/1/N': { mac, t, on, ip?, host? } }. t : arrivée (on) ou départ (!on).
// L'appareil noté reste celui du port tant qu'il y est ; il est remplacé quand une autre adresse s'y montre en son
// absence. Un départ n'est noté que si l'appareil part pour de bon (comme dans le registre). Les liens vers d'autres
// switches n'ont pas d'entrée ; un port ignoré (trop d'adresses) garde la sienne telle quelle.
export function mergeLastmac(prev, cur, ips, now) {
  const lm = {};
  for (const [port, e] of Object.entries(isObj(prev) ? prev : {})) {
    if (PORT_RE.test(port) && !cur.up.includes(port) && isObj(e) && normMac(e.mac) === e.mac) lm[port] = e;
  }
  for (const [port, macs] of cur.ports) {
    const e = lm[port];
    if (macs.length) {
      const mac = e && macs.includes(e.mac) ? e.mac : macs[0];
      const { ip, host } = ipInfo(ips, mac);
      if (!e || e.mac !== mac || e.on === false) lm[port] = { mac, t: now, on: true, ...(ip && { ip }), ...(host && { host }) };
      else if ((ip && ip !== e.ip) || (host && host !== e.host)) lm[port] = { ...e, ...(ip && { ip }), ...(host && { host }) };
    } else if (e && e.on !== false && !cur.on[port]?.includes(e.mac)) lm[port] = { ...e, t: now, on: false };
  }
  return Object.fromEntries(Object.entries(lm).sort(([a], [b]) => byPort(a, b)));
}

export function newDeviceEvents(fresh) {
  const out = fresh.slice(0, ALERT_MAX).map(({ mac, port, ip, host }) => {
    const who = [host, ip].filter(Boolean).join(', ');
    return { type: 'new_device', level: 'warning', port, text: `Nouvel appareil sur le port ${portNum(port)} : ${mac}${who ? ` (${who})` : ''}` };
  });
  if (fresh.length > ALERT_MAX) {
    const n = fresh.length - ALERT_MAX;
    out.push({ type: 'new_device', level: 'warning', text: `Et ${n} autre${n > 1 ? 's' : ''} nouvel${n > 1 ? 's' : ''} appareil${n > 1 ? 's' : ''} : voir l’annuaire des appareils.` });
  }
  return out;
}

// ---------------------------------------------------------------- écritures conditionnelles
// KEYS = clé, clé de version, … ; ARGV = version lue ('*' : sans contrôle), nouvelle valeur ('' : inchangée), …
// Si une version a changé depuis la lecture, rien n'est écrit et le script renvoie 0. Chaque écriture incrémente la
// version de sa clé (le dashboard relit ainsi noms, plan et dernier appareil vu, comme avec writeJSON).
const CAS = `for i = 1, #KEYS, 2 do
  if ARGV[i] ~= '*' and (redis.call('GET', KEYS[i + 1]) or '') ~= ARGV[i] then return 0 end
end
for i = 1, #KEYS, 2 do
  if ARGV[i + 1] ~= '' then
    redis.call('SET', KEYS[i], ARGV[i + 1])
    redis.call('INCR', KEYS[i + 1])
  end
end
return 1`;
// Lit les clés et leurs versions, calcule les nouvelles valeurs avec edit(valeurs) (undefined : inchangée), puis écrit
// seulement si personne n'a écrit entre-temps ; sinon relit et recommence (3 essais). Renvoie les valeurs finales, ou
// null après trois conflits. Coût par essai : MGET, + EVAL s'il y a quelque chose à écrire.
async function update(r, keys, edit) {
  const kv = keys.flatMap((k) => [k, K.ver(k)]);
  for (let i = 0; i < 3; i++) {
    const got = await r.mget(...kv);
    const cur = keys.map((_, j) => got?.[2 * j] ?? null);
    const next = edit(cur);
    if (keys.every((_, j) => next[j] === undefined)) return cur;
    const argv = keys.flatMap((_, j) => [String(got?.[2 * j + 1] ?? ''), next[j] === undefined ? '' : JSON.stringify(next[j])]);
    if (Number(await r.eval(CAS, kv, argv)) === 1) return keys.map((_, j) => (next[j] === undefined ? cur[j] : next[j]));
  }
  return null;
}
const conflict = () => httpError(409, 'Modifié au même moment par une autre requête : réessaie.');

// Coût : 0 commande si aucun appareil n'arrive, ne change de port ni ne part pour de bon (et si les liens vers d'autres
// switches ne changent pas) ; sinon MGET + EVAL (registre, résumé et, s'il change, dernier appareil par port), + GET des
// réglages seulement s'il y a un nouvel appareil (et qu'ils ne sont pas déjà chargés).
export async function onSync({ r, state, vals, events, settings }) {
  if (!Array.isArray(state?.ports) || !state.ports.length || !Array.isArray(state?.macs)) return; // ancien agent ou relevé incomplet
  const now = Math.round(Date.now() / 1000), seen = readSummary(vals?.[KEY.hash]);
  if (!changed(seen, scan(state, seen, now))) return;
  const ips = isObj(state.ips) ? state.ips : {};
  let fresh = [];
  const done = await update(r, [KEY.devices, KEY.lastmac, KEY.hash], ([prevReg, prevLm, rawSum]) => {
    const prev = readSummary(rawSum), cur = scan(state, prev, now);
    fresh = [];
    if (!changed(prev, cur)) return []; // déjà écrit par un envoi simultané
    const m = mergeRegistry(prevReg, cur, ips, now), lm = mergeLastmac(prevLm, cur, ips, now);
    fresh = m.fresh;
    return [m.reg, JSON.stringify(lm) === JSON.stringify(isObj(prevLm) ? prevLm : {}) ? undefined : lm, packSummary(cur)];
  });
  if (!done) { console.error('[devices] registre modifié en même temps trois fois : repris au prochain envoi'); return; }
  if (!fresh.length) return;
  let on = false;
  try { on = Boolean((await settings())?.notify?.newDevice); } catch (e) { console.error('[devices] réglages', e); }
  if (on) events.push(...newDeviceEvents(fresh));
}

// ---------------------------------------------------------------- actions et lectures
// Valide un champ texte : type, nettoyage, longueur.
function field(v, max, label) {
  const s = cleanText(v);
  if (s === null) throw httpError(400, `${label} : texte attendu.`);
  if (s.length > max) throw httpError(400, `${label} : ${max} caractères au maximum.`);
  return s;
}
function macOf(body) {
  const mac = normMac(body?.mac);
  if (!mac) throw httpError(400, 'Adresse MAC invalide.');
  return mac;
}
// Copies propres des noms et du plan enregistrés (ignorent ce qui serait mal formé ; plan dans l'ordre des ports).
function cleanNames(v) {
  const out = {};
  for (const [mac, e] of Object.entries(isObj(v) ? v : {})) if (normMac(mac) === mac && typeof e?.name === 'string' && e.name) out[mac] = { name: e.name, t: Number(e.t) || 0 };
  return out;
}
function cleanPlan(v) {
  return Object.fromEntries(Object.entries(isObj(v) ? v : {}).filter(([p, e]) => PORT_RE.test(p) && isObj(e)).sort(([a], [b]) => byPort(a, b)));
}

export const actions = {
  // Nom donné à un appareil (vide : supprime le nom). Coût : MGET + EVAL (MGET seul si le nom ne change pas).
  'device-name': async ({ r, body }) => {
    const mac = macOf(body);
    const label = field(body?.name, LIMITS.name, 'Nom');
    const out = await update(r, [KEY.names], ([cur]) => {
      const names = cleanNames(cur);
      if (label ? names[mac]?.name === label : !names[mac]) return [];
      if (!label) delete names[mac];
      else {
        if (!names[mac] && Object.keys(names).length >= MAX_NAMES) throw httpError(400, `Déjà ${MAX_NAMES} appareils nommés : efface des noms inutiles avant d’en ajouter.`);
        names[mac] = { name: label, t: Math.round(Date.now() / 1000) };
      }
      return [names];
    });
    if (!out) throw conflict();
    return { ok: true, names: cleanNames(out[0]) };
  },
  // Plan de brassage d'un port (prise murale, salle, note ; tout vide : supprime). Coût : MGET + EVAL (MGET seul si rien
  // ne change).
  'port-plan': async ({ r, body }) => {
    const port = typeof body?.port === 'string' ? body.port.trim() : '';
    if (!PORT_RE.test(port)) throw httpError(400, 'Port invalide (1/1/1 à 1/1/28).');
    const entry = { jack: field(body?.jack, LIMITS.jack, 'Prise murale'), room: field(body?.room, LIMITS.room, 'Salle'), note: field(body?.note, LIMITS.note, 'Note') };
    const empty = !entry.jack && !entry.room && !entry.note;
    const out = await update(r, [KEY.plan], ([cur]) => {
      const plan = cleanPlan(cur), e = plan[port];
      if (empty ? !e : e?.jack === entry.jack && e?.room === entry.room && e?.note === entry.note) return [];
      if (empty) delete plan[port]; else plan[port] = entry;
      return [cleanPlan(plan)]; // ports dans l'ordre pour un plan lisible
    });
    if (!out) throw conflict();
    return { ok: true, plan: cleanPlan(out[0]) };
  },
  // Retire un appareil absent du registre, du résumé et des noms. Coût : MGET + EVAL.
  'device-forget': async ({ r, body, state }) => {
    const mac = macOf(body);
    for (const [port, macs] of scan(state).ports) {
      if (macs.includes(mac)) throw httpError(409, `Cet appareil est branché en ce moment (port ${portNum(port)}) : il réapparaîtrait aussitôt. Seul un appareil absent peut être oublié.`);
    }
    let removed = false;
    const out = await update(r, [KEY.devices, KEY.names, KEY.hash], ([reg, rawNames, rawSum]) => {
      const names = cleanNames(rawNames), sum = readSummary(rawSum);
      const inReg = isObj(reg) && Object.hasOwn(reg, mac), named = Object.hasOwn(names, mac);
      // encore noté comme branché (adresse vieillie, lien établi) : sans cela, il ne reviendrait pas dans l'annuaire
      const inSum = Boolean(sum) && Object.values(sum.on).some((l) => l.includes(mac));
      removed = inReg || named;
      if (inReg) { reg = { ...reg }; delete reg[mac]; }
      if (named) delete names[mac];
      if (inSum) for (const [p, l] of Object.entries(sum.on)) { const k = l.filter((m) => m !== mac); if (k.length) sum.on[p] = k; else delete sum.on[p]; }
      return [inReg ? reg : undefined, named ? names : undefined, inSum ? packSummary(sum) : undefined];
    });
    if (!out) throw conflict();
    return { ok: true, removed, names: cleanNames(out[1]) };
  },
};

export const reads = {
  // Registre complet (administrateur et écran lecture seule). Coût : GET.
  devices: async ({ r, role }) => {
    if (role !== 'admin' && role !== 'viewer') throw httpError(403, 'Accès refusé.');
    const reg = await r.get(KEY.devices);
    return { devices: isObj(reg) ? reg : {}, max: MAX_DEVICES };
  },
};
