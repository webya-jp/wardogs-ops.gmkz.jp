// 読み取り API の共通処理: RCON GET → 正規化。docs/ARCHITECTURE.md 4.2・9.3。RCON の結果はキャッシュしない
// (例外: /api/status の補助に使う GET /v1/rotation だけは isolate 内にサーバーごと ROTATION_CACHE_SEC 保持する。docs/API.md 3 章)。
// 対象は解決済みのサーバー(15.6)。404 を受けたらそのサーバーの capabilities キャッシュだけを破棄する。
import { MAX_SERVERS, ROTATION_CACHE_SEC } from '../types/api';
import type { ApiErrorCode, ReadKind, StatusResponse } from '../types/api';
import type { ErrorOptions } from './http';
import { rconRequest, READ_TIMEOUT_MS } from './rcon/client';
import type { ClientDeps } from './rcon/client';
import { getCapabilities, invalidateCapabilities } from './rcon/capabilities';
import { applyRotation, normalizeStatus, parseRotation } from './rcon/normalize';
import type { ParsedRotation } from './rcon/normalize';
import { READ_ROUTES, ROTATION_ROUTE, routeKey } from './rcon/routes';
import type { ResolvedServer } from './servers';

export type ReadOutcome<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; opts: ErrorOptions };

export async function readFromRcon<T>(
  server: ResolvedServer,
  kind: ReadKind,
  normalize: (data: unknown, fetchedAt: number) => T | null,
  deps: ClientDeps = {},
): Promise<ReadOutcome<T>> {
  const route = READ_ROUTES[kind];
  const r = await rconRequest(server.rcon, { route, path: route.template, timeoutMs: READ_TIMEOUT_MS }, deps);
  if (!r.ok) {
    if (r.code === 'RCON_ROUTE_NOT_FOUND') invalidateCapabilities(server.id);
    const opts: ErrorOptions = {};
    if (r.retryAfterSec !== undefined) opts.retryAfterSec = r.retryAfterSec;
    if (r.rconMessage !== undefined) opts.rconMessage = r.rconMessage;
    return { ok: false, code: r.code, opts };
  }
  const data = normalize(r.data, Date.now());
  if (data === null) return { ok: false, code: 'RCON_BAD_RESPONSE', opts: {} };
  return { ok: true, data };
}

// ============================================================
// GET /v1/rotation(/api/status の rotation.count / nextMap / nextMapName)
// ============================================================

/** /v1/rotation のタイムアウト(/api/status 全体を遅らせすぎないため。docs/API.md 3 章) */
export const ROTATION_TIMEOUT_MS = 3000;
export const ROTATION_TTL_MS = ROTATION_CACHE_SEC * 1000;
/** 失敗(タイムアウト・形式不正など)の結果を保持する時間 */
export const ROTATION_FAIL_TTL_MS = 60 * 1000;

interface RotationCacheEntry {
  /** null = 取得に失敗した */
  parsed: ParsedRotation | null;
  expiresAt: number;
}

// キーは capabilities と同じ `${serverId}|${baseUrl}`。最大 MAX_SERVERS + 1 件で、超えたら古いものから捨てる
const MAX_ROTATION_CACHE = MAX_SERVERS + 1;
const rotationCache = new Map<string, RotationCacheEntry>();
const rotationInflight = new Map<string, Promise<ParsedRotation | null>>();

function rotationKey(server: ResolvedServer): string {
  return `${server.id}|${server.rcon.baseUrl}`;
}

/** そのサーバーの /v1/rotation のキャッシュを破棄する(map / match_end の成功時)。省略で全サーバー分 */
export function invalidateRotation(serverId?: string): void {
  if (serverId === undefined) {
    rotationCache.clear();
    return;
  }
  const prefix = `${serverId}|`;
  for (const k of [...rotationCache.keys()]) if (k.startsWith(prefix)) rotationCache.delete(k);
}

export function resetRotationForTest(): void {
  rotationCache.clear();
  rotationInflight.clear();
}

export interface ReadStatusOptions extends ClientDeps {
  now?: number;
}

/** /v1/rotation を引く(キャッシュ・同時取得の相乗りあり)。失敗しても例外にせず null */
async function getRotation(server: ResolvedServer, opts: ReadStatusOptions): Promise<ParsedRotation | null> {
  const now = opts.now ?? Date.now();
  const key = rotationKey(server);
  const cached = rotationCache.get(key);
  if (cached && now < cached.expiresAt) return cached.parsed;
  const running = rotationInflight.get(key);
  if (running) return running;

  const promise = (async () => {
    const r = await rconRequest(
      server.rcon,
      { route: ROTATION_ROUTE, path: ROTATION_ROUTE.template, timeoutMs: ROTATION_TIMEOUT_MS },
      opts,
    );
    if (!r.ok && r.code === 'RCON_ROUTE_NOT_FOUND') invalidateCapabilities(server.id);
    const parsed = r.ok ? parseRotation(r.data) : null;
    // 2xx でも形式を解釈できなければ失敗扱い。enabled: false も失敗と同じく 60 秒だけ保持する(要確認 R-19)
    rotationCache.delete(key);
    rotationCache.set(key, { parsed, expiresAt: now + (parsed && parsed.enabled !== false ? ROTATION_TTL_MS : ROTATION_FAIL_TTL_MS) });
    while (rotationCache.size > MAX_ROTATION_CACHE) {
      const first = rotationCache.keys().next();
      if (first.done) break;
      rotationCache.delete(first.value);
    }
    return parsed;
  })();
  rotationInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (rotationInflight.get(key) === promise) rotationInflight.delete(key);
  }
}

/**
 * /api/status: GET /v1/status → 正規化 → (capabilities の routes に GET /v1/rotation があれば)次のマップ・件数を補う。
 * /v1/rotation が無い・失敗した場合は rotation の 3 項目を null にし、status 自体は成功で返す
 */
export async function readStatus(server: ResolvedServer, opts: ReadStatusOptions = {}): Promise<ReadOutcome<StatusResponse>> {
  const r = await readFromRcon(server, 'status', normalizeStatus, opts);
  if (!r.ok) return r;
  const caps = await getCapabilities({ serverId: server.id, rcon: server.rcon }, opts);
  // capabilities の routes は "METHOD /path" に正規化済み(パラメータの無いルートなので template と同じ表記)
  const listed = caps.routes.includes(routeKey(ROTATION_ROUTE)) || caps.routes.includes(`* ${ROTATION_ROUTE.template}`);
  const parsed = listed ? await getRotation(server, opts) : null;
  return { ok: true, data: { ...r.data, rotation: applyRotation(r.data.rotation, parsed) } };
}
