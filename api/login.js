import { store, K } from '../lib/db.js';
import { setSession } from '../lib/auth.js';
import { hashPassword } from '../lib/passwords.js';
import { getTotp, consumeCode } from '../lib/totp.js';
import { loadUsers, updateUsers, checkLogin, findInvite, checkNewPassword, audit, shortAgent, normLogin, ROLE_LABEL, fail } from '../lib/users.js';

// Connexion (identifiant + mot de passe, puis code de double authentification s'il est actif) et liens
// d'invitation ou de nouveau mot de passe : { action: 'invite-info' | 'invite-accept', token, password }.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = (req.headers['x-forwarded-for'] || 'inconnu').split(',')[0].trim();
  const r = store();
  const tries = await r.incr(K.tries(ip));
  if (tries === 1) await r.expire(K.tries(ip), 900);
  if (tries > 8) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 minutes.' });
  const left = 8 - tries, more = left <= 3 ? ` (encore ${left} essai${left > 1 ? 's' : ''} avant blocage 15 min)` : '';
  const b = req.body || {};

  try {
    if (b.action === 'invite-info' || b.action === 'invite-accept') return await invite(req, res, b, r, ip);
  } catch (e) {
    if (e.expose) return res.status(e.status || 400).json({ error: e.message });
    console.error('invite', e);
    return res.status(500).json({ error: 'Erreur interne.' });
  }

  const { doc } = await loadUsers();
  // Tolère les espaces, guillemets ou accents graves copiés par erreur autour du mot de passe.
  const password = String(b.password ?? '').replace(/^[`'"«»\s]+|[`'"«»\s]+$/g, '');
  const user = password ? checkLogin(doc, b.login, password) : null;
  if (!user) {
    if (normLogin(b.login)) await audit({ name: normLogin(b.login).slice(0, 64) }, 'Connexion refusée', 'identifiant ou mot de passe incorrect', req);
    return res.status(401).json({ error: `Identifiant ou mot de passe incorrect${more}.` });
  }
  // Double authentification : le mot de passe seul ne suffit pas.
  let recoveryUsed = false;
  const totp = user.has2fa ? await getTotp(user.id) : null;
  if (totp) {
    const code = String(b.code ?? '').trim();
    if (!code) return res.json({ totp: true }); // la page demande alors le code (le mot de passe est juste)
    const how = await consumeCode(user.id, totp, code);
    if (!how) return res.status(401).json({ totp: true, error: `Code incorrect${more}.` });
    recoveryUsed = how === 'recovery';
  }
  await r.del(K.tries(ip));
  const ua = shortAgent(req.headers['user-agent']);
  await updateUsers((d) => { const u = d.users.find((x) => x.id === user.id); if (u) u.lastLogin = { t: Math.round(Date.now() / 1000), ua }; }).catch(() => {});
  await audit(user, 'Connexion', recoveryUsed ? 'avec un code de secours' : ua, req);
  setSession(res, user);
  res.json({ ok: true, role: user.role, recoveryUsed, need2fa: Boolean(user.require2fa && !user.has2fa) });
}

async function invite(req, res, b, r, ip) {
  const { doc } = await loadUsers();
  const found = findInvite(doc, b.token);
  if (!found) throw fail('Ce lien n’est plus valable (48 h au plus, ou déjà utilisé). Demande-en un nouveau à un administrateur.', 404);
  const { inv, user } = found;
  if (b.action === 'invite-info') {
    return res.json({ name: user.name, login: user.login, role: ROLE_LABEL[user.role], kind: inv.kind, require2fa: Boolean(user.require2fa && !user.has2fa) });
  }
  const pw = checkNewPassword(b.password, user);
  const u = await updateUsers((d) => {
    const cur = findInvite(d, b.token);
    if (!cur) throw fail('Ce lien vient d’être utilisé.', 409);
    const t = cur.user;
    t.pw = hashPassword(pw); t.pwT = Math.round(Date.now() / 1000);
    t.pending = false; t.sv = (t.sv || 0) + 1; // un nouveau mot de passe ferme les anciennes sessions
    d.invites = d.invites.filter((i) => i.id !== cur.inv.id);
    return t;
  });
  await r.del(K.tries(ip));
  await audit(u, inv.kind === 'invite' ? 'Invitation acceptée' : 'Nouveau mot de passe choisi', '', req);
  // Double authentification déjà active (réinitialisation) : on passe par la connexion normale, code compris.
  if (u.has2fa) return res.json({ ok: true, login: u.login, needLogin: true });
  setSession(res, u);
  res.json({ ok: true, role: u.role, need2fa: Boolean(u.require2fa) });
}
