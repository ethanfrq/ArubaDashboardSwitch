import { Redis } from '@upstash/redis';

let client;

// Variables injectées par l'intégration Upstash du Marketplace Vercel.
export function redis() {
  if (!client) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('Base Redis non connectée au projet');
    client = new Redis({ url, token });
  }
  return client;
}

export const K = {
  state: 'aruba:state',
  log: 'aruba:log',          // métadonnées des 40 dernières commandes (JSON)
  out: (id) => `aruba:out:${id}`,
  queue: 'aruba:queue',
  qflag: 'aruba:qflag',      // présent quand la file contient quelque chose
  hot: 'aruba:hot',          // présent tant que quelqu'un regarde le dashboard
  answer: (id) => `aruba:answer:${id}`,
  settings: 'aruba:settings',
  sver: 'aruba:sver',
  alerts: 'aruba:alerts',    // 60 dernières alertes (JSON)
  offline: 'aruba:offline',  // alerte « agent hors ligne » déjà envoyée
  hist: (r) => `aruba:h:${r}`,
  tries: (ip) => `aruba:login:${ip}`,
  confirm: (token) => `aruba:confirm:${token}`, // seconde confirmation d'une commande dangereuse
  viewer: 'aruba:viewer',    // mot de passe lecture seule (haché) et sa version
  diag: 'aruba:diag',        // relevé détaillé envoyé par l'agent (seulement quand il change)
  warm: 'aruba:warm',        // présent tant qu'un écran lecture seule regarde : l'agent envoie toutes les 30 s
  busy: 'aruba:busy',        // commande récente : l'agent relève la file toutes les 1,5 s au lieu de 5 s
  ver: (key) => `${key}:v`,  // version d'une liste (journal, alertes), incrémentée à chaque modification
};

// Commandes gardées dans le journal (les relevés automatiques du dashboard y comptent aussi).
export const LOG_MAX = 80;

export const HIST = { m5: 288, m30: 336, h2: 372 }; // 24 h, 7 j, 31 j

// Insère ou met à jour (par id) un élément d'une liste JSON, de façon atomique.
const UPSERT = `
local raw = redis.call('GET', KEYS[1])
local arr = {}
if raw then arr = cjson.decode(raw) end
local max = tonumber(ARGV[2])
for _, item in ipairs(cjson.decode(ARGV[1])) do
  local found = false
  for _, r in ipairs(arr) do
    if r.id == item.id then
      for k, v in pairs(item) do r[k] = v end
      found = true
      break
    end
  end
  if not found then table.insert(arr, 1, item) end
end
while #arr > max do table.remove(arr) end
redis.call('SET', KEYS[1], cjson.encode(arr))
redis.call('INCR', KEYS[2])
return #arr`;

// Écrit une valeur JSON et incrémente sa version en une seule commande (le dashboard ne la relit que si elle change).
const WRITE_JSON = `redis.call('SET', KEYS[1], ARGV[1])
return redis.call('INCR', KEYS[2])`;
export function writeJSON(key, value) {
  return redis().eval(WRITE_JSON, [key, K.ver(key)], [JSON.stringify(value)]);
}

// La version permet au dashboard de ne relire la liste que lorsqu'elle a changé.
export function upsert(key, items, max) {
  return redis().eval(UPSERT, [key, K.ver(key)], [JSON.stringify([].concat(items)), String(max)]);
}

export const DEFAULT_SETTINGS = {
  email: '',
  webhook: '',
  watchPorts: null, // null : liens vers d'autres switches + ports avec une description
  tempMax: 70,
  notify: { portDown: true, temp: true, agentOffline: true, slowLink: false, idleLink: false, newDevice: false },
  autoCable: true, // test automatique des câbles sur les ports sans lien
  siteName: '',    // nom du site, affiché dans l'onglet et en haut de page
  tz: 'Europe/Paris', // fuseau horaire des actions planifiées
  agent: { hot: 10, warm: 30, idle: 60 }, // rythme d'envoi de l'agent (s), appliqué par l'agent 1.4.0 et plus
};

export function mergeSettings(s) {
  return { ...DEFAULT_SETTINGS, ...(s || {}), notify: { ...DEFAULT_SETTINGS.notify, ...(s?.notify || {}) },
    agent: { ...DEFAULT_SETTINGS.agent, ...(s?.agent || {}) } };
}
export async function getSettings() {
  return mergeSettings(await redis().get(K.settings));
}
