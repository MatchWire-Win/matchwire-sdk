# matchwire.win — Python client

**Mapped prediction-market data for Python.** One row per game, matched across **Kalshi, Polymarket US, Polymarket International and Predict.fun**, each venue's own market id left intact. Mapping only — no prices.

Standard library only. Python 3.9+.

```bash
pip install matchwire.win
```

```python
import os
from matchwire import Matchwire

mw = Matchwire(api_key=os.environ["MATCHWIRE_API_KEY"])

status = mw.status()
print(status["store"]["events"], "games mapped")

sports = mw.sports()["sports"]
print([s["sport"] for s in sports[:5]])

rows = mw.rows(sport="nfl", venue=["kalshi", "poly"], limit=5)["rows"]
for row in rows:
    print(row["name"], row["status"], [l["venue"] for l in row["listings"]])
```

## Methods

| Method | What it returns |
| --- | --- |
| `status()` | Service and per-venue health, current `seq`, coverage counts |
| `sports()` | Sports with game counts, plus group ids |
| `rows(**filters)` | One row per game with its per-venue listings |
| `row(id)` / `mapping(id)` | One game by its mapped id (via the MCP `get_row` tool) |
| `stream(**filters)` | Generator of the same updates over SSE |
| `call_tool(name, args)` | Any tool the MCP endpoint advertises |
| `tools()` | The tool list the MCP endpoint advertises |

Filters (`sport`, `venue`, `type`, `league`, `status`) take a value or a comma list; `since=<seq>` switches to a delta and adds `tombstones`.

```python
# Deltas: only what changed, plus tombstones for pruned games.
seq = mw.rows(sport="esports", limit=5000)["seq"]
delta = mw.rows(since=seq)
print(len(delta["rows"]), "changed", len(delta.get("tombstones", [])), "gone")

# Streaming the same updates.
for frame in mw.stream(since=seq):
    print(frame["event"], frame["data"].get("rows", [])[:1])
    break
```

## Errors

```python
from matchwire import MatchwireError

try:
    mw.rows(sport="nope")
except MatchwireError as error:
    if error.is_rate_limited:
        ...                      # 429 — error.retry_after_ms
    elif error.is_auth_error:     # 401
        ...
    elif error.is_plan_error:     # 403 — outside the key's plan
        ...
```

## Tests

```bash
cd python
python -m unittest discover -s tests -v     # offline, no network
MATCHWIRE_API_KEY=mw_live_... python -m unittest tests.test_live -v
```

Docs: <https://matchwire.win/docs/> · MCP: <https://matchwire.win/docs/mcp/> · llms.txt: <https://matchwire.win/llms.txt>
