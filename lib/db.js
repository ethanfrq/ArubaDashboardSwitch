import { store } from './store.js';

// Clés des données (table mam_kv de Supabase ; préfixe mam: pour My Aruba Manager).
export { store };

export const K = {
  state: 'mam:state',
  log: 'mam:log',          // métadonnées des 40 dernières commandes (JSON)
  out: (id) => `mam:out:${id}`,
  queue: 'mam:queue',
  qflag: 'mam:qflag',      // présent quand la file contient quelque chose
  hot: 'mam:hot',          // présent tant que quelqu'un regarde le dashboard
  answer: (id) => `mam:answer:${id}`,
  settings: 'mam:settings',
  sver: 'mam:sver',
  alerts: 'mam:alerts',    // 60 dernières alertes (JSON)
  offline: 'mam:offline',  // alerte « agent hors ligne » déjà envoyée
  hist: (r) => `mam:h:${r}`,
  tries: (ip) => `mam:login:${ip}`,
  confirm: (token) => `mam:confirm:${token}`, // seconde confirmation d'une commande dangereuse
  viewer: 'mam:viewer',    // mot de passe lecture seule (haché) et sa version
  diag: 'mam:diag',        // relevé détaillé envoyé par l'agent (seulement quand il change)
  warm: 'mam:warm',        // présent tant qu'un écran lecture seule regarde : l'agent envoie toutes les 30 s
  busy: 'mam:busy',        // commande récente : l'agent relève la file toutes les 1,5 s au lieu de 5 s
  ver: (key) => `${key}:v`,  // version d'une liste (journal, alertes), incrémentée à chaque modification
};

// Commandes gardées dans le journal (les relevés automatiques du dashboard y comptent aussi).
export const LOG_MAX = 80;

export const HIST = { m5: 288, m30: 336, h2: 372 }; // 24 h, 7 j, 31 j

// Écrit une valeur JSON et incrémente sa version (le dashboard ne la relit que si elle change).
export function writeJSON(key, value) {
  return store().writeJSON(key, value);
}

// Insère ou met à jour (par id) des éléments d'une liste JSON bornée, de façon atomique ; la version permet au
// dashboard de ne relire la liste que lorsqu'elle a changé.
export function upsert(key, items, max) {
  return store().upsertList(key, items, max);
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
  return mergeSettings(await store().get(K.settings));
}
