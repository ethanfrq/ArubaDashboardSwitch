// Détection des commandes dangereuses : elles exigent une seconde confirmation côté serveur.

const RULES = [
  [/^reload\b/i, 'Redémarre le switch : tout le réseau est coupé pendant plusieurs minutes.'],
  [/^boot\b/i, 'Modifie le démarrage du switch (image système ou redémarrage).'],
  // effacer un point de restauration (« erase checkpoint <nom> ») ne touche pas la configuration
  [/^(erase|zeroize)\b(?!\s+checkpoint\s+[A-Za-z0-9-]{1,32}\s*$)|^write\s+erase\b/i, 'Efface la configuration ou le stockage du switch.'],
  // copie VERS la configuration active ou de démarrage (copier la configuration vers un point de restauration est sans risque)
  [/^copy\b.*\s(startup|running)-config(\s+vrf\s+\S+)?\s*$/i, 'Remplace une configuration complète du switch.'],
  [/^checkpoint\s+rollback\b/i, 'Restaure une ancienne configuration du switch.'],
  [/^checkpoint\s+auto\s+\d/i, 'Active l’annulation automatique des changements si elle n’est pas confirmée à temps.'],
  [/^(no\s+)?user\s+\S+/i, 'Modifie un compte administrateur du switch.'],
  [/^(no\s+)?aaa\b/i, 'Modifie l’authentification des administrateurs.'],
  [/^no\s+(ssh|https-server)\b|^(ssh|https-server)\b.*\bdisable\b/i, 'Coupe un accès d’administration (SSH ou web) : l’agent pourrait ne plus joindre le switch.'],
  // « no spanning-tree » seul (global) ; « no spanning-tree bpdu-guard » sur un port n'est pas concerné
  [/^no\s+spanning-tree\s*$|^spanning-tree\b.*\bdisable\b/i, 'Désactive le spanning-tree : risque de boucle et de coupure du réseau.'],
  [/^no\s+interface\b/i, 'Supprime une interface du switch.'],
  [/^(no\s+)?(vrf|lag)\b/i, 'Modifie le routage (VRF) ou l’agrégation de liens.'],
  [/^(no\s+)?ip\s+route\b/i, 'Modifie le routage du switch.'],
];

const portNum = (p) => Number(String(p).split('/').pop());

// AOS-CX accepte toute abréviation sans ambiguïté dans son contexte (« int 1/1/24 », « shu », « relo », « diag cab te »…) :
// chaque mot est remis sous sa forme complète avant d'appliquer les règles, sinon une commande abrégée échapperait à la
// double confirmation. Un mot qui peut désigner plusieurs mots-clés de la liste (« te » : terminal ou test) donne
// plusieurs lectures : la ligne est sensible si l'une d'elles l'est (prudence, le contexte du switch peut lever l'ambiguïté).
const KEYWORDS = ['aaa', 'access', 'address', 'admin-edge', 'all', 'allowed', 'auto', 'boot', 'bpdu-guard', 'cable-diagnostic',
  'checkpoint', 'configure', 'copy', 'description', 'dhcp', 'diag', 'diagnostics', 'disable', 'end', 'erase', 'exit',
  'https-server', 'interface', 'ip', 'lag', 'loop-protect', 'memory', 'name', 'native', 'no', 'port-type', 'reload',
  'rollback', 'route', 'running-config', 'show', 'shutdown', 'spanning-tree', 'ssh', 'startup-config', 'terminal', 'test',
  'trunk', 'user', 'vlan', 'vrf', 'write', 'zeroize'];
function variants(line) {
  let out = [''];
  for (const w of line.split(/\s+/)) {
    const lw = w.toLowerCase();
    const hit = KEYWORDS.includes(lw) ? [lw] : lw.length >= 2 && /^[a-z]/.test(lw) ? KEYWORDS.filter((k) => k.startsWith(lw)) : [];
    const opts = hit.length ? hit : [w];
    out = out.flatMap((o) => opts.map((x) => (o ? `${o} ${x}` : x))).slice(0, 32);
  }
  return out;
}

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
    if (!raw.trim()) continue;
    const lines = variants(raw.trim());
    for (const line of lines) for (const [re, why] of RULES) if (re.test(line)) reasons.add(why);
    let m;
    const vl = lines.find((l) => /^interface\s+vlan\s*\d+/i.test(l));
    if (vl) { ctx = { vlan: Number(vl.match(/^interface\s+vlan\s*(\d+)/i)[1]) }; continue; }
    const il = lines.find((l) => /^interface\s+\S+/i.test(l));
    if (il) { ctx = { ports: expand(il.match(/^interface\s+(\S+)/i)[1]) }; continue; }
    if (lines.some((l) => /^(exit|end|configure(\s+terminal)?)$/i.test(l))) { ctx = null; continue; }
    for (const line of lines) {
    if (ctx?.vlan != null && /^(no\s+)?ip\s+(address|dhcp)\b/i.test(line)) reasons.add('Change l’IP de gestion du switch : l’agent et le dashboard pourraient ne plus le joindre.');
    if (ctx?.ports && /^(shutdown|vlan\s+(access|trunk)\b|no\s+vlan\b)/i.test(line)) {
      for (const p of ctx.ports) {
        touched.add(p);
        const s = sensitive.get(p);
        if (s) reasons.add(`Le port ${portNum(p)} ${s.what}. S’il est coupé ou change de VLAN, ${s.effect}.`);
      }
    }
    // protections de port de périphérie (BPDU guard, admin-edge, loop-protect) sur un lien vers un autre switch :
    // le switch voisin envoie des BPDU, le port serait coupé
    if (ctx?.ports && /^(spanning-tree\s+(bpdu-guard|port-type\s+admin-edge)|loop-protect)\b/i.test(line)) {
      for (const p of ctx.ports) {
        const s = sensitive.get(p);
        if (s) reasons.add(`Le port ${portNum(p)} ${s.what}. Une protection réservée aux postes (BPDU guard, admin-edge, loop-protect) pourrait le couper : ${s.effect}.`);
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
  }
  if (touched.size >= 8) reasons.add(`Modifie ${touched.size} ports d’un coup.`);
  return [...reasons];
}
