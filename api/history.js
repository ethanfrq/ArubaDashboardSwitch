import { redis, K } from '../lib/redis.js';
import { requireSession } from '../lib/auth.js';

const RANGES = { '1h': ['m5', 3600], '24h': ['m5', 86400], '7d': ['m30', 7 * 86400], '30d': ['h2', 31 * 86400] };

// Points [t, entrant, sortant] (b/s) pour le total ou pour un port.
export default async function handler(req, res) {
  if (!requireSession(req, res)) return;
  const [key, span] = RANGES[req.query.range] || RANGES['24h'];
  const port = Number(String(req.query.port || '').split('/').pop()) || 0;
  const rows = await redis().lrange(K.hist(key), 0, -1);
  const since = Date.now() / 1000 - span;
  const pts = rows.map((x) => (typeof x === 'string' ? JSON.parse(x) : x)).filter((x) => x[0] >= since)
    .map((x) => (port ? [x[0], x[1 + 2 * port] ?? 0, x[2 + 2 * port] ?? 0] : [x[0], x[1], x[2]]));
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.json({ range: req.query.range || '24h', port: port || null, points: pts });
}
