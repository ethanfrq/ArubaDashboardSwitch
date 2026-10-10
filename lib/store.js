import crypto from 'node:crypto';
import postgres from 'postgres';

// Stockage dans Postgres (Supabase, ajouté en un clic depuis le Marketplace Vercel). Deux tables créées toutes seules
// au premier lancement : mam_kv (valeurs JSON, avec expiration facultative) et mam_list (files et historiques).
// L'interface reprend les opérations clé-valeur dont le dashboard a besoin (get, set, mget, listes…), plus quelques
// écritures atomiques (journal borné, valeur versionnée, écriture conditionnelle).

let sql, ready;

function db() {
  if (!sql) {
    const url = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (!url) throw new Error('Base de données non connectée au projet (ajoute Supabase depuis le Marketplace Vercel).');
    // prepare: false : obligatoire derrière le répartiteur de connexions de Supabase (mode transaction)
    sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
  }
  return sql;
}

// Création des tables (une fois par instance). RLS activé sans règle : l'API publique de Supabase (clé anon) n'y a
// aucun accès ; seul le serveur du dashboard, connecté en propriétaire des tables, lit et écrit.
const SCHEMA = `
create table if not exists mam_kv (key text primary key, value jsonb, expires_at timestamptz);
create table if not exists mam_list (id bigserial primary key, key text not null, value jsonb not null);
create index if not exists mam_list_key_id on mam_list (key, id);
alter table mam_kv enable row level security;
alter table mam_list enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on mam_kv, mam_list from anon, authenticated;
  end if;
end $$;`;

export function ensureSchema() {
  if (!ready) ready = db().unsafe(SCHEMA).then(() => true, (e) => { ready = null; throw e; });
  return ready;
}

const live = (q) => q`(expires_at is null or expires_at > now())`; // valeur non expirée

// Comme le client Upstash d'origine : une chaîne qui contient du JSON est enregistrée analysée (« 1 » -> 1,
// « {...} » -> objet), le reste tel quel.
function parse(v) {
  if (typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
}
const json = (v) => db().json(parse(v));
const lockKey = (tx, key) => tx`select pg_advisory_xact_lock(hashtext(${key}))`;

// ---------------------------------------------------------------- clé-valeur
const kv = {
  async get(key) {
    await ensureSchema();
    const [row] = await db()`select value from mam_kv where key = ${key} and ${live(db())}`;
    return row ? row.value : null;
  },

  async mget(...keys) {
    await ensureSchema();
    if (!keys.length) return [];
    const rows = await db()`select key, value from mam_kv where key = any(${keys}::text[]) and ${live(db())}`;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return keys.map((k) => (map.has(k) ? map.get(k) : null));
  },

  // opts : { ex: secondes } pour une expiration, { get: true } pour renvoyer l'ancienne valeur
  async set(key, value, opts = {}) {
    await ensureSchema();
    const exp = opts.ex ? db()`now() + make_interval(secs => ${Number(opts.ex)})` : null;
    if (opts.get) {
      return db().begin(async (tx) => {
        await lockKey(tx, key);
        const [old] = await tx`select value from mam_kv where key = ${key} and ${live(tx)}`;
        await tx`insert into mam_kv (key, value, expires_at) values (${key}, ${json(value)}, ${exp})
          on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
        return old ? old.value : null;
      });
    }
    await db()`insert into mam_kv (key, value, expires_at) values (${key}, ${json(value)}, ${exp})
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
    return 'OK';
  },

  async del(...keys) {
    await ensureSchema();
    if (!keys.length) return 0;
    const res = await db()`delete from mam_kv where key = any(${keys}::text[])`;
    return res.count;
  },

  // Entier +1 ; une clé absente ou expirée repart de 0 (l'expiration en cours est gardée, comme INCR).
  async incr(key) {
    await ensureSchema();
    const [row] = await db()`insert into mam_kv (key, value) values (${key}, '1'::jsonb)
      on conflict (key) do update set
        value = to_jsonb(case when mam_kv.expires_at is not null and mam_kv.expires_at <= now() then 0
                              else coalesce((mam_kv.value #>> '{}')::numeric, 0) end + 1),
        expires_at = case when mam_kv.expires_at is not null and mam_kv.expires_at <= now() then null else mam_kv.expires_at end
      returning value`;
    return Number(row.value);
  },

  async expire(key, seconds) {
    await ensureSchema();
    const res = await db()`update mam_kv set expires_at = now() + make_interval(secs => ${Number(seconds)}) where key = ${key}`;
    return res.count;
  },

  async getdel(key) {
    await ensureSchema();
    const [row] = await db()`delete from mam_kv where key = ${key} returning value, expires_at`;
    return row && (!row.expires_at || row.expires_at > new Date()) ? row.value : null;
  },

  // ---------------------------------------------------------------- listes (file de commandes, historiques)
  async rpush(key, ...values) {
    await ensureSchema();
    if (!values.length) return 0;
    await db()`insert into mam_list ${db()(values.map((v) => ({ key, value: json(v) })))}`;
    const [{ n }] = await db()`select count(*)::int as n from mam_list where key = ${key}`;
    return n;
  },

  // Retire et renvoie les count premiers éléments (null si la liste est vide). SKIP LOCKED : deux relevés simultanés
  // ne prennent jamais la même commande.
  async lpop(key, count = 1) {
    await ensureSchema();
    const rows = await db()`delete from mam_list where id in (
        select id from mam_list where key = ${key} order by id limit ${Number(count)} for update skip locked)
      returning id, value`;
    if (!rows.length) return null;
    return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((r) => r.value);
  },

  async lrange(key, start, stop) {
    await ensureSchema();
    const rows = await db()`select value from mam_list where key = ${key} order by id`;
    return slice(rows.map((r) => r.value), start, stop);
  },

  // Ne garde que la tranche [start, stop] (indices négatifs comptés depuis la fin, comme LTRIM).
  async ltrim(key, start, stop) {
    await ensureSchema();
    const ids = (await db()`select id from mam_list where key = ${key} order by id`).map((r) => r.id);
    const keep = new Set(slice(ids, start, stop).map(String));
    const drop = ids.filter((id) => !keep.has(String(id)));
    if (drop.length) await db()`delete from mam_list where id = any(${drop}::bigint[])`;
    return 'OK';
  },

  // Retire les éléments égaux à value (count = 0 : tous). Renvoie le nombre retiré.
  async lrem(key, count, value) {
    await ensureSchema();
    const target = parse(value);
    const rows = await db()`select id from mam_list where key = ${key} and value = ${db().json(target)} order by id`;
    const ids = (Number(count) > 0 ? rows.slice(0, Number(count)) : rows).map((r) => r.id);
    if (!ids.length) return 0;
    const res = await db()`delete from mam_list where id = any(${ids}::bigint[])`;
    return res.count;
  },

  // ---------------------------------------------------------------- écritures atomiques
  // Valeur JSON + version incrémentée (le dashboard ne la relit que si la version change). Renvoie la version.
  async writeJSON(key, value) {
    await ensureSchema();
    return db().begin(async (tx) => {
      await tx`insert into mam_kv (key, value) values (${key}, ${tx.json(value ?? null)})
        on conflict (key) do update set value = excluded.value, expires_at = null`;
      return bump(tx, verKey(key));
    });
  },

  // Insère ou met à jour (par id) des éléments d'une liste JSON gardée dans une seule valeur, plus récents en tête,
  // au plus max éléments ; incrémente sa version. Verrou par clé : deux mises à jour simultanées ne se perdent pas.
  async upsertList(key, items, max) {
    await ensureSchema();
    return db().begin(async (tx) => {
      await lockKey(tx, key);
      const [row] = await tx`select value from mam_kv where key = ${key}`;
      const arr = Array.isArray(row?.value) ? row.value : [];
      for (const item of [].concat(items)) {
        const cur = arr.find((r) => r?.id === item.id);
        if (cur) Object.assign(cur, item); else arr.unshift(item);
      }
      arr.length = Math.min(arr.length, max);
      await tx`insert into mam_kv (key, value) values (${key}, ${tx.json(arr)})
        on conflict (key) do update set value = excluded.value, expires_at = null`;
      await bump(tx, verKey(key));
      return arr.length;
    });
  },

  // Écrit value seulement si la version de key vaut toujours expected (lue juste avant) ; renvoie la nouvelle
  // version, ou -1 si quelqu'un a écrit entre-temps.
  async casJSON(key, value, expected) {
    await ensureSchema();
    return db().begin(async (tx) => {
      await lockKey(tx, key);
      const [v] = await tx`select value from mam_kv where key = ${verKey(key)}`;
      if (String(Number(v?.value) || 0) !== String(Number(expected) || 0)) return -1;
      await tx`insert into mam_kv (key, value) values (${key}, ${tx.json(parse(value))})
        on conflict (key) do update set value = excluded.value, expires_at = null`;
      return bump(tx, verKey(key));
    });
  },

  // Plusieurs écritures conditionnelles d'un coup : pairs = [{ key, expected ('*' : sans contrôle), value
  // (undefined : inchangée) }]. Tout ou rien : renvoie false sans rien écrire si une version a bougé.
  async casMany(pairs) {
    await ensureSchema();
    return db().begin(async (tx) => {
      for (const p of [...pairs].sort((a, b) => a.key.localeCompare(b.key))) await lockKey(tx, p.key);
      for (const p of pairs) {
        if (p.expected === '*') continue;
        const [v] = await tx`select value from mam_kv where key = ${verKey(p.key)}`;
        if (String(v?.value ?? '') !== String(p.expected ?? '')) return false;
      }
      for (const p of pairs) {
        if (p.value === undefined) continue;
        await tx`insert into mam_kv (key, value) values (${p.key}, ${tx.json(parse(p.value))})
          on conflict (key) do update set value = excluded.value, expires_at = null`;
        await bump(tx, verKey(p.key));
      }
      return true;
    });
  },

  // Garde la plus grande valeur numérique (ne recule jamais).
  async setMax(key, value) {
    await ensureSchema();
    await db()`insert into mam_kv (key, value) values (${key}, to_jsonb(${Number(value)}::numeric))
      on conflict (key) do update set expires_at = null,
        value = to_jsonb(greatest(coalesce((mam_kv.value #>> '{}')::numeric, 0), ${Number(value)}::numeric))`;
    return 1;
  },

  // Ménage : valeurs expirées (appelé par la vérification toutes les 5 min).
  async purgeExpired() {
    await ensureSchema();
    const res = await db()`delete from mam_kv where expires_at is not null and expires_at <= now()`;
    return res.count;
  },
};

const verKey = (key) => `${key}:v`;
async function bump(tx, key) {
  const [row] = await tx`insert into mam_kv (key, value) values (${key}, '1'::jsonb)
    on conflict (key) do update set value = to_jsonb(coalesce((mam_kv.value #>> '{}')::numeric, 0) + 1), expires_at = null
    returning value`;
  return Number(row.value);
}
function slice(arr, start, stop) {
  const n = arr.length;
  const s = start < 0 ? Math.max(0, n + start) : Math.min(start, n);
  const e = stop < 0 ? n + stop : Math.min(stop, n - 1);
  return e < s ? [] : arr.slice(s, e + 1);
}

export function store() {
  return kv;
}

// ---------------------------------------------------------------- vérification toutes les 5 min (pg_cron)
// Supabase appelle lui-même /api/cron/check toutes les 5 minutes (extensions pg_cron et pg_net), avec un secret
// dérivé de SESSION_SECRET : rien à configurer. Programmé au premier lancement en production ; l'état est gardé dans
// mam:cron pour l'afficher dans les réglages.
export function cronSecret() {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update('my-aruba-manager:cron').digest('hex');
}

let cronDone;
export function ensureCron() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (cronDone || process.env.VERCEL_ENV !== 'production' || !host || !process.env.SESSION_SECRET) return cronDone;
  cronDone = (async () => {
    const url = `https://${host}/api/cron/check`;
    const sig = await kv.get('mam:cron');
    if (sig?.ok && sig.url === url && sig.v === 1) return sig; // déjà programmé à l'identique
    if (sig && !sig.ok && sig.url === url && Date.now() / 1000 - sig.t < 3600) return sig; // échec récent : nouvel essai dans 1 h
    let status;
    try {
      await db().unsafe('create extension if not exists pg_cron');
      await db().unsafe('create extension if not exists pg_net');
      const call = `select net.http_post(url := ${lit(url)}, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', ${lit(cronSecret())}), body := '{}'::jsonb)`;
      await db()`select cron.schedule('my-aruba-manager-check', '*/5 * * * *', ${call})`;
      status = { ok: true, url, v: 1, t: Math.round(Date.now() / 1000) };
    } catch (e) {
      status = { ok: false, url, v: 1, error: String(e.message || e).slice(0, 300), t: Math.round(Date.now() / 1000) };
      cronDone = null; // nouvel essai au prochain démarrage
    }
    await kv.set('mam:cron', status);
    return status;
  })().catch(() => { cronDone = null; });
  return cronDone;
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
