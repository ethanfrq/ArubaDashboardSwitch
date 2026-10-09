import { redis, K, getSettings, DEFAULT_SETTINGS } from '../lib/redis.js';
import { requireSession, hashPassword, safeEqual } from '../lib/auth.js';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export default async function handler(req, res) {
  const s = await requireSession(req, res, { admin: req.method !== 'GET' });
  if (!s) return;
  const r = redis();
  if (req.method === 'GET') {
    const settings = await getSettings();
    // Lecture seule : les destinataires des alertes ne sont pas dévoilés.
    if (s.role !== 'admin') return res.json({ settings: { ...settings, email: settings.email ? '-' : '', webhook: settings.webhook ? '-' : '' } });
    const viewer = await r.get(K.viewer);
    return res.json({ settings, emailAvailable: Boolean(process.env.RESEND_API_KEY), viewer: { enabled: Boolean(viewer), t: viewer?.t || null } });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const b = req.body || {};
  const viewerPw = String(b.viewerPassword ?? '').trim();
  if (viewerPw && viewerPw.length < 8) return res.status(400).json({ error: 'Le mot de passe lecture seule doit faire au moins 8 caractères.' });
  if (viewerPw && safeEqual(viewerPw, String(process.env.DASHBOARD_PASSWORD || '').trim())) {
    return res.status(400).json({ error: 'Le mot de passe lecture seule doit être différent du mot de passe administrateur.' });
  }
  const emails = String(b.email || '').split(/[,;\s]+/).filter(Boolean);
  if (emails.some((e) => !EMAIL.test(e))) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  const webhook = String(b.webhook || '').trim();
  if (webhook && !/^https:\/\/\S+$/.test(webhook)) return res.status(400).json({ error: 'Le webhook doit commencer par https://' });
  const watch = Array.isArray(b.watchPorts) ? b.watchPorts.filter((p) => /^1\/1\/\d{1,2}$/.test(p)) : null;
  const settings = {
    email: emails.join(', '),
    webhook,
    watchPorts: watch && watch.length ? watch : null,
    tempMax: Math.min(95, Math.max(40, Number(b.tempMax) || DEFAULT_SETTINGS.tempMax)),
    notify: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.notify).map((k) => [k, Boolean(b.notify?.[k])])),
    autoCable: b.autoCable === undefined ? DEFAULT_SETTINGS.autoCable : Boolean(b.autoCable),
  };
  await r.set(K.settings, settings);
  await r.incr(K.sver); // l'agent récupère les nouveaux réglages à sa prochaine synchro
  // Accès lecture seule : nouveau mot de passe (les écrans déjà connectés sont déconnectés) ou suppression.
  let viewer = await r.get(K.viewer);
  if (b.viewerDisable) { await r.del(K.viewer); viewer = null; }
  else if (viewerPw) {
    viewer = { ...hashPassword(viewerPw), v: (Number(viewer?.v) || 0) + 1, t: Date.now() / 1000 };
    await r.set(K.viewer, viewer);
  }
  res.json({ ok: true, settings, viewer: { enabled: Boolean(viewer), t: viewer?.t || null } });
}
