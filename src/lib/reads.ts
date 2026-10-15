// 読み取り API の共通処理: RCON GET → 正規化。docs/ARCHITECTURE.md 4.2。RCON の結果はキャッシュしない。
// 対象は解決済みのサーバー(15.6)。404 を受けたらそのサーバーの capabilities キャッシュだけを破棄する。
import type { ApiErrorCode, ReadKind } from '../types/api';
import type { ErrorOptions } from './http';
import { rconRequest, READ_TIMEOUT_MS } from './rcon/client';
import type { ClientDeps } from './rcon/client';
import { invalidateCapabilities } from './rcon/capabilities';
import { READ_ROUTES } from './rcon/routes';
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
