import { clearSession, getSession } from '../lib/auth.js';
import { audit } from '../lib/users.js';

export default async function handler(req, res) {
  const s = await getSession(req).catch(() => null);
  if (s) await audit(s.user, 'Déconnexion', '', req);
  clearSession(res);
  res.json({ ok: true });
}
