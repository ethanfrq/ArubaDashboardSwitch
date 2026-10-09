import crypto from 'node:crypto';
import { redis, K, upsert, LOG_MAX } from '../lib/redis.js';
import { requireSession } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!requireSession(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  const r = redis();

  // Réponse à une question oui/non posée par le switch.
  if (req.body?.answer_to) {
    const answer = req.body.answer === 'y' ? 'y' : 'n';
    await r.set(K.answer(String(req.body.answer_to)), answer, { ex: 180 });
    await upsert(K.log, { id: String(req.body.answer_to), status: 'running', answer }, LOG_MAX);
    return res.json({ ok: true });
  }

  const cmd = String(req.body?.cmd ?? '').trim();
  if (!cmd) return res.status(400).json({ error: 'Commande vide.' });
  if (cmd.length > 4000) return res.status(400).json({ error: 'Commande trop longue.' });
  const rec = { id: crypto.randomUUID(), cmd, label: String(req.body?.label ?? '').slice(0, 120),
    kind: String(req.body?.kind ?? '').slice(0, 40), status: 'pending', created: Date.now() / 1000 };
  await upsert(K.log, rec, LOG_MAX);
  await r.rpush(K.queue, JSON.stringify({ id: rec.id, cmd }));
  await r.set(K.qflag, 1);
  await r.set(K.hot, 1, { ex: 120 });
  res.json(rec);
}
