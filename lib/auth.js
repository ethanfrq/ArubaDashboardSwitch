import crypto from 'node:crypto';
import { store, K } from './db.js';
import { safeEqual, hashPassword, checkPassword } from './passwords.js';
import { loadUsers, findUser } from './users.js';

export { safeEqual, hashPassword, checkPassword };

const COOKIE = 'aruba_session';
// Administrateur et technicien : 12 h. Lecture seule : 30 jours, pour un écran de monitoring qui reste allumé.
const MAX_AGE = { admin: 12 * 3600, tech: 12 * 3600, viewer: 30 * 86400 };

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET manquant');
  return s;
};
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

// Cookie « exp.u.<compte>.<version>.signature ». La version du compte change quand on le désactive, change son mot
// de passe ou ferme ses sessions : tous ses anciens cookies cessent de marcher.
export function setSession(res, user) {
  const age = MAX_AGE[user.role] || MAX_AGE.admin;
  const exp = Math.floor(Date.now() / 1000) + age;
  const payload = `${exp}.u.${user.id}.${user.sv || 0}`;
  res.setHeader('Set-Cookie',
    `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

// Lecture du cookie seul (signature, expiration). Reconnaît aussi les cookies des versions 1.7 et avant
// (« exp » administrateur, « exp.viewer.version » lecture seule) pour ne déconnecter personne à la mise à jour.
export function readSession(req) {
  const parts = String(req.cookies?.[COOKIE] || '').split('.');
  const sig = parts.pop(), payload = parts.join('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  if (!(Number(parts[0]) > Date.now() / 1000)) return null;
  if (parts[1] === 'u' && /^[\w-]{1,32}$/.test(parts[2] || '')) return { uid: parts[2], sv: parts[3] || '0' };
  if (parts.length === 1) return { legacy: 'admin' };
  if (parts[1] === 'viewer') return { legacy: 'viewer', ver: parts[2] || '0' };
  return null;
}

// Compte correspondant au cookie, ou null. viewerRec : ancien mot de passe lecture seule (cookies 1.7).
export function resolveSession(c, doc, viewerRec) {
  if (!c) return null;
  let u = null;
  if (c.uid) {
    u = findUser(doc, c.uid);
    if (u && String(u.sv || 0) !== String(c.sv)) u = null;
  } else if (c.legacy === 'admin') {
    u = doc.users.find((x) => x.owner && !(x.sv > 0)) || null;
  } else if (c.legacy === 'viewer') {
    u = doc.users.find((x) => x.legacyV !== undefined && !(x.sv > 0)) || null;
    if (u && String(viewerRec?.v) !== String(c.ver)) u = null;
  }
  if (!u || u.disabled || u.pending) return null;
  return session(u);
}

// staff : administrateur ou technicien (agit sur le switch). need2fa : double authentification exigée mais pas
// encore activée, seules la lecture et « Mon profil » sont permises.
export function session(u) {
  return { role: u.role, user: u, uid: u.id, staff: u.role !== 'viewer', need2fa: Boolean(u.require2fa && !u.has2fa) };
}

export async function getSession(req) {
  const c = readSession(req);
  if (!c) return null;
  const { doc } = await loadUsers();
  const viewerRec = c.legacy === 'viewer' ? await store().get(K.viewer) : null;
  return resolveSession(c, doc, viewerRec);
}

// Rôle à donner aux lectures des fonctions d'administration : un technicien lit comme l'administrateur.
export const readRole = (s) => (s.staff ? 'admin' : 'viewer');

// Renvoie la session, ou répond 401 (non connecté) / 403 (droit insuffisant) et renvoie null.
// admin : administrateur seulement. staff : administrateur ou technicien. allow2fa : permis avant d'avoir activé la
// double authentification exigée.
export async function requireSession(req, res, { admin = false, staff = false, allow2fa = false } = {}) {
  const s = await getSession(req);
  if (!s) { res.status(401).json({ error: 'Non connecté' }); return null; }
  if (s.need2fa && !allow2fa && (admin || staff)) {
    res.status(403).json({ error: 'Active d’abord la double authentification dans « Mon profil ».', need2fa: true }); return null;
  }
  if (admin && s.role !== 'admin') { res.status(403).json({ error: 'Action réservée à un administrateur.' }); return null; }
  if (staff && !s.staff) { res.status(403).json({ error: 'Accès en lecture seule : aucune modification possible.' }); return null; }
  return s;
}

export function requireAgent(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const ok = process.env.AGENT_TOKEN && token && safeEqual(token, process.env.AGENT_TOKEN);
  if (!ok) res.status(401).json({ error: 'Agent non autorisé' });
  return Boolean(ok);
}
