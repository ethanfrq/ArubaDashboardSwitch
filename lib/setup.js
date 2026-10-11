import { store, K, mergeSettings } from './db.js';
import { ensureCron } from './store.js';
import { USERS, loadUsers, publicUser, audit, fail } from './users.js';

// Installation et assistant de démarrage : vérifications (base, variables Vercel, vérification automatique, agent,
// sécurité du compte, alertes, comptes) et fichier agent_config.json pré-rempli pour l'agent Windows.
// Ce qui part vers la page ne contient que des booléens et des noms de variables, jamais une valeur ; seul le
// fichier de configuration de l'agent, demandé par un administrateur, contient le jeton de l'agent.
//   mam:onboarding { done, doneAt, dismissed, by (compte qui l'a modifié en dernier) }
export const ONBOARDING = 'mam:onboarding';
export const AGENT_LATEST = '1.4.0'; // dernière version de l'agent publiée avec ce dashboard (comme dans la page)
export const AGENT_DOWNLOAD = 'https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest';
const UPDATE_REPO = 'ethanfrq/ArubaDashboardSwitch';
const REQUIRED = ['SESSION_SECRET', 'AGENT_TOKEN', 'DASHBOARD_PASSWORD'];
const DB_VARS = ['POSTGRES_URL', 'DATABASE_URL', 'SUPABASE_DB_URL']; // l'une des trois suffit (voir lib/store.js)
const AGENT_ONLINE = 180; // s : au-delà, l'agent est jugé hors ligne (comme les actions planifiées)
const DB_WAIT = 8000;     // ms : réponse « base injoignable » avant la fin du délai de la fonction

const now = () => Math.round(Date.now() / 1000);

// Variables obligatoires absentes (noms seulement). La base compte comme « POSTGRES_URL » si aucune des trois n'existe.
export function missingEnv() {
  const miss = REQUIRED.filter((k) => !String(process.env[k] || '').trim());
  if (!DB_VARS.some((k) => String(process.env[k] || '').trim())) miss.push('POSTGRES_URL');
  return miss;
}

function within(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Base de données : pas de réponse.')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// État de l'installation montré avant la connexion : { ok, db, missing, fresh }. Ne lève jamais d'exception.
// fresh : aucun compte n'a encore ouvert de session (seul le compte « admin », sans lastLogin) ; absent sans base.
export async function publicSetup() {
  const missing = missingEnv();
  let db = false, fresh;
  if (!missing.includes('POSTGRES_URL')) {
    try {
      const [doc, viewer] = await within(store().mget(USERS, K.viewer), DB_WAIT);
      const users = Array.isArray(doc?.users) ? doc.users : [];
      // Comptes pas encore créés : neuve, sauf ancienne installation avec un mot de passe lecture seule (compte « ecran »).
      fresh = users.length ? users.length === 1 && Boolean(users[0].owner) && !users[0].lastLogin : !viewer?.salt;
      db = true;
    } catch (e) {
      console.error('setup: base', e?.message || e);
    }
  }
  return { ok: !missing.length && db, db, missing, ...(db ? { fresh } : {}) };
}

// Même état, pour les visiteurs pas encore connectés (GET /api/state) : gardé en mémoire par instance, 30 s si
// l'installation est complète, 10 s sinon. Une rafale de requêtes anonymes ne sollicite donc pas la base à chaque
// fois, et n'attend pas 8 s chacune quand elle ne répond pas. Une variable ajoutée sur Vercel demande un
// redéploiement, donc de nouvelles instances : rien de périmé à « Revérifier ».
let memo = null;
export function cachedSetup() {
  if (memo && Date.now() < memo.until) return memo.p;
  const m = { p: publicSetup(), until: Date.now() + 10000 };
  memo = m;
  m.p.then((v) => { m.until = Date.now() + (v.ok ? 30000 : 10000); }, () => { if (memo === m) memo = null; });
  return m.p;
}

// Adresse du dashboard donnée à l'agent : DASHBOARD_URL, sinon l'adresse de production Vercel, sinon (développement
// local seulement) celle de la requête. Jamais l'en-tête Host ailleurs : le client le choisit, et l'agent enverrait
// son jeton à cette adresse. null si elle est inconnue (hébergement hors Vercel sans DASHBOARD_URL).
export function dashboardUrl(req) {
  const env = String(process.env.DASHBOARD_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const host = String(req?.headers?.host || '').trim().toLowerCase();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(host);
  if (local && !['production', 'preview'].includes(process.env.VERCEL_ENV)) return `http://${host}`;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

const onboarding = (v) => ({ done: Boolean(v?.done), doneAt: Number(v?.doneAt) || null, dismissed: Boolean(v?.dismissed), by: v?.by ?? null });

// GET /api/settings?part=setup (administrateur) : chaque étape de l'assistant, vérifiée en direct.
export async function setupChecks(s, req) {
  const r = store();
  // En production : programme la vérification toutes les 5 min si ce n'est pas encore fait ; après un échec, réessaie
  // (une fois par minute au plus) pour que « Revérifier » passe au vert dès que pg_cron et pg_net sont activés.
  await ensureCron({ force: true });
  const [[state, cron, onb, rawSettings], { doc }] = await Promise.all([r.mget(K.state, 'mam:cron', ONBOARDING, K.settings), loadUsers()]);
  const missing = missingEnv();
  const settings = mergeSettings(rawSettings);
  const me = publicUser(s.user);

  const received = Number(state?.received) || null;
  const ago = received ? Math.max(0, Math.round(Date.now() / 1000 - received)) : null;
  const version = state?.agent?.version;
  const agent = { ok: ago !== null && ago < AGENT_ONLINE, seen: received,
    version: typeof version === 'string' || typeof version === 'number' ? version : null,
    host: state?.hostname ? String(state.hostname).slice(0, 64) : null,
    ports: Array.isArray(state?.ports) ? state.ports.length : 0, ago };

  const active = doc.users.filter((u) => !u.disabled && !u.pending);
  const channels = [];
  if (settings.email) channels.push('email');
  if (settings.webhook) channels.push('webhook');
  if (active.some((u) => u.prefs?.alerts && u.email)) channels.push('accounts'); // « Recevoir les alertes » (Mon profil)

  return {
    checks: {
      db: { ok: true },
      env: { ok: !missing.length, missing },
      // En développement local, la vérification automatique n'est jamais programmée : rien à corriger.
      cron: process.env.VERCEL_ENV !== 'production' ? { ok: true, error: null, local: true }
        : { ok: Boolean(cron?.ok), error: cron?.ok ? null : (cron?.error ? String(cron.error).slice(0, 300) : null) },
      agent,
      password: { ok: me.ownPassword },
      twofa: { ok: me.has2fa },
      alerts: { ok: channels.length > 0, channels },
      users: { ok: active.length > 1, count: active.length },
    },
    dashboardUrl: dashboardUrl(req),
    agentDownload: AGENT_DOWNLOAD,
    agentLatest: AGENT_LATEST,
    onboarding: onboarding(onb),
  };
}

// POST { action: 'onboarding-save', done?, dismissed? } (administrateur) : « Plus tard » et « Terminer ».
export async function saveOnboarding(b, s, req) {
  const r = store();
  const cur = onboarding(await r.get(ONBOARDING));
  const next = { ...cur, by: s.uid };
  if (b.done !== undefined) next.done = Boolean(b.done);
  if (b.dismissed !== undefined) next.dismissed = Boolean(b.dismissed);
  next.doneAt = next.done ? (cur.done ? cur.doneAt : now()) : null;
  await r.set(ONBOARDING, next);
  if (next.done && !cur.done) await audit(s.user, 'Assistant de démarrage terminé', '', req);
  return { ok: true, onboarding: next };
}

// ---------------------------------------------------------------- fichier de configuration de l'agent
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i; // segment de nom d'hôte (RFC 1123)

// Adresse IPv4 en 4 octets, ou null : 4 nombres de 0 à 255, sans zéro en tête (« 010 » se lirait en octal ailleurs).
function ipv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1);
  if (parts.some((x) => (x.length > 1 && x[0] === '0') || Number(x) > 255)) return null;
  return parts.map(Number);
}

function validHost(raw) {
  const h = String(raw ?? '').trim();
  if (!h) throw fail('Indique l’adresse IP du switch (exemple 192.168.1.2).');
  if (h.length > 253) throw fail('Nom d’hôte du switch trop long : 253 caractères au plus.');
  if (/^[\d.]+$/.test(h)) { // que des chiffres et des points : une adresse IP
    const ip = ipv4(h);
    if (!ip) throw fail('Adresse IP du switch invalide : 4 nombres de 0 à 255 séparés par des points, sans zéro au début (exemple 192.168.1.2).');
    if (ip[0] === 0 || ip[0] >= 224) throw fail('Adresse IP du switch inutilisable : indique l’IP de gestion du switch (exemple 192.168.1.2).');
    return h;
  }
  if (!h.split('.').every((l) => LABEL.test(l))) {
    throw fail('Adresse du switch invalide : une adresse IP (exemple 192.168.1.2) ou un nom d’hôte fait de lettres, chiffres, points et tirets (sans espace, sans port, sans « http »).');
  }
  return h.toLowerCase();
}

function validUser(raw) {
  const u = String(raw ?? '').trim();
  if (!u) return 'admin';
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(u)) throw fail('Compte SSH invalide : 32 caractères au plus, lettres, chiffres, point, tiret ou tiret bas (souvent « admin »).');
  return u;
}

// Réseau à scanner : vide (pas de recherche des IP) ou « adresse/préfixe », ramené à l'adresse du réseau.
function validSubnet(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(v);
  if (!m) throw fail('Réseau à scanner invalide : écris-le avec son préfixe, par exemple 192.168.1.0/24 (ou laisse vide).');
  const ip = ipv4(m[1]), p = Number(m[2]);
  if (!ip) throw fail('Réseau à scanner invalide : l’adresse doit faire 4 nombres de 0 à 255 (exemple 192.168.1.0/24).');
  // L'agent ne cherche pas au-delà de 1024 adresses (agent.py, scan_ips) : un /21 ou plus grand désactiverait la recherche.
  if (p < 22 || p > 30) throw fail('Réseau à scanner : le préfixe doit être entre /22 et /30 (l’agent cherche sur 1024 adresses au plus ; /24 couvre 254 adresses, le cas le plus courant).');
  const n = ip.reduce((a, x) => a * 256 + x, 0), size = 2 ** (32 - p);
  const net = n - (n % size);
  return `${[24, 16, 8, 0].map((sh) => Math.floor(net / 2 ** sh) % 256).join('.')}/${p}`;
}

// POST { action: 'agent-config', switch_host, switch_user, scan_subnet } (administrateur, double authentification
// exigée active). Mêmes clés, dans le même ordre, que agent/agent_config.example.json. Le mot de passe SSH reste
// vide : installer-service.bat le demande et Windows l'enregistre chiffré.
export async function agentConfig(b, s, req) {
  const token = process.env.AGENT_TOKEN;
  if (!token) throw fail('AGENT_TOKEN n’est pas défini dans les variables d’environnement du projet Vercel : ajoute-le, redéploie, puis recommence.', 503);
  const url = dashboardUrl(req);
  if (!url) throw fail('Adresse du dashboard inconnue : ajoute la variable DASHBOARD_URL (par exemple https://mon-projet.vercel.app) dans le projet Vercel, redéploie, puis recommence.', 503);
  const host = validHost(b.switch_host), user = validUser(b.switch_user), subnet = validSubnet(b.scan_subnet);
  const config = {
    transport: 'ssh',
    switch_host: host,
    switch_user: user,
    switch_password: '',
    dashboard_url: url,
    agent_token: token,
    scan_subnet: subnet,
    idle_sync: 60,
    hot_sync: 10,
    warm_sync: 30,
    auto_update: true,
    update_repo: UPDATE_REPO,
    update_channel: 'releases',
  };
  await audit(s.user, 'Configuration de l’agent téléchargée', host, req); // jamais le jeton
  return { ok: true, filename: 'agent_config.json', config };
}
