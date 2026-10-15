// GET /v1/capabilities の取得・解釈・キャッシュ。docs/ARCHITECTURE.md 6.4、docs/API.md 3 章。
// - isolate 内でサーバーごとに 10 分キャッシュ(RCON_ROUTE_NOT_FOUND を受けたらそのサーバーの分を破棄)。KV / D1 には保存しない
// - routes[] の要素形式は未検証(R-1)。文字列("POST /v1/broadcast")と { method, path } の両方を受け付ける
// - パスのパラメータ部({steamId}、:steamId、<steamId>)は名前を無視して照合する
import { MAX_SERVERS, READ_KINDS, WRITE_ACTIONS } from '../../types/api';
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

// キャッシュはサーバーごと(キー `${serverId}|${baseUrl}`。ARCHITECTURE 15.6)。最大 MAX_SERVERS + 1 件で、超えたら古いものから捨てる
interface CacheEntry {
  response: CapabilitiesResponse;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = MAX_SERVERS + 1;
const cache = new Map<string, CacheEntry>();
const lastRefreshAt = new Map<string, number>();
const inflight = new Map<string, Promise<CapabilitiesResponse>>();

/** capabilities を引く対象(サーバーの id と接続設定) */
export interface CapabilitiesTarget {
  serverId: string;
  rcon: RconConfig;
}

function cacheKey(t: CapabilitiesTarget): string {
  return `${t.serverId}|${t.rcon.baseUrl}`;
}

function trim<V>(m: Map<string, V>): void {
  while (m.size > MAX_CACHE_ENTRIES) {
    const first = m.keys().next();
    if (first.done) break;
    m.delete(first.value);
  }
}

/**
 * そのサーバーの分のキャッシュを破棄する(RCON_ROUTE_NOT_FOUND を受けたとき、サーバーの更新・削除・接続テストのとき)。
 * serverId を省略すると全サーバー分を破棄する
 */
export function invalidateCapabilities(serverId?: string): void {
  if (serverId === undefined) {
    cache.clear();
    return;
  }
  const prefix = `${serverId}|`;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

export function resetCapabilitiesForTest(): void {
  cache.clear();
  lastRefreshAt.clear();
  inflight.clear();
}

export interface GetCapabilitiesOptions extends ClientDeps {
  /** ?refresh=1。サーバーごとに 1 分に 1 回まで(超過時はキャッシュを返す) */
  refresh?: boolean;
  now?: number;
}

/** capabilities を返す。取得できなくても例外にせず source: "unavailable" を返す */
export async function getCapabilities(target: CapabilitiesTarget, opts: GetCapabilitiesOptions = {}): Promise<CapabilitiesResponse> {
  const now = opts.now ?? Date.now();
  const key = cacheKey(target);
  const cached = cache.get(key);
  let refresh = opts.refresh === true;
  if (refresh) {
    if (now - (lastRefreshAt.get(key) ?? 0) < REFRESH_MIN_INTERVAL_MS && cached) refresh = false;
    else {
      lastRefreshAt.delete(key);
      lastRefreshAt.set(key, now);
      trim(lastRefreshAt);
    }
  }
  if (!refresh && cached && now < cached.expiresAt) return cached.response;
  const running = inflight.get(key);
  if (running) return running;

  const promise = (async () => {
    const res = await rconRequest(
      target.rcon,
      { route: CAPABILITIES_ROUTE, path: CAPABILITIES_ROUTE.template, timeoutMs: READ_TIMEOUT_MS },
      opts,
    );
    const parsed = res.ok ? parseCapabilities(res.data) : null;
    const response = buildCapabilitiesResponse(parsed, now);
    cache.delete(key);
    cache.set(key, { response, expiresAt: now + (parsed ? CAPABILITIES_TTL_MS : CAPABILITIES_FAIL_TTL_MS) });
    trim(cache);
    return response;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key);
  }
}
