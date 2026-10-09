import { redis, K } from '../../lib/redis.js';
import { requireAgent } from '../../lib/auth.js';

// Relevé rapide (toutes les 1,5 s quand le dashboard est ouvert) : commandes en file et réponses oui/non.
export default async function handler(req, res) {
  if (!requireAgent(req, res)) return;
  const r = redis();
  const waiting = req.body?.waiting ? String(req.body.waiting) : null;
  const keys = [K.qflag, K.hot];
  if (waiting) keys.push(K.answer(waiting));
  const [qflag, hot, answer] = await r.mget(...keys);
  const out = { hot: Boolean(hot), commands: [] };
  if (qflag) {
    const items = (await r.lpop(K.queue, 20)) || [];
    await r.del(K.qflag);
    out.commands = [].concat(items).map((x) => (typeof x === 'string' ? JSON.parse(x) : x));
  }
  if (answer) {
    out.answer = answer;
    await r.del(K.answer(waiting));
  }
  res.json(out);
}
