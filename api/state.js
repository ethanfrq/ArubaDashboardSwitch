import { store, K } from '../lib/db.js';
import { readSession } from '../lib/auth.js';
import { isAutoKind } from '../lib/readonly.js';
import { stateExtras } from '../lib/features/index.js';
import { ensureCron } from '../lib/store.js';

// Une seule lecture groupée (MGET) par rafraîchissement. Le journal des commandes, les alertes et les données
// des fonctions d'administration ne sont renvoyés que s'ils ont changé depuis la dernière lecture de la page.
// La page envoie les versions qu'elle connaît : lv (journal), av (alertes), xv=nom:version,… (extensions).
export default async function handler(req, res) {
  // Pas de 401 ici : c'est le premier appel de la page, il sert juste à savoir s'il faut afficher la connexion.
  const s = readSession(req);
  if (!s) return res.json({ auth: false });
  const admin = s.role === 'admin';
  const r = store();
  await ensureCron();
  const extras = stateExtras().filter((x) => admin || x.viewer);
  const keys = [K.state, K.hot, K.warm, K.ver(K.log), K.ver(K.alerts), ...extras.map((x) => K.ver(x.key))];
  if (!admin) keys.push(K.viewer);
  const vals = await r.mget(...keys);
  const [state, hot, warm, logv, alertsv] = vals;
  const extraV = vals.slice(5, 5 + extras.length);
  const viewer = admin ? null : vals[5 + extras.length];
  if (!admin && String(viewer?.v) !== s.ver) return res.json({ auth: false }); // mot de passe lecture seule changé
  // Dashboard administrateur ouvert (« hot ») : l'agent passe en temps réel (10 s) pendant 2 min.
  // Écran lecture seule ouvert (« warm ») : l'agent envoie toutes les 30 s.
  if (admin && (req.query.touch || !hot)) await r.set(K.hot, 1, { ex: 120 });
  if (!admin && !warm) await r.set(K.warm, 1, { ex: 120 });
  const out = { now: Date.now() / 1000, role: s.role, state, lv: String(logv ?? 0), av: String(alertsv ?? 0) };
  const known = Object.fromEntries(String(req.query.xv || '').split(',').filter(Boolean).map((x) => x.split(':')));
  const need = [[K.log, 'log', req.query.lv !== out.lv], [K.alerts, 'alerts', req.query.av !== out.av],
    ...extras.map((x, i) => [x.key, `x:${x.name}`, known[x.name] !== String(extraV[i] ?? 0), String(extraV[i] ?? 0)])].filter((x) => x[2]);
  if (need.length) {
    const got = await r.mget(...need.map((x) => x[0]));
    need.forEach(([, name, , v], i) => {
      if (name.startsWith('x:')) (out.x ||= {})[name.slice(2)] = { v, data: got[i] ?? null };
      else out[name] = got[i] || [];
    });
    // En lecture seule, le journal ne contient que les relevés automatiques (ni les commandes ni leur texte).
    if (out.log && !admin) out.log = out.log.filter((c) => isAutoKind(c.kind));
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
}
