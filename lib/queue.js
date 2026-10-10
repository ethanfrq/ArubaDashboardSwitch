import crypto from 'node:crypto';
import { store, K, upsert, LOG_MAX } from './db.js';

// Met une commande en file pour l'agent et l'inscrit au journal (commande du dashboard, action planifiée…).
export async function enqueue({ cmd, label = '', kind = '', meta = null, id = crypto.randomUUID(), realtime = false }) {
  const r = store();
  const rec = { id, cmd, label: String(label).slice(0, 120), kind: String(kind).slice(0, 40), status: 'pending', created: Date.now() / 1000 };
  if (meta) rec.meta = meta;
  await upsert(K.log, rec, LOG_MAX);
  await r.rpush(K.queue, JSON.stringify({ id: rec.id, cmd }));
  await r.set(K.qflag, 1);
  if (realtime) { // l'agent relève les commandes en temps réel, et très vite pendant 90 s
    await r.set(K.hot, 1, { ex: 120 });
    await r.set(K.busy, 1, { ex: 90 });
  }
  return rec;
}
