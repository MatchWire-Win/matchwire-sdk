/**
 * matchwire.win quickstart — live API, real key from the environment.
 *
 *   MATCHWIRE_API_KEY=mw_live_... node examples/quickstart.mjs
 */
import { Matchwire, MatchwireError } from 'matchwire.win';

const apiKey = process.env.MATCHWIRE_API_KEY;
if (!apiKey) {
  console.error('Set MATCHWIRE_API_KEY first — get one at https://matchwire.win/#pricing');
  process.exit(1);
}

const mw = new Matchwire({ apiKey });

try {
  console.log('matchwire.win quickstart — live API\n');

  const status = await mw.status();
  console.log('GET /api/v1/status');
  console.log('  stage                 :', status.stage ?? '—');
  console.log('  commit                :', status.commit ?? '—');
  console.log('  games in the store    :', status.store?.events);
  console.log('  listings              :', status.store?.listings);
  console.log('  bound listings        :', status.store?.bound);
  for (const entry of status.coverage ?? []) {
    console.log(`  ${entry.venue.padEnd(11)} open ${entry.open} · bound ${entry.bound}`);
  }

  const { sports, groups } = await mw.sports();
  console.log(`\nGET /api/v1/sports — ${sports.length} sports, ${groups?.length ?? 0} groups`);
  for (const sport of sports.slice(0, 6)) {
    console.log(`  ${sport.sport.padEnd(14)} ${String(sport.events).padStart(5)} games · ${sport.live} live`);
  }

  console.log('\nGET /api/v1/rows?sport=nfl&limit=5');
  const { rows, seq, full } = await mw.rows({ sport: 'nfl', limit: 5 });
  console.log(`  seq ${seq} (${full ? 'full' : 'delta'}) — ${rows.length} games`);
  for (const row of rows) {
    const venues = row.listings.map((l) => l.venue).join('+');
    const markets = row.markets?.length ?? 0;
    console.log(`  ${row.name}`);
    console.log(`    ${row.status ?? '—'} · ${row.start ?? '—'} · ${markets} markets · ${venues}`);
  }

  const multi = rows.find((r) => r.listings.length > 1);
  if (multi) {
    console.log('\nOne game, every venue that lists it:');
    console.log(' ', multi.id);
    for (const listing of multi.listings) {
      console.log(`    ${listing.venue.padEnd(11)} ${listing.marketId}  (${listing.tier ?? '—'})`);
      if (listing.request?.url) console.log(`      ${listing.request.method} ${listing.request.url}`);
    }
  }

  const tools = await mw.tools();
  console.log('\nMCP tools:', tools.map((t) => t.name).join(', '));

  console.log('\nDone. Docs: https://matchwire.win/docs/');
} catch (error) {
  if (error instanceof MatchwireError) {
    console.error(`failed: ${error.status} ${error.code} — ${error.message}`);
    if (error.isRateLimited) console.error(`retry after ${error.retryAfterMs}ms`);
    process.exit(1);
  }
  throw error;
}
