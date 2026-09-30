/**
 * matchwire.win — CommonJS build of the zero-dependency client.
 *
 * Same surface as the ESM entry (`src/index.js`); see the README for the full
 * reference. matchwire.win maps sports prediction markets across Kalshi,
 * Polymarket US, Polymarket International and Predict.fun — one row per game,
 * each venue's own market id kept intact. Mapping only: no prices.
 *
 * @module matchwire.win
 */
'use strict';

const VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://api.matchwire.win';
const VENUES = ['kalshi', 'poly', 'polyintl', 'predictfun'];
const TYPES = ['winner', 'total', 'handicap', 'map_winner', 'score', 'event'];
const STATUSES = ['scheduled', 'live', 'ended'];
const DEFAULT_TIMEOUT_MS = 20000;

class MatchwireError extends Error {
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

  get isRateLimited() {
    return this.status === 429;
  }

  get isAuthError() {
    return this.status === 401;
  }

  get isPlanError() {
    return this.status === 403;
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isRetryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function toQuery(params = {}) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      out.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      out.set(key, value ? 'true' : 'false');
    } else {
      out.set(key, String(value));
    }
  }
  const qs = out.toString();
  return qs ? '?' + qs : '';
}

function requireOneOf(name, value, allowed) {
  if (value === undefined || value === null) return;
  const values = Array.isArray(value) ? value : String(value).split(',');
  for (const item of values) {
    if (!allowed.includes(item)) {
      throw new MatchwireError(
        'invalid ' + name + ': ' + JSON.stringify(item) + ' — expected one of ' + allowed.join(', '),
        { status: 0, code: 'invalid_argument' }
      );
    }
  }
}

class Matchwire {
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
    this._fetch = fetchImpl || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new MatchwireError('global fetch is unavailable — Node.js 18+ is required', {
        code: 'invalid_argument',
      });
    }
  }

  async _request(path, { query, accept, signal, method = 'GET', body } = {}) {
    const url = this.baseUrl + path + (query ? toQuery(query) : '');
    const headers = {
      'x-api-key': this.apiKey,
      accept: accept || 'application/json',
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
      throw new MatchwireError('request failed: ' + ((cause && cause.message) || cause), {
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
      const code = (payload && typeof payload === 'object' && payload.error) || 'http_' + response.status;
      const retryAfter = response.headers.get('retry-after');
      throw new MatchwireError(response.status + ' ' + code, {
        status: response.status,
        code,
        body: payload,
        headers: response.headers,
        url,
        retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : (payload && payload.retry_after_ms) || null,
      });
    }

    return payload;
  }

  status(options) {
    return this._request('/api/v1/status', options);
  }

  sports(options) {
    return this._request('/api/v1/sports', options);
  }

  rows(params = {}) {
    const { signal, ...query } = params;
    requireOneOf('venue', query.venue, VENUES);
    requireOneOf('type', query.type, TYPES);
    requireOneOf('status', query.status, STATUSES);
    return this._request('/api/v1/rows', { query, signal });
  }

  async row(id, options) {
    if (!id || typeof id !== 'string') {
      throw new MatchwireError('row(id) needs a mapped id from rows()', { code: 'invalid_argument' });
    }
    const result = await this.callTool('get_row', { id }, options);
    return result && typeof result === 'object' && 'row' in result ? result.row : result;
  }

  async *stream(params = {}) {
    const { signal, ...query } = params;
    const url = this.baseUrl + '/api/v1/push' + toQuery(query);
    const response = await this._fetch(url, {
      headers: { 'x-api-key': this.apiKey, accept: 'text/event-stream', 'user-agent': 'matchwire.win-node/0.1.0' },
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new MatchwireError(response.status + ' on the stream', {
        status: response.status,
        code: 'http_' + response.status,
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
      for (;;) {
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
              /* keep raw text */
            }
            pending = parsed;
          }
        }
      }
    } finally {
      if (reader.cancel) reader.cancel().catch(() => {});
    }
  }

  async callTool(name, args = {}, options = {}) {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const result = await this._request(
      '/mcp',
      Object.assign({}, options, { method: 'POST', body: payload })
    );
    if (result && result.error) {
      throw new MatchwireError('mcp error: ' + result.error.message, {
        status: 0,
        code: String(result.error.code || 'mcp_error'),
        body: result,
      });
    }
    const text = result && result.result && result.result.content && result.result.content[0] && result.result.content[0].text;
    if (text !== undefined) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result && result.result;
  }

  async tools(options) {
    const result = await this._request(
      '/mcp',
      Object.assign({}, options, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    );
    return (result && result.result && result.result.tools) || result;
  }
}

module.exports = {
  Matchwire,
  MatchwireError,
  VERSION,
  DEFAULT_BASE_URL,
  VENUES,
  TYPES,
  STATUSES,
};
module.exports.default = Matchwire;
