// Fonctions d'administration : chacune est un module de ce dossier, branché sur les points d'entrée existants
// (offre Vercel gratuite : 12 fonctions au maximum, toutes déjà utilisées). Contrat de chaque module :
//   syncKeys / cronKeys : clés Redis lues en plus, dans la même commande MGET que le reste
//   onSync(ctx)    : à chaque envoi de l'agent    ctx = { r, state, vals, events, settings }
//   onResult(ctx)  : à chaque résultat de commande ctx = { r, id, output, status }
//   onCron(ctx)    : toutes les 5 min (QStash)    ctx = { r, now, state, settings, vals, events, enqueue }
//   wrapCommand(ctx) : avant la mise en file d'une commande administrateur, peut la compléter
//                    ctx = { r, id, cmd, kind, label, reasons, state } -> { cmd?, meta? } ou rien
//   actions[nom](ctx) : POST /api/settings { action: nom, ... } (administrateur)  ctx = { r, body, state, settings }
//   reads[nom](ctx)   : GET /api/output?part=nom   ctx = { r, role, query }
//   stateExtras : [{ name, key, viewer }] valeurs JSON renvoyées par /api/state quand leur version change
// Une erreur dans un module est journalisée et n'empêche jamais le reste de fonctionner.
import * as undo from './undo.js';
import * as backup from './backup.js';
import * as profiles from './profiles.js';
import * as devices from './devices.js';
import * as schedule from './schedule.js';

export const FEATURES = [undo, backup, profiles, devices, schedule];

const list = (name) => FEATURES.flatMap((f) => f[name] || []);

export const syncKeys = () => [...new Set(list('syncKeys'))];
export const cronKeys = () => [...new Set(list('cronKeys'))];
export const stateExtras = () => list('stateExtras');

export async function run(name, ctx) {
  for (const f of FEATURES) {
    if (typeof f[name] !== 'function') continue;
    try { await f[name](ctx); } catch (e) { console.error(`[${f.name || '?'}] ${name}`, e); }
  }
}

// Une commande peut être complétée par plusieurs modules (ex. point de restauration avant un changement).
export async function wrapCommand(ctx) {
  let { cmd } = ctx, meta = {};
  for (const f of FEATURES) {
    if (typeof f.wrapCommand !== 'function') continue;
    try {
      const out = await f.wrapCommand({ ...ctx, cmd });
      if (out?.cmd) cmd = out.cmd;
      if (out?.meta) meta = { ...meta, ...out.meta };
    } catch (e) { console.error(`[${f.name || '?'}] wrapCommand`, e); }
  }
  return { cmd, meta: Object.keys(meta).length ? meta : null };
}

export function findAction(name) {
  for (const f of FEATURES) if (f.actions && Object.hasOwn(f.actions, name)) return f.actions[name];
  return null;
}
export function findRead(name) {
  for (const f of FEATURES) if (f.reads && Object.hasOwn(f.reads, name)) return f.reads[name];
  return null;
}

// Erreur renvoyée au dashboard par une action ou une lecture : throw httpError(400, 'message').
export function httpError(status, error) {
  return Object.assign(new Error(error), { status, expose: true });
}
