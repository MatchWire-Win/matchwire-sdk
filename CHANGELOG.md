# Changelog

## 0.1.0 — 2026-09-30

First release. Verified against the live API on 2026-09-30.

**Node.js** (`npm install matchwire.win`)

- `Matchwire` client over `https://api.matchwire.win`: `status()`, `sports()`, `rows()`, `row()`, `stream()`, `tools()`, `callTool()`.
- Zero dependencies, Node.js 18+, ESM and CommonJS, hand-written TypeScript declarations.
- `MatchwireError` with `status`, `code`, `body` and `retryAfterMs`, plus `isRateLimited`, `isAuthError`, `isPlanError`, `isNotFound`, `isRetryable`.
- `rows()` validates `venue`, `type` and `status` before the request, so a typo fails locally instead of costing a call.
- SSE parsing for `/api/v1/push` and for the single-frame JSON-RPC responses from `/mcp`.
- 9 offline tests and 8 live tests (`npm test`, then `MATCHWIRE_API_KEY=… node --test test/live.test.mjs`).

**Python** (`pip install matchwire.win`)

- Same surface: `status()`, `sports()`, `rows()`, `row()`/`mapping()`, `stream()`, `tools()`, `call_tool()`.
- Standard library only, Python 3.9+.
- `MatchwireError` mirrors the Node error properties.
