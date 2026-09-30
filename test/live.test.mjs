/**
 * Live tests against api.matchwire.win. Skipped unless MATCHWIRE_API_KEY is set.
 *
 *   MATCHWIRE_API_KEY=mw_live_... node --test test/live.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Matchwire } from 'matchwire.win';

const apiKey = process.env.MATCHWIRE_API_KEY;
const skip = apiKey ? false : 'set MATCHWIRE_API_KEY to run live tests';

test('status reports the store and per-venue coverage', { skip }, async () => {
  const mw = new Matchwire({ apiKey });
  const status = await mw.status();
  assert.equal(status.service, 'crossmap');
  assert.ok(status.store.events > 0, 'games in the store');
  assert.ok(Array.isArray(status.coverage) && status.coverage.length > 0, 'coverage per venue');
});

test('sports lists games per sport and the group ids', { skip }, async () => {
  const mw = new Matchwire({ apiKey });
  const { sports, groups } = await mw.sports();
  assert.ok(sports.length > 0);
  assert.ok(sports.every((s) => typeof s.sport === 'string' && typeof s.events === 'number'));
  assert.ok(Array.isArray(groups) && groups.length > 0, 'groups are what sport= accepts');
});

test('rows returns mapped games with per-venue listings', { skip }, async () => {
  const mw = new Matchwire({ apiKey });
  const { rows, seq, full } = await mw.rows({ sport: 'nfl', limit: 10 });
  assert.ok(Number.isFinite(seq) && seq > 0);
  assert.equal(typeof full, 'boolean');
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row.id, /^ev:/);
    assert.ok(Array.isArray(row.listings));
    for (const listing of row.listings) assert.ok(listing.marketId, 'every listing names the venue market id');
  }
});

test('a delta since the current seq returns rows or tombstones, not an error', { skip }, async () => {
  const mw = new Matchwire({ apiKey });
  const { seq } = await mw.rows({ sport: 'nfl', limit: 1 });
  const delta = await mw.rows({ since: seq, limit: 10 });
  assert.ok(Array.isArray(delta.rows));
  assert.equal(delta.full, false);
});

test('row(id) fetches one game through the MCP get_row tool', { skip }, async () => {
  const mw = new Matchwire({ apiKey });
  const { rows } = await mw.rows({ sport: 'nfl', limit: 1 });
  const row = await mw.row(rows[0].id);
  assert.equal(row.id, rows[0].id);
  assert.ok(Array.isArray(row.listings));
});

test('the MCP endpoint advertises its five tools', { skip }, async () => {
  const mw = new Matchwire({ apiKey });
  const tools = await mw.tools();
  const names = tools.map((t) => t.name);
  for (const expected of ['list_sports', 'find_rows', 'get_row', 'get_venue_market', 'service_status']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('the SSE stream delivers at least one frame', { skip, timeout: 60_000 }, async () => {
  const mw = new Matchwire({ apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let frames = 0;
  try {
    for await (const frame of mw.stream({ since: 0, signal: controller.signal })) {
      assert.ok(typeof frame.event === 'string');
      frames += 1;
      controller.abort();
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }
  assert.ok(frames >= 1, 'the push endpoint sends at least one frame');
});

test('a bad key is a typed 401, not a silent empty result', async () => {
  const mw = new Matchwire({ apiKey: 'mw_definitely_not_a_key' });
  await assert.rejects(() => mw.rows({ sport: 'nfl' }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.isAuthError, true);
    return true;
  });
});
