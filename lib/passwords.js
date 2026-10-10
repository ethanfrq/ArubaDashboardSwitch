import crypto from 'node:crypto';

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Mots de passe des comptes : stockés hachés (scrypt + sel), jamais en clair.
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
export function checkPassword(pw, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw), rec.salt, 32), Buffer.from(rec.hash, 'hex'));
}
