// GET /v1/capabilities の取得・解釈・キャッシュ。docs/ARCHITECTURE.md 6.4、docs/API.md 3 章。
// - isolate 内で 10 分キャッシュ(RCON_ROUTE_NOT_FOUND を受けたら破棄)。KV / D1 には保存しない
// - routes[] の要素形式は未検証(R-1)。文字列("POST /v1/broadcast")と { method, path } の両方を受け付ける
// - パスのパラメータ部({steamId}、:steamId、<steamId>)は名前を無視して照合する
import { READ_KINDS, WRITE_ACTIONS } from '../../types/api';
import type { CapabilitiesResponse, CapabilityState, ReadKind, WriteAction } from '../../types/api';
import type { RconConfig } from '../config';
import { rconRequest, READ_TIMEOUT_MS } from './client';
import type { ClientDeps } from './client';
import { CAPABILITIES_ROUTE, READ_ROUTES, WRITE_ROUTES } from './routes';
import type { RouteDef } from './routes';

export const CAPABILITIES_TTL_MS = 10 * 60 * 1000;
/** 取得に失敗した結果のキャッシュ期間(毎回 RCON を叩かないため) */
export const CAPABILITIES_FAIL_TTL_MS = 60 * 1000;
export const REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const MAX_ROUTES = 500;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** "/v1/players/{steamId}/kick" → "/v1/players/{}/kick" */
export function normalizePath(path: string): string {
  const p = path.trim().split(/[?#]/)[0] ?? '';
  const segs = p
    .split('/')
    .filter((s, i) => i === 0 || s !== '')
    .map((s) => (/^\{[^}]*\}$|^:.+$|^<[^>]*>$/.test(s) ? '{}' : s));
  const joined = segs.join('/');
  return (joined.startsWith('/') ? joined : `/${joined}`).replace(/\/+$/, '') || '/';
}

/** 1 要素を "METHOD /path" に正規化する。メソッドが無ければ "* /path"。解釈できなければ null */
export function normalizeRouteEntry(entry: unknown): string | null {
  let method: string | undefined;
  let path: string | undefined;
  if (typeof entry === 'string') {
    const m = /^\s*(?:([A-Za-z]+)\s+)?(\/\S*)\s*$/.exec(entry);
    if (!m) return null;
    method = m[1];
    path = m[2];
  } else if (typeof entry === 'object' && entry !== null) {
    const o = entry as Record<string, unknown>;
    const mm = o.method ?? o.verb;
    const pp = o.path ?? o.route ?? o.url;
    if (typeof pp !== 'string') return null;
    if (mm !== undefined && typeof mm !== 'string') return null;
    method = mm;
    path = pp;
  } else {
    return null;
  }
  if (!path || !path.startsWith('/')) return null;
  const up = method?.toUpperCase();
  if (up !== undefined && !METHODS.has(up)) return null;
  return `${up ?? '*'} ${normalizePath(path)}`;
}

export interface ParsedCapabilities {
  apiVersion: string | null;
  build: string | null;
  /** 正規化したルート(元の表記ではなく "METHOD /path/{}" の形) */
  routes: string[];
}

function strOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v.slice(0, 64);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** 応答を解釈する。routes が 1 件も解釈できなければ null(= unavailable) */
export function parseCapabilities(data: unknown): ParsedCapabilities | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.routes)) return null;
  const routes: string[] = [];
  for (const r of o.routes.slice(0, MAX_ROUTES)) {
    const n = normalizeRouteEntry(r);
    if (n !== null && !routes.includes(n)) routes.push(n);
  }
  if (routes.length === 0) return null;
  return { apiVersion: strOrNull(o.apiVersion), build: strOrNull(o.build), routes };
}

export function routeState(parsed: ParsedCapabilities | null, def: RouteDef): CapabilityState {
  if (!parsed) return 'unknown';
  const path = normalizePath(def.template);
  return parsed.routes.includes(`${def.method} ${path}`) || parsed.routes.includes(`* ${path}`) ? 'available' : 'missing';
}

export function buildCapabilitiesResponse(parsed: ParsedCapabilities | null, fetchedAt: number): CapabilitiesResponse {
  const read = {} as Record<ReadKind, CapabilityState>;
  for (const k of READ_KINDS) read[k] = routeState(parsed, READ_ROUTES[k]);
  const write = {} as Record<WriteAction, CapabilityState>;
  for (const a of WRITE_ACTIONS) write[a] = routeState(parsed, WRITE_ROUTES[a]);
  return {
    source: parsed ? 'rcon' : 'unavailable',
    apiVersion: parsed?.apiVersion ?? null,
    build: parsed?.build ?? null,
    read,
    write,
    routes: parsed?.routes ?? [],
    fetchedAt,
  };
}

interface CacheEntry {
  baseUrl: string;
  response: CapabilitiesResponse;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let lastRefreshAt = 0;
let inflight: { baseUrl: string; promise: Promise<CapabilitiesResponse> } | null = null;

/** テスト用・RCON_ROUTE_NOT_FOUND を受けたとき */
export function invalidateCapabilities(): void {
  cache = null;
}

export function resetCapabilitiesForTest(): void {
  cache = null;
  lastRefreshAt = 0;
  inflight = null;
}

export interface GetCapabilitiesOptions extends ClientDeps {
  /** ?refresh=1。1 分に 1 回まで(超過時はキャッシュを返す) */
  refresh?: boolean;
  now?: number;
}

/** capabilities を返す。取得できなくても例外にせず source: "unavailable" を返す */
export async function getCapabilities(cfg: RconConfig, opts: GetCapabilitiesOptions = {}): Promise<CapabilitiesResponse> {
  const now = opts.now ?? Date.now();
  let refresh = opts.refresh === true;
  if (refresh) {
    if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS && cache && cache.baseUrl === cfg.baseUrl) refresh = false;
    else lastRefreshAt = now;
  }
  if (!refresh && cache && cache.baseUrl === cfg.baseUrl && now < cache.expiresAt) return cache.response;
  if (inflight && inflight.baseUrl === cfg.baseUrl) return inflight.promise;

  const promise = (async () => {
    const res = await rconRequest(cfg, { route: CAPABILITIES_ROUTE, path: CAPABILITIES_ROUTE.template, timeoutMs: READ_TIMEOUT_MS }, opts);
    const parsed = res.ok ? parseCapabilities(res.data) : null;
    const response = buildCapabilitiesResponse(parsed, now);
    cache = { baseUrl: cfg.baseUrl, response, expiresAt: now + (parsed ? CAPABILITIES_TTL_MS : CAPABILITIES_FAIL_TTL_MS) };
    return response;
  })();
  inflight = { baseUrl: cfg.baseUrl, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}
