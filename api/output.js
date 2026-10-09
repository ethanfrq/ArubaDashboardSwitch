import { redis, K } from '../lib/redis.js';
import { requireSession } from '../lib/auth.js';
import { isAutoKind, redactOutput } from '../lib/readonly.js';

export default async function handler(req, res) {
  const s = await requireSession(req, res);
  if (!s) return;
  let ids = String(req.query.ids || '').split(',').filter((x) => /^[\w-]{36}$/.test(x)).slice(0, 80);
  const r = redis();
  // Lecture seule : uniquement les sorties des relevés automatiques.
  if (s.role !== 'admin') {
    const auto = new Set(((await r.get(K.log)) || []).filter((c) => isAutoKind(c.kind)).map((c) => c.id));
    ids = ids.filter((id) => auto.has(id));
  }
  if (!ids.length) return res.json({});
  const outs = await r.mget(...ids.map(K.out));
  res.json(Object.fromEntries(ids.map((id, i) => [id, s.role === 'admin' ? outs[i] : redactOutput(outs[i])])));
}
