import { redis, K } from '../lib/redis.js';
import { safeEqual, setSession } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = (req.headers['x-forwarded-for'] || 'inconnu').split(',')[0].trim();
  const r = redis();
  const tries = await r.incr(K.tries(ip));
  if (tries === 1) await r.expire(K.tries(ip), 900);
  if (tries > 8) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 minutes.' });

  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected || !safeEqual(req.body?.password ?? '', expected)) {
    const left = 8 - tries;
    return res.status(401).json({ error: `Mot de passe incorrect${left <= 3 ? ` (encore ${left} essai${left > 1 ? 's' : ''} avant blocage 15 min)` : ''}.` });
  }
  await r.del(K.tries(ip));
  setSession(res);
  res.json({ ok: true });
}
