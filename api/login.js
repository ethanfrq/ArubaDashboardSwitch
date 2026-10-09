import { redis, K } from '../lib/redis.js';
import { safeEqual, setSession, checkPassword } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = (req.headers['x-forwarded-for'] || 'inconnu').split(',')[0].trim();
  const r = redis();
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
  if (!role) {
    const left = 8 - tries;
    return res.status(401).json({ error: `Mot de passe incorrect${left <= 3 ? ` (encore ${left} essai${left > 1 ? 's' : ''} avant blocage 15 min)` : ''}.` });
  }
  await r.del(K.tries(ip));
  setSession(res, role, ver);
  res.json({ ok: true, role });
}
