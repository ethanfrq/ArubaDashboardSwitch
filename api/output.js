import { redis, K } from '../lib/redis.js';
import { requireSession } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!requireSession(req, res)) return;
  const ids = String(req.query.ids || '').split(',').filter((x) => /^[\w-]{36}$/.test(x)).slice(0, 80);
  if (!ids.length) return res.json({});
  const outs = await redis().mget(...ids.map(K.out));
  res.json(Object.fromEntries(ids.map((id, i) => [id, outs[i]])));
}
