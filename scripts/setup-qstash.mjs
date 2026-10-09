// Crée (ou recrée) la planification QStash qui appelle /api/cron/check toutes les 5 minutes.
// Usage : DASHBOARD_URL=https://mon-projet.vercel.app node --env-file=.env.local scripts/setup-qstash.mjs
import { Client } from '@upstash/qstash';

const base = process.env.DASHBOARD_URL;
if (!base) throw new Error('Définis DASHBOARD_URL (URL de production du dashboard).');
const destination = `${base.replace(/\/$/, '')}/api/cron/check`;
const client = new Client({ token: process.env.QSTASH_TOKEN, baseUrl: process.env.QSTASH_URL });

for (const s of await client.schedules.list()) {
  if (s.destination === destination) await client.schedules.delete(s.scheduleId);
}
const { scheduleId } = await client.schedules.create({
  destination, cron: '*/5 * * * *', retries: 1, body: '{}', headers: { 'Content-Type': 'application/json' },
});
console.log(`Planification ${scheduleId} : ${destination} toutes les 5 min`);
