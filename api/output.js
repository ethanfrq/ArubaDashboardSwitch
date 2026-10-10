import { store, K } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { isAutoKind, redactOutput } from '../lib/readonly.js';
import { findRead } from '../lib/features/index.js';

export default async function handler(req, res) {
  const s = await requireSession(req, res);
  if (!s) return;
  const r = store();
  // Lectures des fonctions d'administration : ?part=nom (chaque module vérifie lui-même le rôle).
  if (req.query.part) {
    const fn = findRead(String(req.query.part));
    if (!fn) return res.status(400).json({ error: 'Lecture inconnue.' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await fn({ r, role: s.role, query: req.query }) ?? null);
    } catch (e) {
      if (e.expose) return res.status(e.status || 400).json({ error: e.message });
      console.error('part', req.query.part, e);
      return res.status(500).json({ error: 'Erreur interne pendant la lecture.' });
    }
  }
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
