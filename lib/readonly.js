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
