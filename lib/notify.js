import crypto from 'node:crypto';
import { K, upsert } from './db.js';
import { loadUsers } from './users.js';

// Niveau en toutes lettres au début de chaque ligne et du sujet : un e-mail ou un webhook en texte brut n'affiche pas d'icône.
const TAG = { critical: '[Critique]', warning: '[Attention]', ok: '[Rétabli]', info: '[Info]' };
const DASH = process.env.DASHBOARD_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');

async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.ALERT_FROM || 'Switch Aruba <onboarding@resend.dev>',
      to: to.split(/[,;\s]+/).filter(Boolean), subject, text }),
  });
  if (!r.ok) throw new Error(`E-mail : ${r.status} ${(await r.text()).slice(0, 200)}`);
  return true;
}

// Teams, Slack, Discord, Google Chat, ntfy… : un message texte suffit à la plupart.
async function sendWebhook(url, text) {
  if (!url) return false;
  const ntfy = /ntfy/i.test(url);
  const r = await fetch(url, ntfy
    ? { method: 'POST', body: text, headers: { Title: 'Switch Aruba' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  if (!r.ok) throw new Error(`Webhook : ${r.status}`);
  return true;
}

// Envoie une liste d'événements (e-mail + webhook) et les ajoute au journal des alertes.
export async function notify(events, settings, { test = false, host = 'Switch' } = {}) {
  if (!events.length) return { sent: [] };
  const lines = events.map((e) => `${TAG[e.level] || TAG.info} ${e.text}`);
  const worst = ['critical', 'warning', 'ok'].find((l) => events.some((e) => e.level === l)) || 'info';
  const subject = `${TAG[worst]} ${host} : ${events.length > 1 ? `${events.length} événements` : events[0].text}`.slice(0, 140);
  const body = `${lines.join('\n')}\n\n${DASH ? `Dashboard : ${DASH}\n` : ''}${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`;

  // Destinataires : adresses des réglages, plus les comptes actifs qui ont coché « recevoir les alertes » (Mon profil).
  const users = await loadUsers().then(({ doc }) => doc.users.filter((u) => u.prefs?.alerts && u.email && !u.disabled && !u.pending).map((u) => u.email)).catch(() => []);
  const to = [...new Set([...String(settings.email || '').split(/[,;\s]+/).filter(Boolean), ...users])].join(', ');
  const sent = [], errors = [];
  for (const [name, fn] of [['email', () => sendEmail(to, subject, body)], ['webhook', () => sendWebhook(settings.webhook, `${subject}\n${body}`)]]) {
    try { if (await fn()) sent.push(name); } catch (e) { errors.push(e.message); }
  }
  await upsert(K.alerts, events.map((e) => ({ id: crypto.randomUUID(), t: Date.now() / 1000, ...e, sent, errors, test })), 60);
  return { sent, errors };
}
