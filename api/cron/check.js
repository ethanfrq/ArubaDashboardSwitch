import { Receiver } from '@upstash/qstash';
import { redis, K, mergeSettings } from '../../lib/redis.js';
import { notify } from '../../lib/notify.js';
import { enqueue } from '../../lib/queue.js';
import { run, cronKeys } from '../../lib/features/index.js';

const OFFLINE_AFTER = 300; // s sans nouvelles de l'agent

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Appelé toutes les 5 min par une planification QStash : détecte un agent arrêté, puis laisse les fonctions
// d'administration faire leur travail périodique (actions planifiées, sauvegardes de configuration…).
export default async function handler(req, res) {
  const receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  });
  try {
    await receiver.verify({ signature: req.headers['upstash-signature'] || '', body: await rawBody(req) });
  } catch {
    return res.status(401).json({ error: 'Signature QStash invalide' });
  }
  const r = redis();
  const extra = cronKeys();
  const [state, offline, rawSettings, ...extraVals] = await r.mget(K.state, K.offline, K.settings, ...extra);
  const settings = mergeSettings(rawSettings);
  const age = state?.received ? Date.now() / 1000 - state.received : Infinity;
  if (age > OFFLINE_AFTER && !offline && state) {
    await r.set(K.offline, 1);
    if (settings.notify.agentOffline) {
      await notify([{ type: 'agent_offline', level: 'critical',
        text: `L'agent ne répond plus depuis ${Math.round(age / 60)} min : le dashboard ne reçoit plus les données du switch (PC éteint, réseau ou switch injoignable).` }], settings, { host: state.hostname });
    }
  }
  const events = [];
  await run('onCron', { r, now: Date.now() / 1000, state, settings, vals: Object.fromEntries(extra.map((k, i) => [k, extraVals[i]])), events, enqueue });
  if (events.length) await notify(events, settings, { host: state?.hostname });
  res.json({ ok: true, age: Math.round(age) });
}
