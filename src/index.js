/**
 * matchwire.win — zero-dependency Node.js client.
 *
 * matchwire.win is a hosted mapping layer for sports prediction markets. It
 * returns one row per game, matched across Kalshi, Polymarket US, Polymarket
 * International and Predict.fun, with each venue's own market id left intact.
 * Mapping only: no prices, no order books.
 *
 *   rows()    every game in the key's plan, one row per game
 *   row(id)   one game by its mapped id
 *   sports()  sport names, counts and group ids
 *   status()  service and per-venue health
 *   stream()  the same updates as a Server-Sent Events stream
 *   callTool() any of the MCP tools, over the same endpoint an agent uses
 *
 * Docs:  https://matchwire.win/docs/
 * LLM:   https://matchwire.win/llms.txt
 * MCP:   https://matchwire.win/docs/mcp/
 *
 * @module matchwire.win
 */

/** Package version. */
export const VERSION = '0.1.0';

/** Default API origin. */
export const DEFAULT_BASE_URL = 'https://api.matchwire.win';

/** Venue ids the API accepts. */
export const VENUES = Object.freeze(['kalshi', 'poly', 'polyintl', 'predictfun']);

/** Market-type ids the API accepts. */
export const TYPES = Object.freeze(['winner', 'total', 'handicap', 'map_winner', 'score', 'event']);

/** Game lifecycle values the API accepts. */
export const STATUSES = Object.freeze(['scheduled', 'live', 'ended']);

const DEFAULT_TIMEOUT_MS = 20_000;

/** Statuses where retrying the identical request cannot succeed. */
const FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

/**
 * Error raised for every failure this client surfaces: a non-2xx response, a
 * transport failure, or an invalid argument.
 *
 * @property {number} status  HTTP status, or 0 for transport/validation errors.
 * @property {string} code    The API's `error` string, or `http_<status>`, or a local code.
 * @property {any}    body    Parsed response body when the server sent one.
 * @property {Headers|null} headers
 * @property {string|null} url
 * @property {number|null} retryAfterMs
 */
export class MatchwireError extends Error {
  constructor(message, options = {}) {
    super(message);
    const {
      status = 0,
      code = 'unknown_error',
      body = null,
      headers = null,
      url = null,
      retryAfterMs = null,
      cause,
    } = options;

    this.name = 'MatchwireError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.headers = headers;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    if (cause !== undefined) this.cause = cause;
  }

  /** True for HTTP 429. Honor `retryAfterMs` before retrying. */
  get isRateLimited() {
    return this.status === 429;
  }

  /** True when the key is missing, unknown or revoked. */
  get isAuthError() {
    return this.status === 401;
  }

  /** True when the key's plan does not cover the sport, venue or type asked for. */
  get isPlanError() {
    return this.status === 403;
  }

  /** True when the mapped id does not exist (or has been pruned). */
  get isNotFound() {
    return this.status === 404;
  }

  /** True when retrying the identical request could plausibly succeed. */
  get isRetryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function toQuery(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      out.set(key, value ? 'true' : 'false');
    } else {
      out.set(key, String(value));
    }
  }
  const qs = out.toString();
  return qs ? `?${qs}` : '';
}

function requireOneOf(name, value, allowed) {
  if (value === undefined || value === null) return;
  const values = Array.isArray(value) ? value : String(value).split(',');
  for (const item of values) {
    if (!allowed.includes(item)) {
      throw new MatchwireError(
        `invalid ${name}: ${JSON.stringify(item)} — expected one of ${allowed.join(', ')}`,
        { status: 0, code: 'invalid_argument' },
      );
    }
  }
}

/**
 * Client for the matchwire.win HTTP API and its MCP endpoint.
 *
 * @example
 * import { Matchwire } from 'matchwire.win';
 * const mw = new Matchwire({ apiKey: process.env.MATCHWIRE_API_KEY });
 * const rows = await mw.rows({ sport: 'nfl', venue: ['kalshi', 'poly'] });
 */
export class Matchwire {
  /**
   * @param {object} options
   * @param {string} options.apiKey   Key from https://matchwire.win/#pricing (mw_…). Required.
   * @param {string} [options.baseUrl] Defaults to https://api.matchwire.win
   * @param {number} [options.timeoutMs] Per-request timeout, default 20000.
   * @param {typeof fetch} [options.fetch] Custom fetch (tests, proxies).
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new MatchwireError('apiKey is required — get one at https://matchwire.win', {
        status: 0,
        code: 'invalid_argument',
      });
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new MatchwireError('global fetch is unavailable — Node.js 18+ is required', {
        code: 'invalid_argument',
      });
    }
  }

  /** @private */
  async _request(path, { query, accept, signal, method = 'GET', body } = {}) {
    const url = `${this.baseUrl}${path}${query ? toQuery(query) : ''}`;
    const headers = {
      'x-api-key': this.apiKey,
      accept: accept ?? 'application/json',
      // The API sits behind Cloudflare; name the client rather than the runtime default.
      'user-agent': 'matchwire.win-node/0.1.0',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    let response;
    try {
      response = await this._fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new MatchwireError(`request failed: ${cause?.message ?? cause}`, {
        code: 'network_error',
        url,
        cause,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // The MCP endpoint answers with one SSE frame when the client asks for
        // text/event-stream; unwrap it before giving up on the body.
        const match = /^data: (.*)$/m.exec(text);
        if (match) {
          try {
            payload = JSON.parse(match[1]);
          } catch {
            payload = text;
          }
        } else {
          payload = text;
        }
      }
    }

    if (!response.ok) {
      const code = (payload && typeof payload === 'object' && payload.error) || `http_${response.status}`;
      const retryAfter = response.headers.get('retry-after');
      throw new MatchwireError(`${response.status} ${code}`, {
        status: response.status,
        code,
        body: payload,
        headers: response.headers,
        url,
        retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : payload?.retry_after_ms ?? null,
      });
    }

    return payload;
  }

  /**
   * Service and per-venue health, the current sequence number, and coverage counts.
   * @returns {Promise<object>}
   */
  status(options) {
    return this._request('/api/v1/status', options);
  }

  /**
   * Every sport with game counts, plus the group ids (`esports`, `american-football`, …).
   * `sport=` on rows() takes either a sport name or a group id.
   * @returns {Promise<{sports: Array<object>, groups?: Array<object>}>}
   */
  sports(options) {
    return this._request('/api/v1/sports', options);
  }

  /**
   * One row per game, each carrying its per-venue listings.
   *
   * @param {object} [params]
   * @param {string|string[]} [params.sport] Sport name or group id (comma list).
   * @param {string|string[]} [params.venue] kalshi | poly | polyintl | predictfun.
   * @param {string|string[]} [params.type]  winner | total | handicap | map_winner | score | event.
   * @param {string|string[]} [params.league] League, e.g. MLB.
   * @param {string|string[]} [params.status] scheduled | live | ended.
   * @param {number|string}   [params.since] Only rows changed since this seq, plus `tombstones`.
   * @param {number}          [params.limit] Server cap is 5000 rows.
   * @param {AbortSignal}     [params.signal]
   * @returns {Promise<{seq: number, full: boolean, rows: Array<object>, tombstones?: Array<object>, truncated?: boolean, count?: number}>}
   */
  rows(params = {}) {
    const { signal, ...query } = params;
    requireOneOf('venue', query.venue, VENUES);
    requireOneOf('type', query.type, TYPES);
    requireOneOf('status', query.status, STATUSES);
    return this._request('/api/v1/rows', { query, signal });
  }

  /**
   * One game by the mapped id handed out in `rows()`. Served by the same MCP
   * `get_row` tool an agent calls, because the REST API exposes games as a set.
   *
   * @param {string} id e.g. `ev:nfl:arizona-cardinals:denver-broncos:2026-10-25`
   * @param {object} [options]
   * @returns {Promise<object>} The row.
   */
  async row(id, options) {
    if (!id || typeof id !== 'string') {
      throw new MatchwireError('row(id) needs a mapped id from rows()', { code: 'invalid_argument' });
    }
    const result = await this.callTool('get_row', { id }, options);
    return result && typeof result === 'object' && 'row' in result ? result.row : result;
  }

  /**
   * The delta stream: the same updates as `rows({ since })`, pushed as
   * Server-Sent Events. Yields one parsed event per frame.
   *
   * @param {object} [params] Same filters as rows(); `since` resumes without a gap.
   * @param {AbortSignal} [params.signal]
   * @returns {AsyncGenerator<{event: string, data: any, id: string|null}>}
   */
  async *stream(params = {}) {
    const { signal, ...query } = params;
    const url = `${this.baseUrl}/api/v1/push${toQuery(query)}`;
    const response = await this._fetch(url, {
      headers: { 'x-api-key': this.apiKey, accept: 'text/event-stream', 'user-agent': 'matchwire.win-node/0.1.0' },
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new MatchwireError(`${response.status} on the stream`, {
        status: response.status,
        code: `http_${response.status}`,
        body: text || null,
        url,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    let id = null;
    let pending;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);

          if (line === '') {
            if (pending !== undefined) {
              yield { event, data: pending, id };
              pending = undefined;
            }
            event = 'message';
            id = null;
            continue;
          }
          if (line.startsWith(':')) continue;

          const sep = line.indexOf(':');
          const field = sep === -1 ? line : line.slice(0, sep);
          const raw = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');

          if (field === 'event') event = raw;
          else if (field === 'id') id = raw;
          else if (field === 'data') {
            let parsed = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              /* keep the raw text */
            }
            pending = parsed;
          }
        }
      }
    } finally {
      reader.cancel?.().catch(() => {});
    }
  }

  /**
   * Call any tool the MCP endpoint advertises over the same endpoint an agent uses.
   * Tools: list_sports, find_rows, get_row, get_venue_market, service_status.
   *
   * @param {string} name
   * @param {object} [args]
   * @param {object} [options]
   * @returns {Promise<any>} The tool's payload.
   */
  async callTool(name, args = {}, options = {}) {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const result = await this._request('/mcp', {
      ...options,
      method: 'POST',
      body: payload,
    });
    if (result?.error) {
      throw new MatchwireError(`mcp error: ${result.error.message}`, {
        status: 0,
        code: String(result.error.code ?? 'mcp_error'),
        body: result,
      });
    }
    const text = result?.result?.content?.[0]?.text;
    if (text !== undefined) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result?.result;
  }

  /** Tool names advertised by the MCP endpoint. */
  async tools(options) {
    const result = await this._request('/mcp', {
      ...options,
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    return result?.result?.tools ?? result;
  }
}

export default Matchwire;
