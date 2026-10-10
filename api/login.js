import { store, K } from '../lib/db.js';
import { safeEqual, setSession, checkPassword } from '../lib/auth.js';
import { getTotp, consumeCode } from '../lib/totp.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = (req.headers['x-forwarded-for'] || 'inconnu').split(',')[0].trim();
  const r = store();
  const tries = await r.incr(K.tries(ip));
  if (tries === 1) await r.expire(K.tries(ip), 900);
  if (tries > 8) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 minutes.' });

  const expected = process.env.DASHBOARD_PASSWORD;
  // Tolère les espaces, guillemets ou accents graves copiés par erreur autour du mot de passe.
  const given = String(req.body?.password ?? '').trim().replace(/^[`'"«»\s]+|[`'"«»\s]+$/g, '');
  // Mot de passe administrateur, ou mot de passe lecture seule (écran de monitoring) s'il est défini.
  let role = null, ver = 0;
  if (expected && safeEqual(given, expected.trim())) role = 'admin';
  else {
    const viewer = given ? await r.get(K.viewer) : null;
    if (viewer && checkPassword(given, viewer)) { role = 'viewer'; ver = viewer.v; }
  }
  const left = 8 - tries, more = left <= 3 ? ` (encore ${left} essai${left > 1 ? 's' : ''} avant blocage 15 min)` : '';
  if (!role) return res.status(401).json({ error: `Mot de passe incorrect${more}.` });
  // Double authentification de l'administrateur : le mot de passe seul ne suffit pas.
  if (role === 'admin') {
    const totp = await getTotp();
    if (totp) {
      const code = String(req.body?.code ?? '').trim();
      if (!code) return res.json({ totp: true }); // la page demande alors le code (le mot de passe est juste)
      const how = await consumeCode(totp, code);
      if (!how) return res.status(401).json({ totp: true, error: `Code incorrect${more}.` });
      if (how === 'recovery') res.setHeader('X-Recovery-Used', '1');
    }
  }
  await r.del(K.tries(ip));
  setSession(res, role, ver);
  res.json({ ok: true, role, recoveryUsed: res.getHeader('X-Recovery-Used') === '1' });
}
