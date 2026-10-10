// Profils de port : modèles (poste élève, imprimante, borne Wi-Fi…) que l'administrateur applique en un clic à un
// ou plusieurs ports (VLAN, description, protections, activation). La liste vit dans mam:profiles (administrateur
// seulement) ; null = profils par défaut, définis par la page (public/js/profiles.js).
// Coût Redis : rien par envoi de l'agent ni par lecture de l'état (la version est lue dans le MGET de /api/state,
// la valeur seulement quand elle change) ; 1 écriture atomique par enregistrement ou remise à zéro.
import { writeJSON } from '../db.js';
import { httpError } from './index.js';

export const name = 'profiles';
export const KEY = 'mam:profiles';
export const MAX_PROFILES = 20;
export const stateExtras = [{ name: 'profiles', key: KEY, viewer: false }];

const TRI = ['edge', 'bpduGuard', 'loopProtect', 'enable']; // true, false ou null (= ne pas toucher)
const TRI_FR = { edge: 'port de périphérie', bpduGuard: 'BPDU guard', loopProtect: 'loop-protect', enable: 'état du port' };

// Texte inséré dans une ligne de commande du switch : une seule ligne en ASCII imprimable, sans caractère de
// contrôle, sans « ? » (le switch afficherait son aide) ni « # » en tête (ligne réservée à l'agent), longueur bornée.
export function cliText(s, max = 64) {
  return String(s ?? '')
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u00ab\u00bb\u201c\u201d]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u0153/g, 'oe').replace(/\u0152/g, 'OE').replace(/\u00e6/g, 'ae').replace(/\u00c6/g, 'AE').replace(/\u00df/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ').replace(/\?/g, '')
    .replace(/\s+/g, ' ').trim().replace(/^[#\s]+/, '')
    .slice(0, max).trim();
}

// Nom affiché d'un profil (jamais envoyé au switch) : une ligne, sans caractère de contrôle.
const cleanName = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

// Vérifie et nettoie la liste envoyée par la page (on ne lui fait jamais confiance). Lève une erreur 400 lisible.
export function validateProfiles(list) {
  if (!Array.isArray(list)) throw httpError(400, 'Liste de profils invalide.');
  if (list.length > MAX_PROFILES) throw httpError(400, `${MAX_PROFILES} profils au maximum.`);
  const ids = new Set();
  return list.map((p, i) => {
    const where = `Profil n° ${i + 1}`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw httpError(400, `${where} : format invalide.`);
    if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,20}$/.test(p.id)) {
      throw httpError(400, `${where} : identifiant invalide (lettres minuscules, chiffres et tirets, 20 caractères max).`);
    }
    if (ids.has(p.id)) throw httpError(400, `${where} : identifiant « ${p.id} » utilisé deux fois.`);
    ids.add(p.id);
    if (typeof p.name !== 'string' || p.name.length > 200) throw httpError(400, `${where} : nom invalide.`);
    const name = cleanName(p.name);
    if (!name) throw httpError(400, `${where} : donne-lui un nom.`);
    if (name.length > 40) throw httpError(400, `${where} : nom trop long (40 caractères max).`);
    let vlan = null;
    if (p.vlan != null) {
      if (!Number.isInteger(p.vlan) || p.vlan < 1 || p.vlan > 4094) throw httpError(400, `Profil « ${name} » : VLAN invalide (1 à 4094).`);
      vlan = p.vlan;
    }
    let desc = null;
    if (p.desc != null) {
      if (typeof p.desc !== 'string') throw httpError(400, `Profil « ${name} » : description invalide.`);
      if (p.desc.length > 64) throw httpError(400, `Profil « ${name} » : description trop longue (64 caractères max).`);
      desc = cliText(p.desc, 64);
    }
    const out = { id: p.id, name, vlan, desc };
    for (const k of TRI) {
      const v = p[k] ?? null;
      if (v !== null && typeof v !== 'boolean') throw httpError(400, `Profil « ${name} » : valeur invalide pour ${TRI_FR[k]}.`);
      out[k] = v;
    }
    if (vlan === null && desc === null && TRI.every((k) => out[k] === null)) {
      throw httpError(400, `Le profil « ${name} » ne change rien : choisis au moins un réglage.`);
    }
    return out;
  });
}

export const actions = {
  // { profiles: [...] } : remplace toute la liste (0 à 20 profils).
  'profiles-save': async ({ body }) => {
    const profiles = validateProfiles(body?.profiles);
    await writeJSON(KEY, profiles);
    return { ok: true, profiles };
  },
  // Retour aux profils par défaut de la page.
  'profiles-reset': async () => {
    await writeJSON(KEY, null);
    return { ok: true, profiles: null };
  },
};
