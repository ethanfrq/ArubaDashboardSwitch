// Accès lecture seule (écran de monitoring) : seules les commandes automatiques du dashboard sont permises.

// Doit rester identique à DIAG_CMD dans public/index.html.
export const DIAG_LINES = ['show interface link-status', 'show spanning-tree', 'checkpoint diff startup-config running-config',
  'show logging -r -n 80', 'show ip interface vlan1', 'show system'];

export const isAutoKind = (kind) => /^(auto|probe)/.test(kind || '');

export function viewerCommandOk(cmd, kind, state) {
  const lines = String(cmd).split('\n').map((l) => l.trim());
  if (kind === 'auto:diag') return lines.join('\n') === DIAG_LINES.join('\n');
  // Test de câble automatique : au plus 4 ports cuivre sans lien, hors liens vers d'autres switches.
  if (kind !== 'auto:cable' || lines[0] !== 'diagnostics' || lines.length < 4 || lines.length > 13 || (lines.length - 1) % 3) return false;
  for (let i = 1; i < lines.length; i += 3) {
    const m = lines[i].match(/^diag cable-diagnostic test (1\/1\/\d+)$/);
    const p = m && (state?.ports || []).find((x) => x.port === m[1]);
    if (!p || p.up || !p.enabled || p.type !== '1GbT' || p.uplink) return false;
    if (lines[i + 1] !== 'y' || lines[i + 2] !== `diag cable-diagnostic show ${m[1]}`) return false;
  }
  return true;
}

// Sortie d'un relevé pour un écran lecture seule : le détail des différences de configuration est masqué.
export function redactOutput(out) {
  if (typeof out !== 'string') return out;
  return out.replace(/(» checkpoint diff[^\n]*\n)([\s\S]*?)(?=\n» |$)/, (m, head, body) =>
    head + (/No difference/i.test(body) ? 'No difference' : '+ (différences masquées en lecture seule)'))
    .replace(/(» show running-config[^\n]*\n)([\s\S]*?)(?=\n» |$)/g, (m, head) => head + '(configuration masquée en lecture seule)');
}

// Technicien : agit sur les ports d'accès, jamais sur les liens vers d'autres switches ni sur la configuration
// générale. Commandes permises, vérifiées ligne par ligne :
//   - relevés automatiques et lectures (« show … »), sauvegarde « write memory » ;
//   - actions de l'agent (« #wol », « #ping ») ;
//   - test de câble d'un port cuivre ;
//   - par port : activer, couper, redémarrer, description, VLAN d'accès existant.
export function techCommandOk(cmd, kind, state) {
  if (viewerCommandOk(cmd, kind, state)) return true;
  const lines = String(cmd).split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (!lines.length) return false;
  const ports = state?.ports || [];
  const access = (name) => { const p = ports.find((x) => x.port === name); return p && !p.uplink ? p : null; };
  if (lines.every((l) => /^show [\w .:/|-]{1,100}$/.test(l))) return true;
  if (lines.length === 1 && lines[0] === 'write memory') return true;
  if (lines.every((l) => l.startsWith('#'))) return true; // contrôlées ensuite par api/command.js
  if (lines[0] === 'diagnostics') {
    if (lines.length < 4 || (lines.length - 1) % 3) return false;
    for (let i = 1; i < lines.length; i += 3) {
      const m = lines[i].match(/^diag cable-diagnostic test (1\/1\/\d{1,2})$/);
      const p = m && access(m[1]);
      if (!p || p.type !== '1GbT' || lines[i + 1] !== 'y' || lines[i + 2] !== `diag cable-diagnostic show ${m[1]}`) return false;
    }
    return true;
  }
  if (lines[0] !== 'configure terminal' || lines.at(-1) !== 'end' || lines.length < 4) return false;
  const vlans = new Set((state?.vlans || []).map((v) => String(v.id)));
  let cur = null;
  for (const l of lines.slice(1, -1)) {
    const itf = l.match(/^interface (1\/1\/\d{1,2})$/);
    if (itf) { if (!access(itf[1])) return false; cur = itf[1]; continue; }
    if (!cur) return false;
    if (l === 'exit') { cur = null; continue; }
    if (l === 'shutdown' || l === 'no shutdown' || l === 'no description') continue;
    if (/^description .{1,64}$/.test(l)) continue;
    const v = l.match(/^vlan access (\d{1,4})$/);
    if (v && vlans.has(v[1])) continue;
    return false;
  }
  return true;
}
