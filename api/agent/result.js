import { redis, K, upsert, LOG_MAX } from '../../lib/redis.js';
import { requireAgent } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (!requireAgent(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  const { id, output, status, question } = req.body ?? {};
  if (!/^[\w-]{36}$/.test(String(id))) return res.status(400).json({ error: 'id invalide' });
  const st = ['confirm', 'done', 'error'].includes(status) ? status : 'done';
  await redis().set(K.out(id), String(output ?? '').slice(0, 60000), { ex: 3 * 86400 });
  await upsert(K.log, { id, status: st, question: st === 'confirm' ? String(question || '').slice(0, 300) : null,
    finished: st === 'confirm' ? null : Date.now() / 1000, v: Date.now() }, LOG_MAX);
  res.json({ ok: true });
}
