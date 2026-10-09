import { getSettings } from '../../lib/redis.js';
import { requireSession } from '../../lib/auth.js';
import { notify } from '../../lib/notify.js';

export default async function handler(req, res) {
  if (!(await requireSession(req, res, { admin: true }))) return;
  if (req.method !== 'POST') return res.status(405).end();
  const settings = await getSettings();
  if (!settings.email && !settings.webhook) return res.status(400).json({ error: 'Renseigne un e-mail ou un webhook puis enregistre.' });
  const r = await notify([{ type: 'test', level: 'info', text: 'Test de notification : les alertes fonctionnent.' }], settings, { test: true });
  if (!r.sent.length) return res.status(502).json({ error: r.errors.join(' · ') || 'Aucun canal configuré.' });
  res.json(r);
}
