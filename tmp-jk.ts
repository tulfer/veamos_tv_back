import { scrapeJkanimeTopAnime, scrapeJkanimeSchedule } from './src/providers/jkanime';

async function main() {
  const top = await scrapeJkanimeTopAnime();
  console.log('=== top: ' + top.length);
  for (const t of top.slice(0, 12)) console.log(' ', t.id, '|', t.title, '| order:', t.order, '| rating:', t.rating ?? '-');
  const sched = await scrapeJkanimeSchedule();
  console.log('=== programación: ' + sched.length);
  for (const s of sched.slice(0, 5)) console.log(' ', s.id, '|', s.title, '| poster:', (s.poster || '').slice(0, 60));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });