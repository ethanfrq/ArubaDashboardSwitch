import { store, K } from '../lib/db.js';
import { readSession, resolveSession } from '../lib/auth.js';
import { isAutoKind } from '../lib/readonly.js';
import { stateExtras } from '../lib/features/index.js';
import { ensureCron } from '../lib/store.js';
import { USERS, SEEN, publicUser, shortAgent, loadUsers } from '../lib/users.js';
import { publicSetup, cachedSetup } from '../lib/setup.js';

export default async function handler(req, res) {
  // Pas de 401 ici : c'est le premier appel de la page, il sert juste à savoir s'il faut afficher la connexion, ou
  // ce qu'il manque à l'installation (base, variables Vercel : noms seulement, jamais une valeur).
  res.setHeader('Cache-Control', 'no-store');
  const loggedOut = async () => res.json({ auth: false, setup: await cachedSetup() });
  const c = readSession(req);
  if (!c) return loggedOut();
  try {
    return await withSession(req, res, c, loggedOut);
  } catch (e) {
    // Base absente ou injoignable : la session ne peut pas être vérifiée, la page montre l'installation à terminer.
    // Relu sans la mémoire de cachedSetup : la base vient peut-être de tomber.
    const setup = await publicSetup();
    if (!setup.db) return res.json({ auth: false, setup });
    console.error('state', e);
    return res.status(500).json({ error: 'Erreur interne.' });
  }
}

// Une seule lecture groupée (MGET) par rafraîchissement. Le journal des commandes, les alertes et les données
// des fonctions d'administration ne sont renvoyés que s'ils ont changé depuis la dernière lecture de la page.
// La page envoie les versions qu'elle connaît : lv (journal), av (alertes), xv=nom:version,… (extensions).
async function withSession(req, res, c, loggedOut) {
  const r = store();
  await ensureCron();
  const keys = [K.state, K.hot, K.warm, K.ver(K.log), K.ver(K.alerts), USERS, K.viewer];
  // Les données des extensions sont demandées pour un compte qui agit (administrateur ou technicien) ; un écran
  // lecture seule n'a droit qu'à celles marquées « viewer ».
  const all = stateExtras();
  const vals = await r.mget(...keys, ...all.map((x) => K.ver(x.key)));
  const [state, hot, warm, logv, alertsv, usersDoc, viewerRec] = vals;
  const doc = usersDoc?.users?.length ? usersDoc : (await loadUsers()).doc; // premier lancement : comptes créés
  const s = resolveSession(c, doc, viewerRec);
  if (!s) return loggedOut(); // compte désactivé, mot de passe changé, sessions fermées
  const staff = s.staff;
  const extras = all.map((x, i) => ({ ...x, v: vals[keys.length + i] })).filter((x) => staff || x.viewer);
  // Dashboard d'un administrateur ou technicien ouvert (« hot ») : l'agent passe en temps réel (10 s) pendant 2 min.
  // Écran lecture seule ouvert (« warm ») : l'agent envoie toutes les 30 s.
  if (staff && (req.query.touch || !hot)) await r.set(K.hot, 1, { ex: 120 });
  if (!staff && !warm) await r.set(K.warm, 1, { ex: 120 });
  if (req.query.touch) await r.set(SEEN(s.uid), { t: Math.round(Date.now() / 1000), ua: shortAgent(req.headers['user-agent']) }, { ex: 180 });
  const out = { now: Date.now() / 1000, role: s.role, me: publicUser(s.user), need2fa: s.need2fa, state, lv: String(logv ?? 0), av: String(alertsv ?? 0) };
  const known = Object.fromEntries(String(req.query.xv || '').split(',').filter(Boolean).map((x) => x.split(':')));
  const need = [[K.log, 'log', req.query.lv !== out.lv], [K.alerts, 'alerts', req.query.av !== out.av],
    ...extras.map((x) => [x.key, `x:${x.name}`, known[x.name] !== String(x.v ?? 0), String(x.v ?? 0)])].filter((x) => x[2]);
  if (need.length) {
    const got = await r.mget(...need.map((x) => x[0]));
    need.forEach(([, name, , v], i) => {
      if (name.startsWith('x:')) (out.x ||= {})[name.slice(2)] = { v, data: got[i] ?? null };
      else out[name] = got[i] || [];
    });
    // En lecture seule, le journal ne contient que les relevés automatiques (ni les commandes ni leur texte).
    if (out.log && !staff) out.log = out.log.filter((cmd) => isAutoKind(cmd.kind));
  }
  res.json(out);
}
