import { store, K, getSettings, DEFAULT_SETTINGS } from '../lib/db.js';
import { requireSession, hashPassword, safeEqual } from '../lib/auth.js';
import { findAction } from '../lib/features/index.js';
import { getTotp, totpInfo, totpAction } from '../lib/totp.js';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export default async function handler(req, res) {
  const s = await requireSession(req, res, { admin: req.method !== 'GET' });
  if (!s) return;
  const r = store();
  if (req.method === 'GET') {
    const settings = await getSettings();
    // Lecture seule : les destinataires des alertes ne sont pas dévoilés.
    if (s.role !== 'admin') return res.json({ settings: { ...settings, email: settings.email ? '-' : '', webhook: settings.webhook ? '-' : '' } });
    const [viewer, totp, cron] = await Promise.all([r.get(K.viewer), getTotp(), r.get('mam:cron')]);
    return res.json({ settings, emailAvailable: Boolean(process.env.RESEND_API_KEY), viewer: { enabled: Boolean(viewer), t: viewer?.t || null },
      totp: totpInfo(totp), cron: cron && { ok: cron.ok, error: cron.error || null, t: cron.t } });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const b = req.body || {};
  // Actions des fonctions d'administration (annuaire, profils, planification…) : { action: 'nom', ... }.
  // Double authentification : activation, désactivation, nouveaux codes de secours.
  if (/^totp-(start|confirm|disable|recovery)$/.test(String(b.action || ''))) {
    try {
      return res.json(await totpAction(String(b.action), b, req.headers.host));
    } catch (e) {
      if (e.expose) return res.status(e.status || 400).json({ error: e.message });
      console.error('totp', e);
      return res.status(500).json({ error: 'Erreur interne.' });
    }
  }
  if (b.action) {
    const fn = findAction(String(b.action));
    if (!fn) return res.status(400).json({ error: 'Action inconnue.' });
    try {
      const [state, settings] = await Promise.all([r.get(K.state), getSettings()]);
      return res.json(await fn({ r, body: b, state, settings }) ?? { ok: true });
    } catch (e) {
      if (e.expose) return res.status(e.status || 400).json({ error: e.message, ...(e.data || {}) }); // ex. jeton CONFIRMER
      console.error('action', b.action, e);
      return res.status(500).json({ error: 'Erreur interne pendant l’action.' });
    }
  }
  const cur = await getSettings();
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
    siteName: b.siteName === undefined ? cur.siteName : String(b.siteName).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60),
    tz: b.tz === undefined ? cur.tz : validTz(String(b.tz).trim()) ? String(b.tz).trim() : cur.tz,
    agent: Object.fromEntries(Object.entries(DEFAULT_SETTINGS.agent).map(([k, d]) => {
      // champ vide : on garde la valeur actuelle ; 120 s au plus pour rester sous les seuils « agent hors ligne »
      const raw = b.agent?.[k], v = raw === '' || raw == null ? Number(cur.agent?.[k] ?? d) : Number(raw);
      return [k, Math.round(Math.min(120, Math.max(k === 'hot' ? 5 : 10, Number.isFinite(v) ? v : d)))];
    })),
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

function validTz(tz) {
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return Boolean(tz); } catch { return false; }
}
