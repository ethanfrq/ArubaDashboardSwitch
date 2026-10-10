import crypto from 'node:crypto';
import { redis, K, upsert, LOG_MAX } from '../lib/redis.js';
import { enqueue } from '../lib/queue.js';
import { wrapCommand } from '../lib/features/index.js';
import { requireSession } from '../lib/auth.js';
import { analyze } from '../lib/danger.js';
import { viewerCommandOk } from '../lib/readonly.js';

export default async function handler(req, res) {
  const s = await requireSession(req, res);
  if (!s) return;
  if (req.method !== 'POST') return res.status(405).end();
  const r = redis();
  const admin = s.role === 'admin';
  const denied = () => res.status(403).json({ error: 'Accès en lecture seule : action réservée à l’administrateur.' });

  // Réponse à une question oui/non posée par le switch.
  if (req.body?.answer_to) {
    if (!admin) return denied();
    const answer = req.body.answer === 'y' ? 'y' : 'n';
    await r.set(K.answer(String(req.body.answer_to)), answer, { ex: 180 });
    await r.set(K.busy, 1, { ex: 90 });
    await upsert(K.log, { id: String(req.body.answer_to), status: 'running', answer }, LOG_MAX);
    return res.json({ ok: true });
  }

  const cmd = String(req.body?.cmd ?? '').trim();
  if (!cmd) return res.status(400).json({ error: 'Commande vide.' });
  if (cmd.length > 8000) return res.status(400).json({ error: 'Commande trop longue.' });
  // Tabulation (complétion), effacement, Ctrl-U… seraient interprétés par le terminal du switch et fausseraient
  // l'analyse des commandes sensibles : seuls les retours à la ligne séparent les lignes.
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(cmd.replace(/\r\n/g, '\n'))) {
    return res.status(400).json({ error: 'Caractère spécial interdit dans la commande (tabulation, effacement…).' });
  }
  const kind = String(req.body?.kind ?? '').slice(0, 40);
  const state = await r.get(K.state);
  // Lecture seule : uniquement les relevés automatiques du dashboard, vérifiés ligne par ligne.
  if (!admin && !viewerCommandOk(cmd, kind, state)) return denied();
  // Lignes « # » : actions faites par l'agent lui-même (allumer un PC, ping), arguments strictement contrôlés.
  const bad = cmd.split('\n').map((l) => l.trim()).find((l) => l.startsWith('#') && !AGENT_LINE.test(l));
  if (bad) return res.status(400).json({ error: `Action d’agent inconnue : ${bad.slice(0, 60)}` });
  // Un agent plus ancien enverrait ces lignes telles quelles au switch.
  const caps = Array.isArray(state?.agent?.caps) ? state.agent.caps : [];
  const need = cmd.split('\n').map((l) => l.trim().match(/^#(\w+)/)?.[1]?.toLowerCase()).filter(Boolean);
  if (need.some((c) => !caps.includes(c))) return res.status(409).json({ error: 'L’agent installé sur le PC est trop ancien pour cette action (agent 1.4.0 ou plus).' });
  // Relevés automatiques : un seul à la fois, même avec plusieurs pages ouvertes.
  if (kind.startsWith('auto:')) {
    const now = Date.now() / 1000;
    const same = [].concat((await r.get(K.log)) || []).find((c) => c.kind === kind && ['pending', 'running'].includes(c.status) && now - c.created < 180);
    if (same) return res.json({ ...same, dedup: true });
  }
  // Commande dangereuse : refus tant qu'elle n'a pas été confirmée une seconde fois (jeton à usage unique).
  const reasons = analyze(cmd, state);
  if (reasons.length) {
    const hash = crypto.createHash('sha256').update(cmd).digest('hex');
    const token = req.body?.danger_token ? String(req.body.danger_token) : null;
    const ok = token && req.body?.confirm === 'CONFIRMER' && (await r.getdel(K.confirm(token))) === hash;
    if (!ok) {
      const fresh = crypto.randomUUID();
      await r.set(K.confirm(fresh), hash, { ex: 120 });
      return res.status(409).json({ danger: true, reasons, token: fresh, error: 'Commande sensible : seconde confirmation requise.' });
    }
  }

  // Les fonctions d'administration peuvent compléter la commande (ex. point de restauration avant un changement).
  const id = crypto.randomUUID(), label = String(req.body?.label ?? '');
  const wrapped = admin ? await wrapCommand({ r, id, cmd, kind, label, reasons, state }) : { cmd, meta: null };
  res.json(await enqueue({ id, cmd: wrapped.cmd, label, kind, meta: wrapped.meta, realtime: admin }));
}

const MAC = '[0-9a-f]{2}(?::[0-9a-f]{2}){5}';
const AGENT_LINE = new RegExp(`^#(wol( ${MAC}){1,64}|ping \\d{1,3}(\\.\\d{1,3}){3})$`, 'i');
