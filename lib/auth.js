import crypto from 'node:crypto';

const COOKIE = 'aruba_session';
const MAX_AGE = 12 * 3600;

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

export function setSession(res) {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export function hasSession(req) {
  const raw = req.cookies?.[COOKIE] || '';
  const [exp, sig] = raw.split('.');
  return Boolean(exp && sig && safeEqual(sig, sign(exp)) && Number(exp) > Date.now() / 1000);
}

// Renvoie true si la requête porte une session valide, sinon répond 401.
export function requireSession(req, res) {
  const ok = hasSession(req);
  if (!ok) res.status(401).json({ error: 'Non connecté' });
  return ok;
}

export function requireAgent(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const ok = process.env.AGENT_TOKEN && token && safeEqual(token, process.env.AGENT_TOKEN);
  if (!ok) res.status(401).json({ error: 'Agent non autorisé' });
  return Boolean(ok);
}
