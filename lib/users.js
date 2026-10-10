import crypto from 'node:crypto';
import { store, K } from './db.js';
import { hashPassword, checkPassword, safeEqual } from './passwords.js';

// Comptes utilisateurs, rangés dans une seule valeur (mam:users), écrite de façon atomique (version + écriture
// conditionnelle) : { users: [...], invites: [...] }.
//   user   { id, name, login, email, role, pw: {salt, hash} | null, owner?, pending?, disabled?, require2fa?, has2fa?,
//            sv (version de session : +1 déconnecte toutes ses sessions), created, pwT, lastLogin: {t, ua}, prefs }
//   invite { id, hash (SHA-256 du jeton du lien), kind: 'invite' | 'reset', userId, exp, by, t }
// Premier lancement : le compte « admin » (propriétaire) utilise le mot de passe DASHBOARD_PASSWORD de Vercel, et
// l'ancien mot de passe lecture seule devient le compte « ecran ».
export const USERS = 'mam:users';
export const AUDIT = 'mam:audit';
export const SEEN = (id) => `mam:seen:${id}`;
export const ROLES = ['admin', 'tech', 'viewer'];
export const ROLE_LABEL = { admin: 'Administrateur', tech: 'Technicien', viewer: 'Lecture seule' };
const MAX_USERS = 50, INVITE_TTL = 48 * 3600;
export const PW_MIN = 10;

const now = () => Math.round(Date.now() / 1000);
export const normLogin = (s) => String(s ?? '').normalize('NFC').trim().toLowerCase();
const LOGIN_RE = /^[a-z0-9][a-z0-9._@+-]{1,63}$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const cleanText = (s, max) => String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const fail = (msg, status = 400, data) => Object.assign(new Error(msg), { status, expose: true, data });

// ---------------------------------------------------------------- lecture et écriture
let bootstrapped = false;
export async function loadUsers() {
  const r = store();
  const [doc, ver] = await r.mget(USERS, K.ver(USERS));
  if (doc?.users?.length) return { doc: normalize(doc), ver: Number(ver) || 0 };
  return bootstrap();
}

function normalize(doc) {
  return { users: Array.isArray(doc.users) ? doc.users : [], invites: (Array.isArray(doc.invites) ? doc.invites : []).filter((i) => i.exp > now()) };
}

async function bootstrap() {
  const r = store();
  const [viewer, oldTotp] = await r.mget(K.viewer, 'mam:totp');
  const t = now();
  const users = [{ id: 'owner', name: 'Administrateur', login: 'admin', email: '', role: 'admin', owner: true, pw: null, sv: 0,
    created: t, has2fa: Boolean(oldTotp?.secret), prefs: { alerts: false } }];
  if (viewer?.salt) {
    users.push({ id: 'ecran', name: 'Écran lecture seule', login: 'ecran', email: '', role: 'viewer', pw: { salt: viewer.salt, hash: viewer.hash },
      legacyV: viewer.v, sv: 0, created: t, prefs: { alerts: false } });
  }
  if (oldTotp?.secret && !bootstrapped) await r.set('mam:totp:owner', oldTotp); // double authentification déjà active
  bootstrapped = true;
  const doc = { users, invites: [] };
  const v = Number(await r.casJSON(USERS, JSON.stringify(doc), 0));
  if (v === -1) { const [d, ver] = await r.mget(USERS, K.ver(USERS)); return { doc: normalize(d), ver: Number(ver) || 0 }; }
  return { doc, ver: v };
}

// Modifie les comptes avec fn(doc) (qui renvoie un résultat), sans perdre une modification faite en même temps.
export async function updateUsers(fn) {
  const r = store();
  for (let i = 0; i < 6; i++) {
    const { doc, ver } = await loadUsers();
    const next = structuredClone(doc);
    const out = await fn(next);
    if (Number(await r.casJSON(USERS, JSON.stringify(next), ver)) !== -1) return out;
  }
  throw fail('Trop de modifications simultanées, réessaie.', 409);
}

export const findUser = (doc, id) => doc.users.find((u) => u.id === id) || null;
export const activeAdmins = (doc) => doc.users.filter((u) => u.role === 'admin' && !u.disabled && !u.pending);

// Ce que la page reçoit d'un compte : jamais le mot de passe haché ni les secrets.
export function publicUser(u, extra = {}) {
  return { id: u.id, name: u.name, login: u.login, email: u.email || '', role: u.role, owner: Boolean(u.owner), pending: Boolean(u.pending),
    disabled: Boolean(u.disabled), require2fa: Boolean(u.require2fa), has2fa: Boolean(u.has2fa), created: u.created || null,
    lastLogin: u.lastLogin || null, ownPassword: Boolean(u.pw), prefs: { alerts: Boolean(u.prefs?.alerts) }, ...extra };
}

// ---------------------------------------------------------------- connexion
const DUMMY = hashPassword('mot-de-passe-factice-pour-temps-constant');
const envPassword = () => String(process.env.DASHBOARD_PASSWORD || '').trim();

// Vérifie identifiant + mot de passe. Identifiant vide : ancien formulaire (mot de passe administrateur de Vercel
// ou ancien mot de passe lecture seule). Renvoie le compte ou null.
export function checkLogin(doc, login, password) {
  const pw = String(password ?? '');
  const id = normLogin(login);
  const candidates = id
    ? doc.users.filter((u) => u.login === id || (u.email && u.email.toLowerCase() === id))
    : doc.users.filter((u) => u.owner || u.legacyV !== undefined);
  let found = null;
  for (const u of candidates) {
    if (u.disabled || u.pending) continue;
    const env = envPassword();
    if (u.owner && env && safeEqual(pw.trim(), env)) { found = u; break; }
    if (u.pw && checkPassword(pw, u.pw)) { found = u; break; }
  }
  if (!candidates.length) checkPassword(pw, DUMMY); // même durée de réponse qu'un identifiant existant
  return found;
}

export function shortAgent(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iPhone ou iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux|CrOS/.test(s) ? 'Linux' : 'Appareil inconnu';
  const br = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

// ---------------------------------------------------------------- journal d'activité
export async function audit(who, action, detail = '', req = null) {
  try {
    const r = store();
    await r.rpush(AUDIT, { t: Date.now() / 1000, uid: who?.id || null, who: who?.name || who?.login || 'inconnu', action: cleanText(action, 80), detail: cleanText(detail, 200),
      ua: req ? shortAgent(req.headers['user-agent']) : '' });
    if (Math.random() < 0.05) await r.ltrim(AUDIT, -1000, -1);
  } catch (e) { console.error('audit', e); }
}

// ---------------------------------------------------------------- liens d'invitation et de réinitialisation
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function newLink(doc, kind, userId, by) {
  doc.invites = doc.invites.filter((i) => i.userId !== userId); // un seul lien valable par compte
  const token = crypto.randomBytes(32).toString('base64url');
  doc.invites.push({ id: crypto.randomUUID(), hash: tokenHash(token), kind, userId, exp: now() + INVITE_TTL, by, t: now() });
  return token;
}
export function findInvite(doc, token) {
  if (!/^[\w-]{40,60}$/.test(String(token || ''))) return null;
  const h = tokenHash(token);
  const inv = doc.invites.find((i) => i.exp > now() && safeEqual(i.hash, h));
  const user = inv && findUser(doc, inv.userId);
  return inv && user && !user.disabled ? { inv, user } : null;
}
export function linkUrl(req, token) {
  const base = process.env.DASHBOARD_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host}`;
  return `${base.replace(/\/$/, '')}/?invite=${token}`;
}

export function checkNewPassword(pw, user) {
  const p = String(pw ?? '');
  if (p.length < PW_MIN) throw fail(`Le mot de passe doit faire au moins ${PW_MIN} caractères.`);
  if (p.length > 200) throw fail('Mot de passe trop long.');
  if (user && (normLogin(p) === user.login || (user.email && normLogin(p) === user.email.toLowerCase()))) throw fail('Le mot de passe ne doit pas être ton identifiant.');
  return p;
}

// ---------------------------------------------------------------- gestion des comptes (administrateur)
function validLogin(doc, login, selfId = null) {
  const l = normLogin(login);
  if (!LOGIN_RE.test(l)) throw fail('Identifiant invalide : lettres, chiffres, point, tiret ou une adresse e-mail (2 caractères au moins).');
  if (doc.users.some((u) => u.id !== selfId && (u.login === l || (u.email && u.email.toLowerCase() === l)))) throw fail('Cet identifiant est déjà utilisé.');
  return l;
}
function validRole(role) {
  if (!ROLES.includes(role)) throw fail('Rôle inconnu.');
  return role;
}
function target(doc, id, me, { notSelf = false } = {}) {
  const u = findUser(doc, String(id || ''));
  if (!u) throw fail('Utilisateur introuvable.', 404);
  if (notSelf && u.id === me.id) throw fail('Utilise « Mon profil » pour ton propre compte.');
  return u;
}

export async function userAction(action, b, me, req) {
  const r = store();
  if (action === 'user-create') {
    const res = await updateUsers((doc) => {
      if (doc.users.length >= MAX_USERS) throw fail(`${MAX_USERS} comptes au plus.`);
      const name = cleanText(b.name, 60);
      if (!name) throw fail('Indique un nom.');
      const login = validLogin(doc, b.login);
      const role = validRole(String(b.role));
      const u = { id: crypto.randomBytes(6).toString('hex'), name, login, email: EMAIL_RE.test(login) ? login : '', role, pw: null, sv: 0,
        created: now(), require2fa: role !== 'viewer' && Boolean(b.require2fa), prefs: { alerts: false } };
      let token = null;
      if (b.mode === 'password') { u.pw = hashPassword(checkNewPassword(b.password, u)); u.pwT = now(); }
      else { u.pending = true; token = newLink(doc, 'invite', u.id, me.id); }
      doc.users.push(u);
      return { u, token };
    });
    await audit(me, res.token ? 'Utilisateur invité' : 'Utilisateur créé', `${res.u.name} (${res.u.login}), ${ROLE_LABEL[res.u.role]}`, req);
    const link = res.token ? linkUrl(req, res.token) : null;
    const mailed = link && res.u.email ? await sendLinkMail(res.u, link, 'invite', me).catch(() => false) : false;
    return { ok: true, user: publicUser(res.u), link, mailed };
  }

  if (action === 'user-update') {
    const u = await updateUsers((doc) => {
      const t = target(doc, b.id, me);
      if (b.name !== undefined) { const n = cleanText(b.name, 60); if (!n) throw fail('Indique un nom.'); t.name = n; }
      if (b.login !== undefined && normLogin(b.login) !== t.login) {
        if (t.owner) throw fail('L’identifiant du compte principal reste « admin ».');
        t.login = validLogin(doc, b.login, t.id);
        if (EMAIL_RE.test(t.login)) t.email = t.login;
      }
      if (b.role !== undefined && b.role !== t.role) {
        if (t.owner) throw fail('Le compte principal reste administrateur.');
        if (t.id === me.id) throw fail('Tu ne peux pas changer ton propre rôle.');
        t.role = validRole(String(b.role));
        if (t.role === 'viewer') t.require2fa = false;
      }
      if (b.require2fa !== undefined) t.require2fa = t.role !== 'viewer' && Boolean(b.require2fa);
      return t;
    });
    await audit(me, 'Utilisateur modifié', `${u.name} : ${ROLE_LABEL[u.role]}${u.require2fa ? ', double authentification exigée' : ''}`, req);
    return { ok: true, user: publicUser(u) };
  }

  if (action === 'user-disable' || action === 'user-enable') {
    const off = action === 'user-disable';
    const u = await updateUsers((doc) => {
      const t = target(doc, b.id, me, { notSelf: true });
      if (off && t.owner) throw fail('Le compte principal ne peut pas être désactivé.');
      t.disabled = off;
      if (off) t.sv = (t.sv || 0) + 1; // déconnecté partout tout de suite
      return t;
    });
    await audit(me, off ? 'Compte désactivé' : 'Compte réactivé', u.name, req);
    return { ok: true, user: publicUser(u) };
  }

  if (action === 'user-delete') {
    const u = await updateUsers((doc) => {
      const t = target(doc, b.id, me, { notSelf: true });
      if (t.owner) throw fail('Le compte principal ne peut pas être supprimé.');
      doc.users = doc.users.filter((x) => x.id !== t.id);
      doc.invites = doc.invites.filter((i) => i.userId !== t.id);
      return t;
    });
    await r.del(`mam:totp:${u.id}`, `mam:totp:pending:${u.id}`, SEEN(u.id));
    await audit(me, 'Utilisateur supprimé', `${u.name} (${u.login})`, req);
    return { ok: true };
  }

  if (action === 'user-reset-link') {
    const res = await updateUsers((doc) => {
      const t = target(doc, b.id, me, { notSelf: true });
      if (t.disabled) throw fail('Réactive d’abord ce compte.');
      return { t, token: newLink(doc, t.pending ? 'invite' : 'reset', t.id, me.id) };
    });
    const link = linkUrl(req, res.token);
    const mailed = res.t.email ? await sendLinkMail(res.t, link, res.t.pending ? 'invite' : 'reset', me).catch(() => false) : false;
    await audit(me, res.t.pending ? 'Invitation renvoyée' : 'Lien de nouveau mot de passe créé', res.t.name, req);
    return { ok: true, link, mailed };
  }

  if (action === 'user-2fa-reset') {
    const u = await updateUsers((doc) => {
      const t = target(doc, b.id, me, { notSelf: true });
      t.has2fa = false; t.sv = (t.sv || 0) + 1;
      return t;
    });
    await r.del(`mam:totp:${u.id}`, `mam:totp:pending:${u.id}`);
    await audit(me, 'Double authentification réinitialisée', u.name, req);
    return { ok: true, user: publicUser(u) };
  }

  if (action === 'user-logout') {
    const u = await updateUsers((doc) => { const t = target(doc, b.id, me, { notSelf: true }); t.sv = (t.sv || 0) + 1; return t; });
    await audit(me, 'Sessions fermées', u.name, req);
    return { ok: true };
  }
  throw fail('Action inconnue.');
}

// ---------------------------------------------------------------- e-mail du lien (si Resend est configuré)
async function sendLinkMail(user, link, kind, by) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !user.email) return false;
  const subject = kind === 'invite' ? 'Invitation à My Aruba Manager' : 'Nouveau mot de passe pour My Aruba Manager';
  const text = kind === 'invite'
    ? `Bonjour ${user.name},\n\n${by.name} t’a créé un compte sur My Aruba Manager (${ROLE_LABEL[user.role]}).\nChoisis ton mot de passe avec ce lien, valable 48 h :\n\n${link}\n\nIdentifiant : ${user.login}\n`
    : `Bonjour ${user.name},\n\n${by.name} t’a envoyé un lien pour choisir un nouveau mot de passe, valable 48 h :\n\n${link}\n\nSi tu n’as rien demandé, ignore ce message.\n`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.ALERT_FROM || 'My Aruba Manager <onboarding@resend.dev>', to: [user.email], subject, text }),
  });
  return res.ok;
}
