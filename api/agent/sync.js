import { redis, K, HIST, getSettings } from '../../lib/redis.js';
import { requireAgent } from '../../lib/auth.js';
import { notify } from '../../lib/notify.js';
import { run, syncKeys } from '../../lib/features/index.js';
import * as backup from '../../lib/features/backup.js';

// L'agent envoie l'état du switch ; on lui renvoie les commandes, les réglages et le mode (temps réel ou non).
export default async function handler(req, res) {
  if (!requireAgent(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  const { state, samples = {}, events = [], sver = null, diag = null } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state manquant' });

  const r = redis();
  state.received = Date.now() / 1000;
  const writes = [r.set(K.state, state)];
  // Relevé détaillé : l'agent ne l'envoie que lorsqu'il a changé (ou toutes les 10 min).
  if (diag && typeof diag.out === 'string') {
    // la section « checkpoint diff » peut montrer un mot de passe ou une clé modifiés : masqués comme les sauvegardes
    writes.push(r.set(K.diag, { h: String(diag.h || '').slice(0, 40), t: Number(diag.t) || 0, out: (typeof backup.maskOutput === 'function' ? backup.maskOutput(diag.out) : diag.out).slice(0, 60000) }));
  }
  const extra = syncKeys(); // clés lues pour les fonctions d'administration, dans la même commande
  const [[hot, qflag, curVer, offline, warm, ...extraVals]] = await Promise.all([r.mget(K.hot, K.qflag, K.sver, K.offline, K.warm, ...extra), ...writes]);
  const out = { hot: Boolean(hot), warm: Boolean(warm), commands: [] };

  if (qflag) {
    // drapeau effacé avant de vider la file : une commande mise en file pendant le relevé le repose elle-même
    await r.del(K.qflag);
    const items = (await r.lpop(K.queue, 20)) || [];
    if ([].concat(items).length === 20) await r.set(K.qflag, 1); // il en reste peut-être
    out.commands = [].concat(items).map((x) => (typeof x === 'string' ? JSON.parse(x) : x));
  }
  if (String(curVer ?? 0) !== String(sver ?? '')) {
    out.settings = await getSettings();
    out.sver = String(curVer ?? 0);
  }
  for (const [range, rows] of Object.entries(samples)) {
    if (!HIST[range] || !Array.isArray(rows) || !rows.length) continue;
    await r.rpush(K.hist(range), ...rows.map((x) => JSON.stringify(x)));
    await r.ltrim(K.hist(range), -HIST[range], -1);
  }

  const evs = Array.isArray(events) ? events.slice(0, 50) : [];
  if (offline) {
    await r.del(K.offline);
    evs.push({ type: 'agent_online', level: 'ok', text: `L'agent est de nouveau en ligne (${state.agent?.host || 'PC'}).` });
  }
  let settingsP = null;
  const settings = () => (settingsP ||= out.settings ? Promise.resolve(out.settings) : getSettings());
  await run('onSync', { r, state, vals: Object.fromEntries(extra.map((k, i) => [k, extraVals[i]])), events: evs, settings });
  if (evs.length) {
    const st = await settings();
    const allowed = evs.filter((e) => e.type !== 'agent_online' || st.notify.agentOffline);
    if (allowed.length) await notify(allowed, st, { host: state.hostname });
  }
  res.json(out);
}
