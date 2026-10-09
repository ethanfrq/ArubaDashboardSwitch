import { redis, K } from '../lib/redis.js';
import { readSession } from '../lib/auth.js';
import { isAutoKind } from '../lib/readonly.js';

// Une seule lecture groupée (MGET) par rafraîchissement. Le journal des commandes et les alertes, plus lourds,
// ne sont renvoyés que s'ils ont changé depuis la dernière lecture de la page (offres gratuites Upstash).
export default async function handler(req, res) {
  // Pas de 401 ici : c'est le premier appel de la page, il sert juste à savoir s'il faut afficher la connexion.
  const s = readSession(req);
  if (!s) return res.json({ auth: false });
  const admin = s.role === 'admin';
  const r = redis();
  const keys = [K.state, K.hot, K.warm, K.ver(K.log), K.ver(K.alerts)];
  if (!admin) keys.push(K.viewer);
  const [state, hot, warm, logv, alertsv, viewer] = await r.mget(...keys);
  if (!admin && String(viewer?.v) !== s.ver) return res.json({ auth: false }); // mot de passe lecture seule changé
  // Dashboard administrateur ouvert (« hot ») : l'agent passe en temps réel (10 s) pendant 2 min.
  // Écran lecture seule ouvert (« warm ») : l'agent envoie toutes les 30 s.
  if (admin && (req.query.touch || !hot)) await r.set(K.hot, 1, { ex: 120 });
  if (!admin && !warm) await r.set(K.warm, 1, { ex: 120 });
  const out = { now: Date.now() / 1000, role: s.role, state, lv: String(logv ?? 0), av: String(alertsv ?? 0) };
  const need = [[K.log, 'log', req.query.lv !== out.lv], [K.alerts, 'alerts', req.query.av !== out.av]].filter((x) => x[2]);
  if (need.length) {
    const vals = await r.mget(...need.map((x) => x[0]));
    need.forEach(([, name], i) => { out[name] = vals[i] || []; });
    // En lecture seule, le journal ne contient que les relevés automatiques (ni les commandes ni leur texte).
    if (out.log && !admin) out.log = out.log.filter((c) => isAutoKind(c.kind));
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
}
