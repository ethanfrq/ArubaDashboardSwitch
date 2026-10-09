// Détection des commandes dangereuses : elles exigent une seconde confirmation côté serveur.

const RULES = [
  [/^reload\b/i, 'Redémarre le switch : tout le réseau est coupé pendant plusieurs minutes.'],
  [/^boot\b/i, 'Modifie le démarrage du switch (image système ou redémarrage).'],
  [/^(erase|zeroize)\b|^write\s+erase\b/i, 'Efface la configuration ou le stockage du switch.'],
  [/^copy\b.*\b(startup|running)-config\b/i, 'Remplace une configuration complète du switch.'],
  [/^checkpoint\s+(rollback|auto)\b/i, 'Restaure une ancienne configuration du switch.'],
  [/^(no\s+)?user\s+\S+/i, 'Modifie un compte administrateur du switch.'],
  [/^(no\s+)?aaa\b/i, 'Modifie l’authentification des administrateurs.'],
  [/^no\s+(ssh|https-server)\b|^(ssh|https-server)\b.*\bdisable\b/i, 'Coupe un accès d’administration (SSH ou web) : l’agent pourrait ne plus joindre le switch.'],
  [/^no\s+spanning-tree\b|^spanning-tree\b.*\bdisable\b/i, 'Désactive le spanning-tree : risque de boucle et de coupure du réseau.'],
  [/^no\s+interface\b/i, 'Supprime une interface du switch.'],
  [/^(no\s+)?(vrf|lag)\b/i, 'Modifie le routage (VRF) ou l’agrégation de liens.'],
  [/^(no\s+)?ip\s+route\b/i, 'Modifie le routage du switch.'],
];

const portNum = (p) => Number(String(p).split('/').pop());

// Développe « 1/1/3-1/1/8,1/1/12 » en liste de ports.
function expand(list) {
  const out = [];
  for (const part of String(list).split(',')) {
    const m = part.trim().match(/^1\/1\/(\d+)(?:-(?:1\/1\/)?(\d+))?$/);
    if (!m) continue;
    for (let n = Number(m[1]); n <= Number(m[2] || m[1]); n++) out.push(`1/1/${n}`);
  }
  return out;
}

// Ports à protéger : liens vers d'autres switches et port du PC qui fait tourner l'agent.
function sensitivePorts(state) {
  const res = new Map();
  const lldp = state?.lldp || [];
  for (const p of state?.ports || []) {
    if (p.uplink || lldp.some((l) => l.port === p.port && l.name && /\d{4}|aruba|switch/i.test(l.name))) {
      res.set(p.port, { what: 'relie un autre switch', effect: 'tout ce qui passe par lui serait coupé' });
    }
  }
  const host = String(state?.agent?.host || '').split('.')[0].toLowerCase();
  if (host) for (const l of lldp) {
    if (String(l.chassis || '').toLowerCase() === host || String(l.name || '').toLowerCase() === host) {
      res.set(l.port, { what: 'est celui du PC de l’agent', effect: 'le dashboard perdrait le contact avec le switch' });
    }
  }
  return res;
}

export function analyze(cmd, state) {
  const reasons = new Set();
  const sensitive = sensitivePorts(state);
  let ctx = null; // interface en cours de configuration
  const touched = new Set(); // ports coupés ou changés de VLAN par cette commande
  for (const raw of String(cmd).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    for (const [re, why] of RULES) if (re.test(line)) reasons.add(why);
    let m;
    if ((m = line.match(/^interface\s+vlan\s*(\d+)/i))) { ctx = { vlan: Number(m[1]) }; continue; }
    if ((m = line.match(/^interface\s+(\S+)/i))) { ctx = { ports: expand(m[1]) }; continue; }
    if (/^(exit|end|configure(\s+terminal)?)$/i.test(line)) { ctx = null; continue; }
    if (ctx?.vlan != null && /^(no\s+)?ip\s+(address|dhcp)\b/i.test(line)) reasons.add('Change l’IP de gestion du switch : l’agent et le dashboard pourraient ne plus le joindre.');
    if (ctx?.ports && /^(shutdown|vlan\s+(access|trunk)\b|no\s+vlan\b)/i.test(line)) {
      for (const p of ctx.ports) {
        touched.add(p);
        const s = sensitive.get(p);
        if (s) reasons.add(`Le port ${portNum(p)} ${s.what}. S’il est coupé ou change de VLAN, ${s.effect}.`);
      }
    }
    if ((m = line.match(/^diag\s+cable-diagnostic\s+test\s+(\S+)/i))) {
      for (const p of expand(m[1])) {
        const s = sensitive.get(p);
        if (s) reasons.add(`Le port ${portNum(p)} ${s.what}. Le test coupe le lien 5 à 10 secondes : ${s.effect} pendant ce temps.`);
      }
    }
    if ((m = line.match(/^no\s+vlan\s+(\d+)/i)) && !ctx) {
      const used = (state?.ports || []).filter((p) => p.vlan === m[1] && p.mode === 'access').map((p) => portNum(p.port));
      if (used.length) reasons.add(`Supprime le VLAN ${m[1]} utilisé par les ports ${used.join(', ')} : ces appareils changeront de réseau.`);
    }
  }
  if (touched.size >= 8) reasons.add(`Modifie ${touched.size} ports d’un coup.`);
  return [...reasons];
}
