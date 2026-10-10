import { store, K, getSettings, DEFAULT_SETTINGS } from '../lib/db.js';
import { requireSession, setSession, checkPassword, safeEqual } from '../lib/auth.js';
import { hashPassword } from '../lib/passwords.js';
import { findAction } from '../lib/features/index.js';
import { getTotp, totpInfo, totpAction } from '../lib/totp.js';
import { loadUsers, updateUsers, userAction, publicUser, audit, checkNewPassword, AUDIT, SEEN, fail } from '../lib/users.js';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
// Actions des fonctions d'administration permises au technicien (annuaire des appareils, plan de brassage).
const TECH_ACTIONS = new Set(['device-name', 'port-plan']);
const ACTION_LABEL = { 'device-name': 'Appareil nommé', 'port-plan': 'Plan de brassage modifié', 'device-forget': 'Appareil oublié',
  'profiles-save': 'Profils de port modifiés', 'profiles-reset': 'Profils de port réinitialisés', 'schedules-save': 'Actions planifiées modifiées' };

export default async function handler(req, res) {
  // Lecture et « Mon profil » : permis à tout compte connecté, même avant d'avoir activé la double authentification.
  const s = await requireSession(req, res, { allow2fa: true });
  if (!s) return;
  const r = store();
  try {
    if (req.method === 'GET') return await read(req, res, s, r);
    if (req.method !== 'POST') return res.status(405).end();
    const b = req.body || {};
    const action = String(b.action || '');
    if (/^totp-(start|confirm|disable|recovery)$/.test(action)) return res.json(await totpAction(action, b, s.user, req));
    if (/^profile-/.test(action)) return res.json(await profileAction(action, b, s, req, res));
    if (s.need2fa) throw fail('Active d’abord la double authentification dans « Mon profil ».', 403, { need2fa: true });
    if (/^user-/.test(action)) {
      if (s.role !== 'admin') throw fail('Gestion des comptes réservée à un administrateur.', 403);
      return res.json(await userAction(action, b, s.user, req));
    }
    if (action) {
      if (!(s.role === 'admin' || (s.role === 'tech' && TECH_ACTIONS.has(action)))) throw fail(s.staff ? 'Action réservée à un administrateur.' : 'Accès en lecture seule : aucune modification possible.', 403);
      const fn = findAction(action);
      if (!fn) throw fail('Action inconnue.');
      const [state, settings] = await Promise.all([r.get(K.state), getSettings()]);
      const out = await fn({ r, body: b, state, settings }) ?? { ok: true };
      if (ACTION_LABEL[action] && !(out && out.status === 409)) await audit(s.user, ACTION_LABEL[action], detailOf(action, b), req);
      return res.json(out);
    }
    if (s.role !== 'admin') throw fail('Réglages réservés à un administrateur.', 403);
    return await saveSettings(req, res, s, r, b);
  } catch (e) {
    if (e.expose) return res.status(e.status || 400).json({ error: e.message, ...(e.data || {}) }); // ex. jeton CONFIRMER
    console.error('settings', e);
    return res.status(500).json({ error: 'Erreur interne.' });
  }
}

function detailOf(action, b) {
  if (action === 'device-name') return `${b.name || '(sans nom)'} · ${b.mac || ''}`;
  if (action === 'port-plan') return `port ${String(b.port || '').split('/').pop()}${b.jack ? `, prise ${b.jack}` : ''}${b.room ? `, salle ${b.room}` : ''}`;
  return '';
}

async function read(req, res, s, r) {
  const part = String(req.query.part || '');
  res.setHeader('Cache-Control', 'no-store');
  if (part === 'me') {
    const totp = await getTotp(s.uid);
    return res.json({ me: publicUser(s.user), totp: totpInfo(totp), emailAvailable: Boolean(process.env.RESEND_API_KEY) });
  }
  if (part === 'users') {
    if (s.role !== 'admin') throw fail('Réservé à un administrateur.', 403);
    const { doc } = await loadUsers();
    const seen = doc.users.length ? await r.mget(...doc.users.map((u) => SEEN(u.id))) : [];
    return res.json({
      users: doc.users.map((u, i) => publicUser(u, { seen: seen[i] || null, invite: inviteOf(doc, u) })),
      emailAvailable: Boolean(process.env.RESEND_API_KEY), me: s.uid,
    });
  }
  if (part === 'online') {
    if (!s.staff) throw fail('Réservé aux administrateurs et techniciens.', 403);
    const { doc } = await loadUsers();
    const seen = doc.users.length ? await r.mget(...doc.users.map((u) => SEEN(u.id))) : [];
    return res.json({ online: doc.users.map((u, i) => seen[i] && { id: u.id, name: u.name, role: u.role, ...seen[i] }).filter(Boolean) });
  }
  if (part === 'audit') {
    if (s.role !== 'admin') throw fail('Réservé à un administrateur.', 403);
    const rows = await r.lrange(AUDIT, -400, -1);
    return res.json({ rows: rows.reverse() });
  }
  const settings = await getSettings();
  // Hors administrateur : les destinataires des alertes ne sont pas dévoilés.
  if (s.role !== 'admin') return res.json({ settings: { ...settings, email: settings.email ? '-' : '', webhook: settings.webhook ? '-' : '' } });
  const cron = await r.get('mam:cron');
  return res.json({ settings, emailAvailable: Boolean(process.env.RESEND_API_KEY), cron: cron && { ok: cron.ok, error: cron.error || null, t: cron.t } });
}

function inviteOf(doc, u) {
  const i = doc.invites.find((x) => x.userId === u.id);
  return i ? { kind: i.kind, exp: i.exp } : null;
}

// « Mon profil » : nom, e-mail, alertes, mot de passe, sessions.
async function profileAction(action, b, s, req, res) {
  const me = s.user;
  if (action === 'profile-save') {
    const name = String(b.name ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw fail('Indique un nom.');
    const email = String(b.email ?? '').trim().toLowerCase();
    if (email && !EMAIL.test(email)) throw fail('Adresse e-mail invalide.');
    const u = await updateUsers((doc) => {
      const t = doc.users.find((x) => x.id === me.id);
      if (email && doc.users.some((x) => x.id !== me.id && (x.login === email || x.email === email))) throw fail('Cette adresse est déjà utilisée par un autre compte.');
      t.name = name; t.email = email;
      t.prefs = { ...(t.prefs || {}), alerts: Boolean(b.alerts) && Boolean(email) };
      return t;
    });
    await audit(u, 'Profil modifié', '', req);
    return { ok: true, me: publicUser(u) };
  }
  if (action === 'profile-password') {
    const env = String(process.env.DASHBOARD_PASSWORD || '').trim();
    const cur = String(b.current ?? '');
    const okCur = (me.pw && checkPassword(cur, me.pw)) || (me.owner && env && safeEqual(cur.trim(), env));
    if (!okCur) throw fail('Mot de passe actuel incorrect.');
    const pw = checkNewPassword(b.next, me);
    if (me.owner && env && safeEqual(pw.trim(), env)) throw fail('Choisis un mot de passe différent de celui de secours défini dans Vercel.');
    const u = await updateUsers((doc) => {
      const t = doc.users.find((x) => x.id === me.id);
      t.pw = hashPassword(pw); t.pwT = Math.round(Date.now() / 1000); t.sv = (t.sv || 0) + 1;
      return t;
    });
    setSession(res, u); // cette session reste ouverte, les autres sont fermées
    await audit(u, 'Mot de passe changé', '', req);
    return { ok: true, me: publicUser(u) };
  }
  if (action === 'profile-logout-others') {
    const u = await updateUsers((doc) => { const t = doc.users.find((x) => x.id === me.id); t.sv = (t.sv || 0) + 1; return t; });
    setSession(res, u);
    await audit(u, 'Autres sessions fermées', '', req);
    return { ok: true };
  }
  throw fail('Action inconnue.');
}

async function saveSettings(req, res, s, r, b) {
  const cur = await getSettings();
  const emails = String(b.email || '').split(/[,;\s]+/).filter(Boolean);
  if (emails.some((e) => !EMAIL.test(e))) throw fail('Adresse e-mail invalide.');
  const webhook = String(b.webhook || '').trim();
  if (webhook && !/^https:\/\/\S+$/.test(webhook)) throw fail('Le webhook doit commencer par https://');
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
  await audit(s.user, 'Réglages modifiés', '', req);
  res.json({ ok: true, settings });
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return Boolean(tz); } catch { return false; }
}

