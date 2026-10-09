import { redis, K, HIST, getSettings } from '../../lib/redis.js';
import { requireAgent } from '../../lib/auth.js';
import { notify } from '../../lib/notify.js';

// L'agent envoie l'état du switch ; on lui renvoie les commandes, les réglages et le mode (temps réel ou non).
export default async function handler(req, res) {
  if (!requireAgent(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  const { state, samples = {}, events = [], sver = null } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state manquant' });

  const r = redis();
  state.received = Date.now() / 1000;
  const [, [hot, qflag, curVer, offline]] = await Promise.all([
    r.set(K.state, state),
    r.mget(K.hot, K.qflag, K.sver, K.offline),
  ]);
  const out = { hot: Boolean(hot), commands: [] };

  if (qflag) {
    const items = (await r.lpop(K.queue, 20)) || [];
    await r.del(K.qflag);
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
  if (evs.length) {
    const settings = out.settings || (await getSettings());
    const allowed = evs.filter((e) => e.type !== 'agent_online' || settings.notify.agentOffline);
    if (allowed.length) await notify(allowed, settings, { host: state.hostname });
  }
  res.json(out);
}
