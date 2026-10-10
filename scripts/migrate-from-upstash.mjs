// Copie les données d'une installation 1.6.0 (Upstash Redis, clés aruba:*) vers Supabase (tables mam_kv et mam_list,
// clés mam:*). À lancer une seule fois, depuis le dossier du projet, après avoir ajouté Supabase au projet Vercel :
//
//   vercel env pull .env.migration --environment=production --yes
//   node --env-file=.env.migration scripts/migrate-from-upstash.mjs
//   (puis supprimer .env.migration)
//
// Lit Upstash avec KV_REST_API_URL / KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) et écrit
// dans la base indiquée par POSTGRES_URL. Les expirations en cours sont gardées. Upstash n'est pas modifié.
// Refuse d'écraser une base déjà utilisée par la 1.7.0 (clé mam:state présente), sauf avec --force.
import { store, ensureSchema } from '../lib/store.js';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FORCE = process.argv.includes('--force');

async function redis(...cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(cmd) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(`Upstash ${cmd[0]} : ${body.error || r.status}`);
  return body.result;
}

async function main() {
  if (!URL_ || !TOKEN) throw new Error('Variables Upstash absentes (KV_REST_API_URL et KV_REST_API_TOKEN).');
  if (!process.env.POSTGRES_URL) throw new Error('Variable POSTGRES_URL absente : ajoute d’abord Supabase au projet Vercel.');
  await ensureSchema();
  const r = store();
  if (!FORCE && (await r.get('mam:state')) !== null) {
    throw new Error('La base Supabase contient déjà des données de la 1.7.0 (mam:state). Relance avec --force pour écraser.');
  }

  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis('SCAN', cursor, 'MATCH', 'aruba:*', 'COUNT', '500');
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0');

  const done = { string: 0, list: 0 }, skipped = [];
  for (const key of [...new Set(keys)].sort()) {
    const target = `mam:${key.slice('aruba:'.length)}`;
    const type = await redis('TYPE', key);
    if (type === 'string') {
      const [value, pttl] = await Promise.all([redis('GET', key), redis('PTTL', key)]);
      if (value === null || pttl === -2) continue; // expirée entre-temps
      await r.set(target, value, pttl > 0 ? { ex: Math.max(1, Math.ceil(pttl / 1000)) } : {});
      done.string++;
    } else if (type === 'list') {
      const values = await redis('LRANGE', key, '0', '-1');
      await r.ltrim(target, 1, 0); // vide la liste cible (relance sans doublon)
      for (let i = 0; i < values.length; i += 500) await r.rpush(target, ...values.slice(i, i + 500));
      done.list++;
    } else if (type !== 'none') {
      skipped.push(`${key} (${type})`);
    }
  }

  console.log(`Copié : ${done.string} valeurs et ${done.list} listes (${keys.length} clés aruba:* trouvées).`);
  if (skipped.length) console.log(`Ignoré (type inattendu) : ${skipped.join(', ')}`);
  console.log('Terminé. Redéploie le projet, vérifie le dashboard, puis supprime Upstash et QStash du projet Vercel.');
}

main().then(() => process.exit(0), (e) => { console.error(`Échec : ${e.message}`); process.exit(1); });
