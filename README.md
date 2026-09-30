<img src="docs/logo.png" alt="matchwire.win" width="72" align="right">

# matchwire.win

**Mapped prediction-market data for Node.js and Python.** One client, no dependencies: `matchwire.win` returns **one row per game**, matched across **Kalshi, Polymarket US, Polymarket International and Predict.fun**, with each venue's own market id left intact — the pieces you need to compare a Kalshi API market with its Polymarket API twin without owning a reconciliation job.

Market types are matched too: winners, spreads and handicaps, totals and props. The line is part of the match, so `over 45.5` is never confused with `over 48.5`.

**Mapping only — no prices, no order books.** Prices come from each venue; this library tells you which market on which venue is the same game.

```js
import { Matchwire } from 'matchwire.win';

const mw = new Matchwire({ apiKey: process.env.MATCHWIRE_API_KEY });

const { rows, seq } = await mw.rows({ sport: 'nfl', venue: ['kalshi', 'poly'] });
const game = rows.find((r) => r.listings.length > 1);
console.log(game.name, game.listings.map((l) => `${l.venue}:${l.marketId}`));
```

<!-- Verified against the live API on 2026-09-30. -->

- **Zero dependencies.** One `src/` directory on the global `fetch`. Nothing installs alongside it.
- **Node.js 18+**, ESM and CommonJS, hand-written TypeScript declarations.
- **Typed errors** — a `429` is distinguishable from a `401 invalid_key` in code, not by string matching.
- **Deltas and streaming** — `since=<seq>` for changed rows and tombstones, or the same updates over SSE.
- **MCP included** — the same tools an AI agent gets from `https://api.matchwire.win/mcp`.
- MIT licensed.

## Install

```bash
npm install matchwire.win      # Node.js — zero dependencies
pip install matchwire.win      # Python 3.9+ — standard library only
```

Get a key at **[matchwire.win](https://matchwire.win/#pricing)** — plans start at $99/month with a 14-day trial on Starter.

## Quickstart

Save as `quickstart.mjs` and run `node quickstart.mjs` (Needs `MATCHWIRE_API_KEY` in the environment):

```js
import { Matchwire } from 'matchwire.win';

const mw = new Matchwire({ apiKey: process.env.MATCHWIRE_API_KEY });

const status = await mw.status();
console.log(`${status.store.events} games, ${status.store.bound} bound listings`);

const { sports } = await mw.sports();
console.log(sports.slice(0, 5).map((s) => `${s.sport} ${s.events}`));

const { rows } = await mw.rows({ sport: 'nfl', limit: 3 });
for (const row of rows) {
  console.log(row.name, row.status, row.listings.map((l) => l.venue).join('+'));
}
```

The repository ships the same thing with formatting and error handling: `node examples/quickstart.mjs`.

## API

| Method | Endpoint | Returns |
| --- | --- | --- |
| `status()` | `GET /api/v1/status` | Service and per-venue health, current `seq`, coverage counts |
| `sports()` | `GET /api/v1/sports` | Sports with game counts, plus group ids (`esports`, `american-football`, …) |
| `rows(params)` | `GET /api/v1/rows` | One row per game with its per-venue listings |
| `row(id)` | MCP `get_row` | One game by its mapped id |
| `stream(params)` | `GET /api/v1/push` | The same updates as Server-Sent Events |
| `callTool(name, args)` | `POST /mcp` | Any tool the MCP endpoint advertises |
| `tools()` | `POST /mcp` | The tool list the endpoint advertises |

### Filters

`sport`, `venue`, `type`, `league`, `status` accept a value or a comma list; they combine. `since=<seq>` switches to a delta (changed rows plus `tombstones`).

- `venue=` `kalshi` · `poly` (Polymarket US) · `polyintl` (Polymarket International) · `predictfun`
- `type=` `winner` · `total` · `handicap` · `map_winner` · `score` · `event`
- `status=` `scheduled` · `live` · `ended`
- `sport=` a sport name (`baseball`, not `mlb`) or a group id from `sports()`

```js
// Everything that changed since the last call, plus tombstones for pruned games.
let seq = 0;
const first = await mw.rows({ sport: 'esports', limit: 5000 });
seq = first.seq;

const delta = await mw.rows({ since: seq });
console.log(delta.rows.length, 'changed', delta.tombstones?.length ?? 0, 'gone');

// Stream instead of polling.
for await (const frame of mw.stream({ since: seq })) {
  console.log(frame.event, frame.data.rows?.length);
  if (Date.now() - started > 10_000) break;   // or AbortController
}
```

### Mapping, not prices

Every listing carries the venue's own `marketId`, a `tier` (`exact`, `normalized`, `fuzzy`) and a `confidence`, plus the exact request that reads that market from the venue. Use the mapped row to decide *what* to compare, then read the prices from each venue with the source you already have.

### Agents and MCP

`POST https://api.matchwire.win/mcp` speaks JSON-RPC 2.0 with your key in the same `x-api-key` header. Tools: `list_sports`, `find_rows`, `get_row`, `get_venue_market`, `report_issue`, `service_status`. Read-only; every tool result is narrowed by your key's plan exactly like the HTTP API.

```js
import { Matchwire } from 'matchwire.win';
const mw = new Matchwire({ apiKey: process.env.MATCHWIRE_API_KEY });

console.log((await mw.tools()).map((t) => t.name));
const row = await mw.row('ev:nfl:arizona-cardinals:denver-broncos:2026-10-25');
console.log(row.listings.map((l) => l.venue));
```

Plain text for coding assistants: **[matchwire.win/llms.txt](https://matchwire.win/llms.txt)** · MCP reference: **[matchwire.win/docs/mcp/](https://matchwire.win/docs/mcp/)**

## Errors

```js
import { MatchwireError } from 'matchwire.win';

try {
  await mw.rows({ sport: 'nope' });
} catch (error) {
  if (error.isRateLimited) await sleep(error.retryAfterMs);   // 429
  else if (error.isAuthError) /* key missing or revoked */ ;
  else if (error.isPlanError) /* outside the plan's sports/venues */ ;
  else throw error;
}
```

## Documentation

- Docs — <https://matchwire.win/docs/>
- Event mapping, explained — <https://matchwire.win/how-to-map-prediction-markets/>
- Kalshi API, mapped — <https://matchwire.win/kalshi-api/>
- Polymarket API, mapped — <https://matchwire.win/polymarket-api/>
- Prediction Market API — <https://matchwire.win/prediction-market-api/>
- Plans — <https://matchwire.win/#pricing>

## Python

```python
from matchwire import Matchwire

mw = Matchwire(api_key=os.environ["MATCHWIRE_API_KEY"])
rows = mw.rows(sport="nfl", venue=["kalshi", "poly"])["rows"]
print(rows[0]["name"], [l["venue"] for l in rows[0]["listings"]])
```

See [python/README.md](python/README.md). Standard library only, Python 3.9+.

## License

MIT. Not affiliated with Kalshi, Polymarket or Predict.fun; venue names are used to say what is mapped.
