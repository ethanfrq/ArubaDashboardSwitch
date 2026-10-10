import crypto from 'node:crypto';
import { store } from './db.js';
import { updateUsers, audit } from './users.js';

// Double authentification de chaque compte : code à 6 chiffres d'une application (TOTP, RFC 6238 : SHA-1, 30 s,
// comme Google Authenticator ou Microsoft Authenticator), plus 8 codes de secours à usage unique.
// mam:totp:<compte>         { secret, t, last (dernier pas de 30 s utilisé : un code ne sert qu'une fois), recovery: [hachés] }
// mam:totp:pending:<compte> { secret } pendant l'activation (10 min), tant que le premier code n'a pas été vérifié
// Perte du téléphone et des codes : un administrateur la réinitialise (Utilisateurs). Pour le compte principal seul,
// supprimer la ligne mam:totp:owner de la table mam_kv dans Supabase.
export const KEY = (uid) => `mam:totp:${uid}`, PENDING = (uid) => `mam:totp:pending:${uid}`;
const STEP = 30, DIGITS = 6, WINDOW = 1; // tolérance d'un pas (horloge du téléphone un peu décalée)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Pas de 30 s qui correspond au code, ou null. after : dernier pas déjà utilisé (refus de la réutilisation).
export function matchStep(secret, code, now = Date.now() / 1000, after = -1) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(now / STEP);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = cur + d;
    if (step > after && crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

const hashCode = (c) => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newRecovery() {
  const plain = Array.from({ length: 8 }, () => {
    const s = base32(crypto.randomBytes(6)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  return { plain, hashed: plain.map(hashCode) };
}

export async function getTotp(uid) {
  const rec = await store().get(KEY(uid));
  return rec?.secret ? rec : null;
}
export const totpInfo = (rec) => ({ enabled: Boolean(rec), t: rec?.t || null, recoveryLeft: rec?.recovery?.length ?? 0 });

// Vérifie un code (ou un code de secours) et le consomme. Renvoie 'totp', 'recovery' ou null.
export async function consumeCode(uid, rec, code) {
  const r = store();
  const step = matchStep(rec.secret, code, Date.now() / 1000, Number(rec.last ?? -1));
  if (step !== null) {
    await r.set(KEY(uid), { ...rec, last: step });
    return 'totp';
  }
  const h = hashCode(code);
  if (String(code || '').replace(/[^A-Za-z0-9]/g, '').length === 8 && (rec.recovery || []).includes(h)) {
    await r.set(KEY(uid), { ...rec, recovery: rec.recovery.filter((x) => x !== h) });
    return 'recovery';
  }
  return null;
}

const setHas2fa = (uid, on) => updateUsers((doc) => { const u = doc.users.find((x) => x.id === uid); if (u) u.has2fa = on; });

// Étapes d'activation et de gestion, appelées par api/settings.js (« Mon profil » du compte connecté).
export async function totpAction(action, body, user, req) {
  const r = store();
  const uid = user.id;
  const fail = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });
  const cur = await getTotp(uid);
  if (action === 'totp-start') {
    if (cur) throw fail('La double authentification est déjà active.');
    const secret = base32(crypto.randomBytes(20));
    await r.set(PENDING(uid), { secret }, { ex: 600 });
    const name = encodeURIComponent(`My Aruba Manager:${user.login || 'admin'}`);
    return { secret, uri: `otpauth://totp/${name}?secret=${secret}&issuer=${encodeURIComponent('My Aruba Manager')}&algorithm=SHA1&digits=6&period=30` };
  }
  if (action === 'totp-confirm') {
    const p = await r.get(PENDING(uid));
    if (!p?.secret) throw fail('Activation expirée : recommence.');
    const step = matchStep(p.secret, body.code);
    if (step === null) throw fail('Code incorrect : vérifie l’heure du téléphone et réessaie.');
    const { plain, hashed } = newRecovery();
    await r.set(KEY(uid), { secret: p.secret, t: Math.round(Date.now() / 1000), last: step, recovery: hashed });
    await r.del(PENDING(uid));
    await setHas2fa(uid, true);
    await audit(user, 'Double authentification activée', '', req);
    return { ok: true, recovery: plain, totp: totpInfo(await getTotp(uid)) };
  }
  if (!cur) throw fail('La double authentification n’est pas active.');
  if (!(await consumeCode(uid, cur, body.code))) throw fail('Code incorrect.');
  if (action === 'totp-disable') {
    if (user.require2fa) throw fail('Un administrateur exige la double authentification pour ton compte.');
    await r.del(KEY(uid));
    await setHas2fa(uid, false);
    await audit(user, 'Double authentification désactivée', '', req);
    return { ok: true, totp: totpInfo(null) };
  }
  if (action === 'totp-recovery') {
    const { plain, hashed } = newRecovery();
    await r.set(KEY(uid), { ...(await getTotp(uid)), recovery: hashed });
    await audit(user, 'Nouveaux codes de secours', '', req);
    return { ok: true, recovery: plain, totp: totpInfo(await getTotp(uid)) };
  }
  throw fail('Action inconnue.');
}
