// Sauvegardes de la configuration : copie de « show running-config » (secrets masqués) toutes les 6 h et quelques
// minutes après chaque changement fait depuis le dashboard. Une version n'est gardée que si le texte a changé.
//   aruba:cfg:index   [{ id, t, h, lines, added, removed, reason, last, cut? }] (60 versions, la plus récente en tête ;
//                     last : dernière relecture réussie qui a trouvé ce texte)
//   aruba:cfg:<id>    { id, t, text } (400 jours)
//   aruba:cfg:checked mise en file de la dernière relecture réussie (s) : tout changement demandé après passe après elle
//   aruba:cfg:want    dernier changement demandé (s), dans le futur tant qu'une annulation automatique peut le défaire
//   aruba:cfg:pending id de la sauvegarde en file (15 min), ou de la dernière en échec (délai avant un nouvel essai)
import crypto from 'node:crypto';
import { K, writeJSON } from '../redis.js';
import { httpError } from './index.js';

export const name = 'backup';

export const CFG = {
  index: 'aruba:cfg:index', checked: 'aruba:cfg:checked', want: 'aruba:cfg:want', pending: 'aruba:cfg:pending',
  version: (id) => `aruba:cfg:${id}`,
};
const MAX_VERSIONS = 60;
const KEEP = 400 * 86400;    // durée de vie d'une version (s)
const EVERY = 6 * 3600;      // vérification régulière
const SETTLE = 120;          // délai après un changement (les commandes en file passent avant)
const ONLINE = 180;          // agent considéré en ligne
const PENDING_TTL = 900;
const RETRY = 3600;          // échec : nouvel essai après 1 h, doublé à chaque échec de suite (6 h au plus)
const MARGIN = 2;            // s : un changement demandé juste avant la mise en file de la relecture est revérifié
const KINDS = ['auto:backup', 'backup'];
const OUT_TTL = 3 * 86400;   // identique à api/agent/result.js
const OUT_MAX = 60000;       // sortie tronquée au-delà (api/agent/result.js)
const HEAD = '» show running-config';
const LABEL = 'Sauvegarde de la configuration';
export const MASK = '<masqué>';

const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const nowS = () => Math.round(Date.now() / 1000);

// ---------------------------------------------------------------- fonctions pures (testées à part)

// Ligne qui modifie la configuration : entrée en mode configuration, sauvegarde, retour à un point de restauration
// ou copie vers la configuration active.
const CONFIG_LINE = /^(conf(ig(ure)?)?(\s+t(erm(inal)?)?)?|write\s+mem(ory)?|checkpoint\s+rollback\s+\S+|copy\s+.+\s+running-config)$/i;
export const changesConfig = (cmd) => String(cmd ?? '').split('\n').some((l) => CONFIG_LINE.test(l.trim()));

// Mots suivis d'une valeur secrète. « ciphertext »/« plaintext » peuvent suivre « password » ou « key » : le dernier
// mot-clé de la chaîne masque la valeur. Les clés publiques SSH ne sont pas des secrets.
const SECRET_WORD = /^(ciphertext|plaintext|community|password|passphrase|secret|key|key-string|auth-pass|priv-pass|[a-z0-9-]*-(key|secret|password))$/i;
const PUBLIC_WORD = /^(authorized-key|public-key)$/i;
// Texte libre (descriptions, noms de VLAN, bannière, emplacement…) : jamais de secret, gardé tel quel.
const FREE_TEXT = /^\s*(description|name|banner|hostname|snmp-server\s+system-(location|contact|description))(\s|$)/i;
// Communautés SNMP par défaut : valeurs connues de tous, gardées pour que le bilan de santé puisse les signaler.
const DEFAULT_COMMUNITY = /^(public|private)$/i;
const SPACE = /^\s*$/;
const word = (p) => p.replace(/[\x00-\x1f\x7f]/g, ''); // reste de pagination (retour arrière…) collé à un mot

export function maskLine(line) {
  const s = String(line ?? '');
  if (!/ciphertext|plaintext|community|password|passphrase|secret|key|-pass/i.test(s) || FREE_TEXT.test(word(s))) return s;
  const parts = s.split(/(\s+)/); // mots et espaces alternés : l'indentation est conservée
  for (let i = 0; i < parts.length; i++) {
    const w = word(parts[i]);
    if (SPACE.test(parts[i]) || PUBLIC_WORD.test(w) || !SECRET_WORD.test(w)) continue;
    let j = i + 1;
    while (j < parts.length && SPACE.test(parts[j])) j++;
    if (j >= parts.length) break;
    if (SECRET_WORD.test(word(parts[j]))) continue; // « password ciphertext X » : « ciphertext » masquera X
    if (/^community$/i.test(w) && DEFAULT_COMMUNITY.test(word(parts[j]))) { i = j; continue; }
    let end = j; // valeur entre guillemets : jusqu'au guillemet fermant (ou la fin de la ligne)
    if (parts[j].startsWith('"') && !(parts[j].length > 1 && parts[j].endsWith('"'))) {
      end = j + 1;
      while (end < parts.length && (SPACE.test(parts[end]) || !parts[end].endsWith('"'))) end++;
      if (end >= parts.length) end = parts.length - 1;
    }
    parts.splice(j, end - j + 1, MASK);
    i = j;
  }
  return parts.join('');
}

// Masque aussi un éventuel bloc de clé privée (BEGIN … PRIVATE KEY … END).
export function maskLines(lines) {
  let pem = false;
  return lines.map((l) => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l)) { pem = true; return l; }
    if (pem) { if (/-----END /.test(l)) { pem = false; return l; } return MASK; }
    return maskLine(l);
  });
}

// Nettoie une ligne lue sur la console : caractères de contrôle, reste de pagination, espaces de fin.
const cleanLine = (l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s*-- ?MORE ?--\s*/gi, '').replace(/\s+$/, '');

// Lignes de la configuration dans la sortie de l'agent (« » show running-config » puis le texte), sans l'en-tête.
export function configBody(output) {
  const lines = String(output ?? '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.trim() === HEAD);
  if (start < 0) return [];
  const body = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('» '); i++) body.push(cleanLine(lines[i]));
  while (body.length && !body[0]) body.shift();
  while (body.length && !body[body.length - 1]) body.pop();
  return body;
}

// Message d'erreur du switch ou de l'agent, sinon null.
const ERROR_LINE = /^\s*(% |%Invalid|Invalid input|Error|ERROR|Erreur|Session console non connectée)/;
export function switchError(lines) {
  return lines.slice(0, 8).find((l) => ERROR_LINE.test(l))?.trim() || null;
}
// Une vraie configuration AOS-CX contient au moins des interfaces ou des VLAN.
export const looksLikeConfig = (lines) => lines.length >= 3 && !switchError(lines)
  && lines.some((l) => /^(interface|vlan|hostname|!Version)\b/i.test(l));

export const fingerprint = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 24);

// Nombre de lignes ajoutées et retirées entre deux textes (plus longue sous-suite commune, algorithme de Myers
// en espace linéaire, après avoir écarté le début et la fin identiques).
export function diffCount(a, b) {
  const ids = new Map(), code = (l) => { let v = ids.get(l); if (v === undefined) ids.set(l, (v = ids.size)); return v; };
  const A = a.map(code), B = b.map(code);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  if (!n || !m) return { added: m, removed: n };
  const max = n + m, off = max + 1, v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[s + x] === B[s + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { const common = (n + m - d) / 2; return { added: m - common, removed: n - common }; }
    }
  }
  return { added: m, removed: n };
}

// Nom court d'une commande pour la raison d'une version.
const cmdName = (c) => String(c.label || String(c.cmd || '').split('\n').map((l) => l.trim())
  .find((l) => l && !/^(conf(ig(ure)?)?(\s+t(erm(inal)?)?)?|end|exit)$/i.test(l)) || 'Commande de configuration').slice(0, 100);

// Raison d'une nouvelle version : dernière commande de configuration terminée depuis la version précédente.
export function reasonFor(log, entry, since, now) {
  const done = arr(log).filter((c) => c && c.id !== entry?.id && ['done', 'error'].includes(c.status)
    && num(c.finished) > since && num(c.finished) <= now + 5 && changesConfig(c.cmd))
    .sort((x, y) => num(y.finished) - num(x.finished));
  if (!done.length) return entry?.meta?.planned ? 'Sauvegarde planifiée' : 'Sauvegarde demandée';
  const more = done.length - 1;
  return (cmdName(done[0]) + (more ? ` (+${more} autre${more > 1 ? 's' : ''})` : '')).slice(0, 120);
}

// Commande dont la réponse contient de la configuration, abréviations AOS-CX comprises : show running-config et
// show startup-config (avec ou sans arguments), contenu d'un point de restauration (show checkpoint <nom>) et
// checkpoint diff. « show checkpoint » seul (la liste des points) n'en fait pas partie.
const prefix = (w, full, min) => typeof w === 'string' && w.length >= min && full.startsWith(w);
export function showsConfig(cmd) {
  const w = String(cmd ?? '').trim().toLowerCase().split(/\s+/);
  if (prefix(w[0], 'checkpoint', 5)) return prefix(w[1], 'diff', 1);
  if (!prefix(w[0], 'show', 2)) return false;
  if (prefix(w[1], 'running-config', 3) || prefix(w[1], 'startup-config', 5)) return true;
  return prefix(w[1], 'checkpoint', 5) && Boolean(w[2]) && !/^(\||date|json)$/.test(w[2]);
}

// Sortie complète de l'agent (sections « » <ligne> ») sans secrets : chaque section qui affiche de la configuration est
// masquée avec les règles des sauvegardes, tout le reste est rendu à l'identique. Fonction pure, appelée par
// api/agent/result.js avant la première écriture de la sortie (aruba:out:<id>, lisible par la console et les relevés).
export function maskOutput(output) {
  const text = String(output ?? '');
  if (!text.includes('» ')) return text;
  const lines = text.split('\n'), res = [];
  for (let i = 0; i < lines.length;) {
    const head = lines[i].startsWith('» ') ? lines[i].slice(2) : null; // un éventuel « \r » final est retiré par trim
    res.push(lines[i++]);
    if (head === null || !showsConfig(head)) continue;
    const start = i;
    while (i < lines.length && !lines[i].startsWith('» ')) i++;
    res.push(...maskLines(lines.slice(start, i)));
  }
  return res.join('\n');
}

// ---------------------------------------------------------------- points d'accroche

// Délai avant un nouvel essai après l'échec d'une sauvegarde : 1 h, puis 2 h, 4 h et 6 h si les échecs se suivent
// (comptés dans le journal, sans commande de plus). Un switch qui refuse la commande est donc réessayé toutes les 6 h,
// comme une relecture normale, au lieu de remplir le journal.
export function retryDelay(log, id) {
  let n = 1;
  const others = arr(log).filter((c) => c && c.id !== id && KINDS.includes(c.kind)).sort((x, y) => num(y.created) - num(x.created));
  for (const c of others) {
    if (c.status === 'done') break;
    if (c.status === 'error') n++;
  }
  return Math.min(EVERY, RETRY * 2 ** Math.min(n - 1, 8));
}

// Délai pendant lequel le switch peut annuler seul le changement (« checkpoint auto <min> » ajouté par undo, ou tapé
// dans la console) : la sauvegarde attend de savoir s'il est gardé ou annulé.
export function holdFor(cmd) {
  const m = String(cmd ?? '').match(/^\s*checkpoint\s+auto\s+(\d+)\s*$/im);
  return m ? Math.min(60, Number(m[1])) * 60 + 30 : 0;
}

// want ne recule jamais : un changement ordinaire fait pendant le délai d'annulation ne la rapproche pas.
const WANT_MAX = `local v = tonumber(redis.call('GET', KEYS[1])) or 0
if tonumber(ARGV[1]) > v then redis.call('SET', KEYS[1], ARGV[1]) end
return 1`;

// Commande administrateur qui modifie la configuration : une sauvegarde suivra (1 commande EVAL, seulement dans ce cas).
export async function wrapCommand({ r, cmd }) {
  if (!changesConfig(cmd)) return;
  await r.eval(WANT_MAX, [CFG.want], [String(nowS() + holdFor(cmd))]);
}

export const cronKeys = [CFG.index, CFG.checked, CFG.want, CFG.pending];

// Toutes les 5 min : met en file une sauvegarde si l'agent répond, qu'aucune n'est en attente (ni en délai après un
// échec), et que la dernière relecture réussie date de plus de 6 h ou qu'un changement a été demandé après sa mise en
// file (2 min plus tôt au moins, et après la fin d'une éventuelle annulation automatique).
export async function onCron({ r, now, state, vals, enqueue }) {
  const received = num(state?.received);
  if (!received || now - received > ONLINE) return;
  if (vals?.[CFG.pending]) return;
  const top = arr(vals?.[CFG.index])[0];
  const read = num(top?.last) || num(top?.t) || num(vals?.[CFG.checked]);
  const checked = num(vals?.[CFG.checked]) || read;
  const want = num(vals?.[CFG.want]);
  if (!(now - read > EVERY || (want > checked && now - want > SETTLE))) return;
  const rec = await enqueue({ cmd: 'show running-config', label: LABEL, kind: 'auto:backup', meta: { planned: true } });
  if (rec?.id) await r.set(CFG.pending, rec.id, { ex: PENDING_TTL });
}

// Résultat d'une sauvegarde : nouvelle version si le texte (secrets masqués) a changé. En cas d'échec (switch
// injoignable, session non connectée, commande refusée, sortie vide), rien n'est noté comme relu et la clé « pending »
// retarde le nouvel essai (retryDelay).
export async function onResult({ r, id, output, status }) {
  const raw = String(output ?? '');
  const head = /^» show running-config[ \t]*(\n|$)/.test(raw.trimStart());
  // Aucune commande Redis pour les autres résultats. Une erreur sans aucune section (connexion au switch impossible,
  // session non connectée) peut venir d'une sauvegarde : 1 MGET dans ce cas, rare.
  if (!head && !(status === 'error' && !raw.trimStart().startsWith('» '))) return;
  const [log, index, pending] = await r.mget(K.log, CFG.index, CFG.pending);
  const entry = arr(log).find((c) => c?.id === id);
  if (!entry || !KINDS.includes(entry.kind)) return;
  const now = nowS();
  const safe = maskOutput(raw);
  // Déjà masquée par api/agent/result.js en temps normal : réécrite seulement si un secret est encore en clair.
  const writes = safe !== raw ? [r.set(K.out(id), safe.slice(0, OUT_MAX), { ex: OUT_TTL })] : [];
  const body = head ? configBody(raw) : [];
  if (status === 'error' || !looksLikeConfig(body)) {
    writes.push(r.set(CFG.pending, id, { ex: retryDelay(log, id) }));
    await Promise.all(writes);
    return;
  }
  // Relecture datée de sa mise en file, pas de son résultat : un changement demandé entre les deux passe après elle
  // dans la file, il doit donc déclencher une nouvelle sauvegarde.
  const queued = Math.floor(num(entry.created));
  writes.push(r.set(CFG.checked, queued > MARGIN ? Math.min(now, queued - MARGIN) : now));
  if (pending) writes.push(r.del(CFG.pending));
  await Promise.all(writes);

  const lines = maskLines(body);
  const h = fingerprint(lines);
  const list = arr(index).filter((x) => x && typeof x.id === 'string' && now - num(x.t) < KEEP);
  const prev = list[0];
  if (prev && prev.h === h) { // configuration inchangée : on note seulement qu'elle a été vérifiée
    await writeJSON(CFG.index, [{ ...prev, last: now }, ...list.slice(1)]);
    return;
  }

  let added = null, removed = null;
  if (prev) {
    const old = await r.get(CFG.version(prev.id));
    if (typeof old?.text === 'string') ({ added, removed } = diffCount(old.text.split('\n'), lines));
  }
  const text = lines.join('\n');
  const item = { id, t: now, h, lines: lines.length, added, removed, reason: reasonFor(log, entry, num(prev?.t), now), last: now };
  if (raw.length >= OUT_MAX) item.cut = true; // sortie tronquée par le dashboard
  await r.set(CFG.version(id), { id, t: now, text }, { ex: KEEP });
  const next = [item, ...list.filter((x) => x.id !== id)];
  await writeJSON(CFG.index, next.slice(0, MAX_VERSIONS));
  const dropped = next.slice(MAX_VERSIONS).map((x) => CFG.version(x.id));
  if (dropped.length) await r.del(...dropped);
}

// GET /api/output?part=cfg[&id=<id>] : une version (la dernière sans id), administrateur seulement.
export const reads = {
  cfg: async ({ r, role, query }) => {
    if (role !== 'admin') throw httpError(403, 'Configuration du switch réservée à l’administrateur.');
    let id = query?.id;
    if (id !== undefined && id !== '') {
      id = String(id);
      if (!/^[\w-]{36}$/.test(id)) throw httpError(400, 'Version de configuration inconnue.');
    } else {
      id = arr(await r.get(CFG.index))[0]?.id;
      if (!id) return null;
    }
    const v = await r.get(CFG.version(id));
    if (!v || typeof v !== 'object' || typeof v.text !== 'string') return null;
    return { id: String(v.id || id), t: num(v.t), text: v.text };
  },
};

export const stateExtras = [{ name: 'cfg', key: CFG.index, viewer: false }];
