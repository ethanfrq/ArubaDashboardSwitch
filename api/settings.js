import { redis, K, getSettings, DEFAULT_SETTINGS } from '../lib/redis.js';
import { requireSession } from '../lib/auth.js';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export default async function handler(req, res) {
  if (!requireSession(req, res)) return;
  if (req.method === 'GET') {
    return res.json({ settings: await getSettings(), emailAvailable: Boolean(process.env.RESEND_API_KEY) });
  }
  if (req.method !== 'POST') return res.status(405).end();
  const b = req.body || {};
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
  };
  const r = redis();
  await r.set(K.settings, settings);
  await r.incr(K.sver); // l'agent récupère les nouveaux réglages à sa prochaine synchro
  res.json({ ok: true, settings });
}
