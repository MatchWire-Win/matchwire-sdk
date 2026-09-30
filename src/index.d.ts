/**
 * Type declarations for matchwire.win — the mapped sports prediction-market API.
 * https://matchwire.win/docs/
 */

export declare const VERSION: string;
export declare const DEFAULT_BASE_URL: string;
export declare const VENUES: readonly ['kalshi', 'poly', 'polyintl', 'predictfun'];
export declare const TYPES: readonly ['winner', 'total', 'handicap', 'map_winner', 'score', 'event'];
export declare const STATUSES: readonly ['scheduled', 'live', 'ended'];

export type Venue = 'kalshi' | 'poly' | 'polyintl' | 'predictfun';
export type MarketType = 'winner' | 'total' | 'handicap' | 'map_winner' | 'score' | 'event';
export type GameStatus = 'scheduled' | 'live' | 'ended';
export type Tier = 'exact' | 'normalized' | 'fuzzy';

/** The venue's own market id plus the exact request that reads it. */
export interface VenueRequest {
  method: string;
  url: string;
  [key: string]: unknown;
}

/** One venue's listing of one market on one game. */
export interface Listing {
  venue: Venue;
  marketId: string;
  type?: MarketType;
  tier?: Tier;
  confidence?: number;
  side?: string | null;
  request?: VenueRequest;
  [key: string]: unknown;
}

/** A market on the game — winner, total, handicap, and so on — with its listings. */
export interface Market {
  key: string;
  family: string;
  period?: string | null;
  stat?: string | null;
  line?: number | string | null;
  subject?: string | null;
  listings: Listing[];
}

/** One game, mapped across venues. No prices anywhere. */
export interface Row {
  id: string;
  sport: string;
  league?: string | null;
  name: string;
  teams?: string[];
  start?: string | null;
  status?: GameStatus | string;
  listings: Listing[];
  markets?: Market[];
  [key: string]: unknown;
}

export interface RowsResponse {
  seq: number;
  full: boolean;
  rows: Row[];
  tombstones?: Array<{ id: string }>;
  truncated?: boolean;
  count?: number;
}

export interface Sport {
  sport: string;
  events: number;
  scheduled?: number;
  live?: number;
  ended?: number;
  listings?: number;
}

export interface SportGroup {
  id: string;
  name?: string;
  sports?: string[];
}

export interface SportsResponse {
  sports: Sport[];
  groups?: SportGroup[];
}

export interface CoverageEntry {
  venue: Venue;
  listings: number;
  open: number;
  bound: number;
  unmatched_open_winners?: number;
  side_markets?: number;
  bound_sides?: number;
  unmatched_open_sides?: number;
}

export interface StatusResponse {
  service: string;
  stage?: string;
  commit?: string;
  builtAt?: string;
  cycles?: number;
  lastCycle?: unknown;
  venues?: Record<string, unknown>;
  store?: { events: number; listings: number; bound: number };
  coverage?: CoverageEntry[];
  [key: string]: unknown;
}

export interface RowParams {
  sport?: string | string[];
  venue?: Venue | Venue[];
  type?: MarketType | MarketType[];
  league?: string | string[];
  status?: GameStatus | GameStatus[];
  since?: number | string;
  limit?: number;
  signal?: AbortSignal;
}

export interface StreamEvent<T = unknown> {
  event: string;
  data: T;
  id: string | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface MatchwireOptions {
  /** Key from https://matchwire.win/#pricing. Required. */
  apiKey: string;
  /** Defaults to https://api.matchwire.win */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export declare class MatchwireError extends Error {
  constructor(message: string, options?: Record<string, unknown>);
  status: number;
  code: string;
  body: unknown;
  headers: Headers | null;
  url: string | null;
  retryAfterMs: number | null;
  readonly isRateLimited: boolean;
  readonly isAuthError: boolean;
  readonly isPlanError: boolean;
  readonly isNotFound: boolean;
  readonly isRetryable: boolean;
}

export declare class Matchwire {
  constructor(options: MatchwireOptions);
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;

  /** Service and per-venue health, current seq and coverage counts. */
  status(options?: RequestOptions): Promise<StatusResponse>;
  /** Sports with game counts, plus group ids (`esports`, `american-football`, …). */
  sports(options?: RequestOptions): Promise<SportsResponse>;
  /** One row per game, each carrying its per-venue listings. */
  rows(params?: RowParams): Promise<RowsResponse>;
  /** One game by the mapped id handed out in rows(). */
  row(id: string, options?: RequestOptions): Promise<Row>;
  /** Server-Sent Events stream of the same updates as rows({ since }). */
  stream(params?: RowParams): AsyncGenerator<StreamEvent>;
  /** Call any MCP tool the endpoint advertises (list_sports, find_rows, get_row, get_venue_market, report_issue, service_status). */
  callTool<T = unknown>(name: string, args?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  /** The tools the MCP endpoint advertises. */
  tools(options?: RequestOptions): Promise<unknown>;
}

export default Matchwire;
