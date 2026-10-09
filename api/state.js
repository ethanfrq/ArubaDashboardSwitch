import { redis, K } from '../lib/redis.js';
import { hasSession } from '../lib/auth.js';

// Lecture groupée en une seule commande Redis (MGET) pour rester dans l'offre gratuite.
export default async function handler(req, res) {
  // Pas de 401 ici : c'est le premier appel de la page, il sert juste à savoir s'il faut afficher la connexion.
  if (!hasSession(req)) return res.json({ auth: false });
  const r = redis();
  const [state, log, alerts, hot] = await r.mget(K.state, K.log, K.alerts, K.hot);
  // « touch » : le dashboard est ouvert, l'agent passe en mode temps réel pendant 2 min.
  if (req.query.touch || !hot) await r.set(K.hot, 1, { ex: 120 });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ now: Date.now() / 1000, state, log: log || [], alerts: alerts || [] });
}
