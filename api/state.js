import { redis, K } from '../lib/redis.js';
import { getSession } from '../lib/auth.js';
import { isAutoKind } from '../lib/readonly.js';

// Lecture groupée en une seule commande Redis (MGET) pour rester dans l'offre gratuite.
export default async function handler(req, res) {
  // Pas de 401 ici : c'est le premier appel de la page, il sert juste à savoir s'il faut afficher la connexion.
  const s = await getSession(req);
  if (!s) return res.json({ auth: false });
  const r = redis();
  const [state, log, alerts, hot] = await r.mget(K.state, K.log, K.alerts, K.hot);
  const admin = s.role === 'admin';
  // « touch » : le dashboard est ouvert, l'agent passe en mode temps réel pendant 2 min.
  // Un écran lecture seule, souvent allumé en permanence, ne le fait pas : l'agent reste à 60 s (offres gratuites).
  if (admin && (req.query.touch || !hot)) await r.set(K.hot, 1, { ex: 120 });
  res.setHeader('Cache-Control', 'no-store');
  // En lecture seule, le journal ne contient que les relevés automatiques (ni les commandes ni leur texte).
  res.json({ now: Date.now() / 1000, role: s.role, state, log: (log || []).filter((c) => admin || isAutoKind(c.kind)), alerts: alerts || [] });
}
