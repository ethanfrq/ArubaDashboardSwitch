import crypto from 'node:crypto';
import { redis, K } from './redis.js';

const COOKIE = 'aruba_session';
// Administrateur : 12 h. Lecture seule : 30 jours, pour un écran de monitoring qui reste allumé.
const MAX_AGE = { admin: 12 * 3600, viewer: 30 * 86400 };

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET manquant');
  return s;
};
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Mot de passe lecture seule : stocké haché (scrypt + sel), jamais en clair.
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
export function checkPassword(pw, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw), rec.salt, 32), Buffer.from(rec.hash, 'hex'));
}

// Cookie : « exp.signature » (administrateur) ou « exp.viewer.version.signature » (lecture seule).
// La version change à chaque nouveau mot de passe lecture seule : les anciens écrans sont déconnectés.
export function setSession(res, role = 'admin', ver = 0) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE[role];
  const payload = role === 'viewer' ? `${exp}.viewer.${ver}` : String(exp);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE[role]}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

// Renvoie { role: 'admin' | 'viewer' } si la session est valide, sinon null.
export async function getSession(req) {
  const parts = String(req.cookies?.[COOKIE] || '').split('.');
  const sig = parts.pop(), payload = parts.join('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  const [exp, role = 'admin', ver = '0'] = parts;
  if (!(Number(exp) > Date.now() / 1000)) return null;
  if (role === 'admin') return { role };
  if (role !== 'viewer') return null;
  const rec = await redis().get(K.viewer);
  return rec && String(rec.v) === ver ? { role } : null;
}

// Renvoie la session, ou répond 401 (non connecté) / 403 (action réservée à l'administrateur) et renvoie null.
export async function requireSession(req, res, { admin = false } = {}) {
  const s = await getSession(req);
  if (!s) { res.status(401).json({ error: 'Non connecté' }); return null; }
  if (admin && s.role !== 'admin') { res.status(403).json({ error: 'Accès en lecture seule : action réservée à l’administrateur.' }); return null; }
  return s;
}

export function requireAgent(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const ok = process.env.AGENT_TOKEN && token && safeEqual(token, process.env.AGENT_TOKEN);
  if (!ok) res.status(401).json({ error: 'Agent non autorisé' });
  return Boolean(ok);
}
