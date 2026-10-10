import { redis, K } from '../../lib/redis.js';
import { requireAgent } from '../../lib/auth.js';

// Relevé rapide des commandes quand le dashboard est ouvert (1,5 s juste après une commande, sinon 5 s)
// et des réponses oui/non.
export default async function handler(req, res) {
  if (!requireAgent(req, res)) return;
  const r = redis();
  const waiting = req.body?.waiting ? String(req.body.waiting) : null;
  const keys = [K.qflag, K.hot, K.busy];
  if (waiting) keys.push(K.answer(waiting));
  const [qflag, hot, busy, answer] = await r.mget(...keys);
  const out = { hot: Boolean(hot), busy: Boolean(busy), commands: [] };
  if (qflag) {
    // drapeau effacé avant de vider la file : une commande mise en file pendant le relevé le repose elle-même
    await r.del(K.qflag);
    const items = (await r.lpop(K.queue, 20)) || [];
    if ([].concat(items).length === 20) await r.set(K.qflag, 1); // il en reste peut-être
    out.commands = [].concat(items).map((x) => (typeof x === 'string' ? JSON.parse(x) : x));
  }
  if (answer) {
    out.answer = answer;
    await r.del(K.answer(waiting));
  }
  res.json(out);
}
