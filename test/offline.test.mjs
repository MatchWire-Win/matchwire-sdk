/**
 * Offline tests — no network. Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Matchwire, MatchwireError, VENUES, TYPES, STATUSES, DEFAULT_BASE_URL } from 'matchwire.win';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('exports the venue, type and status vocabularies', () => {
  assert.deepEqual([...VENUES], ['kalshi', 'poly', 'polyintl', 'predictfun']);
  assert.ok(TYPES.includes('winner') && TYPES.includes('total'));
  assert.deepEqual([...STATUSES], ['scheduled', 'live', 'ended']);
  assert.equal(DEFAULT_BASE_URL, 'https://api.matchwire.win');
});

test('a missing key fails fast, without a request', () => {
  assert.throws(() => new Matchwire({}), (error) => {
    assert.ok(error instanceof MatchwireError);
    assert.equal(error.code, 'invalid_argument');
    return true;
  });
});

test('rows() serialises filters, commas for lists, and the since delta', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ seq: 12, full: false, rows: [] }));
  const mw = new Matchwire({ apiKey: 'mw_test', fetch: fetchImpl });

  await mw.rows({ sport: ['nfl', 'nba'], venue: 'kalshi', type: 'winner,total', status: 'live', since: 7, limit: 5 });

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.matchwire.win/api/v1/rows');
  assert.equal(url.searchParams.get('sport'), 'nfl,nba');
  assert.equal(url.searchParams.get('venue'), 'kalshi');
  assert.equal(url.searchParams.get('type'), 'winner,total');
  assert.equal(url.searchParams.get('status'), 'live');
  assert.equal(url.searchParams.get('since'), '7');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(fetchImpl.calls[0].init.headers['x-api-key'], 'mw_test');
});

test('an unknown venue, type or status is rejected before the request', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({}));
  const mw = new Matchwire({ apiKey: 'mw_test', fetch: fetchImpl });

  assert.throws(() => mw.rows({ venue: 'betfair' }), /invalid venue/);
  assert.throws(() => mw.rows({ type: 'spread' }), /invalid type/);
  assert.throws(() => mw.rows({ status: 'open' }), /invalid status/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('401, 403 and 429 map to typed errors', async () => {
  const cases = [
    [401, { error: 'invalid_key' }, (e) => e.isAuthError],
    [403, { error: 'plan_lacks_sport' }, (e) => e.isPlanError],
    [429, { error: 'rate_limited', retry_after_ms: 2000 }, (e) => e.isRateLimited && e.retryAfterMs === 2000],
    [404, { error: 'not_found' }, (e) => e.isNotFound],
  ];

  for (const [status, body, check] of cases) {
    const mw = new Matchwire({ apiKey: 'mw_test', fetch: fakeFetch(() => jsonResponse(body, { status })) });
    await assert.rejects(() => mw.rows({}), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, body.error);
      assert.ok(check(error), `expected the ${status} predicate to hold`);
      assert.equal(error.isRetryable, status === 429);
      return true;
    });
  }
});

test('a transport failure becomes a network_error, not a crash', async () => {
  const mw = new Matchwire({
    apiKey: 'mw_test',
    fetch: async () => {
      throw new Error('socket hang up');
    },
  });
  await assert.rejects(() => mw.status(), (error) => {
    assert.equal(error.code, 'network_error');
    assert.equal(error.status, 0);
    assert.equal(error.isRetryable, true);
    return true;
  });
});

test('the MCP endpoint: SSE-framed JSON is unwrapped, get_row is a convenience', async () => {
  const frames = {
    'tools/list': { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'list_sports' }, { name: 'find_rows' }, { name: 'get_row' }] } },
    'tools/call': {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ row: { id: 'ev:nfl:a:b:2026-10-25', listings: [] } }) }] },
    },
  };

  const fetchImpl = fakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    const frame = `event: message\ndata: ${JSON.stringify(frames[body.method])}\n\n`;
    return jsonResponse(frame, { headers: { 'content-type': 'text/event-stream' } });
  });

  const mw = new Matchwire({ apiKey: 'mw_test', fetch: fetchImpl });
  const tools = await mw.tools();
  assert.deepEqual(tools.map((t) => t.name), ['list_sports', 'find_rows', 'get_row']);

  const row = await mw.row('ev:nfl:a:b:2026-10-25');
  assert.equal(row.id, 'ev:nfl:a:b:2026-10-25');
  assert.equal(fetchImpl.calls[1].init.method, 'POST');
  assert.match(fetchImpl.calls[1].url, /\/mcp$/);
});

test('an MCP tool error surfaces as a typed error', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unknown tool' } }),
  );
  const mw = new Matchwire({ apiKey: 'mw_test', fetch: fetchImpl });
  await assert.rejects(() => mw.callTool('nope', {}), /unknown tool/);
});

test('stream() yields parsed SSE frames and stops when the reader closes', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'event: hello\ndata: {"seq":5}\n\n',
    'event: rows\ndata: {"rows":[{"id":"a"}],"tombstones":[]}\n\n',
  ];
  let index = 0;

  const mw = new Matchwire({
    apiKey: 'mw_test',
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => (index < chunks.length ? { value: encoder.encode(chunks[index++]), done: false } : { done: true }),
          cancel: async () => {},
        }),
      },
    }),
  });

  const seen = [];
  for await (const frame of mw.stream({ since: 5 })) seen.push(frame);

  assert.equal(seen.length, 2);
  assert.equal(seen[0].event, 'hello');
  assert.equal(seen[0].data.seq, 5);
  assert.equal(seen[1].event, 'rows');
  assert.equal(seen[1].data.rows[0].id, 'a');
});
