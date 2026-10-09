import { redis, K } from '../lib/redis.js';
import { requireSession } from '../lib/auth.js';
import { isAutoKind, redactOutput } from '../lib/readonly.js';

export default async function handler(req, res) {
  const s = await requireSession(req, res);
  if (!s) return;
  const r = redis();
  // Relevé détaillé envoyé par l'agent (liens des ports, spanning-tree, journal du switch…).
  if (req.query.diag) {
    const d = await r.get(K.diag);
    return res.json({ diag: d && s.role !== 'admin' ? { ...d, out: redactOutput(d.out) } : d });
  }
  let ids = String(req.query.ids || '').split(',').filter((x) => /^[\w-]{36}$/.test(x)).slice(0, 80);
  // Lecture seule : uniquement les sorties des relevés automatiques.
  if (s.role !== 'admin') {
    const auto = new Set(((await r.get(K.log)) || []).filter((c) => isAutoKind(c.kind)).map((c) => c.id));
    ids = ids.filter((id) => auto.has(id));
  }
  if (!ids.length) return res.json({});
  const outs = await r.mget(...ids.map(K.out));
  res.json(Object.fromEntries(ids.map((id, i) => [id, s.role === 'admin' ? outs[i] : redactOutput(outs[i])])));
}
