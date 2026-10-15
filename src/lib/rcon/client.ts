// RCON HTTP API への fetch。docs/ARCHITECTURE.md 6.2・6.3。
// - Authorization: Bearer <RCON_PASSWORD>、リダイレクト非追従、タイムアウト(読み取り 5 秒 / 書き込み 8 秒)、再試行しない
// - 応答は 512 KiB まで。エラーは ApiErrorCode に分類する
// - ログに出すのはルート名・HTTP ステータス・所要時間・エラーコードのみ(接続先・パスワード・応答本文・Steam ID は出さない)
import type { ApiErrorCode } from '../../types/api';
import type { RconConfig } from '../config';
import { readLimited } from '../http';
import { routeKey } from './routes';
import type { RouteDef } from './routes';

export const READ_TIMEOUT_MS = 5000;
export const WRITE_TIMEOUT_MS = 8000;
export const MAX_RESPONSE_BYTES = 512 * 1024;
const RCON_MESSAGE_MAX = 200;
const RETRY_AFTER_DEFAULT_SEC = 30;
const RETRY_AFTER_MAX_SEC = 3600;

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface RconRequest {
  route: RouteDef;
  /** 実際のパス(/v1/...)。値は検証済み・エンコード済みであること */
  path: string;
  body?: Record<string, unknown>;
  timeoutMs: number;
  /** true なら 2xx の本文が JSON でなくても成功とする(書き込みの結果を「失敗」と誤記録しないため) */
  allowNonJson?: boolean;
}

export type RconResult =
  | { ok: true; status: number; data: unknown }
  | {
      ok: false;
      code: ApiErrorCode;
      /** RCON の HTTP ステータス。届かなかった場合は null */
      status: number | null;
      retryAfterSec?: number;
      rconMessage?: string;
    };

export interface ClientDeps {
  fetchFn?: FetchFn;
  /** ログ出力(テストで差し替える)。既定は console.warn(失敗時のみ) */
  log?: (entry: { route: string; status: number | null; ms: number; code: ApiErrorCode }) => void;
}

const defaultLog: NonNullable<ClientDeps['log']> = (e) => console.warn(JSON.stringify({ kind: 'rcon', ...e }));

/** RCON のエラー文: 200 文字に切り詰め、制御文字を除く。JSON の文字列フィールドからだけ取る */
export function extractRconMessage(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const o = data as Record<string, unknown>;
  let s: unknown = o.error ?? o.message ?? o.detail;
  if (typeof s === 'object' && s !== null) s = (s as Record<string, unknown>).message;
  if (typeof s !== 'string') return undefined;
  const cleaned = Array.from(s.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').trim())
    .slice(0, RCON_MESSAGE_MAX)
    .join('');
  return cleaned === '' ? undefined : cleaned;
}

/** Retry-After(秒 または HTTP 日付)を秒に。解釈できなければ既定値 */
export function parseRetryAfter(v: string | null, now = Date.now()): number {
  if (!v) return RETRY_AFTER_DEFAULT_SEC;
  const t = v.trim();
  let sec: number;
  if (/^\d+$/.test(t)) sec = Number(t);
  else {
    const at = Date.parse(t);
    sec = Number.isFinite(at) ? Math.ceil((at - now) / 1000) : RETRY_AFTER_DEFAULT_SEC;
  }
  return Math.min(RETRY_AFTER_MAX_SEC, Math.max(1, sec));
}

function tryJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  const text = new TextDecoder().decode(bytes).trim();
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function rconRequest(cfg: RconConfig, req: RconRequest, deps: ClientDeps = {}): Promise<RconResult> {
  const fetchFn: FetchFn = deps.fetchFn ?? ((i, init) => fetch(i, init));
  const log = deps.log ?? defaultLog;
  const started = Date.now();
  const name = routeKey(req.route);
  const fail = (code: ApiErrorCode, status: number | null, extra: { retryAfterSec?: number; rconMessage?: string } = {}): RconResult => {
    log({ route: name, status, ms: Date.now() - started, code });
    return { ok: false, code, status, ...extra };
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.password}`,
    Accept: 'application/json',
  };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    let res: Response;
    try {
      res = await fetchFn(`${cfg.baseUrl}${req.path}`, {
        method: req.route.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        redirect: 'manual',
        // compatibility_date 2024-11-11 以降の Workers で有効(cache_option_enabled)
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      // 例外の文字列には接続先が含まれ得るので使わない
      return fail(controller.signal.aborted ? 'RCON_TIMEOUT' : 'RCON_UNREACHABLE', null);
    }

    const status = res.status;
    const read = await readLimited(res.body, MAX_RESPONSE_BYTES);
    if (read === 'error') return fail(controller.signal.aborted ? 'RCON_TIMEOUT' : 'RCON_BAD_RESPONSE', status);
    if (read === 'too_large') return fail('RCON_BAD_RESPONSE', status);
    const parsed = tryJson(read);

    if (status >= 200 && status < 300) {
      if (parsed.ok) return { ok: true, status, data: parsed.value };
      if (req.allowNonJson) return { ok: true, status, data: null };
      return fail('RCON_BAD_RESPONSE', status);
    }
    // redirect: 'manual' の 3xx(Bearer を別の宛先に送らない)。status 0 は opaque redirect
    if (status === 0 || (status >= 300 && status < 400)) return fail('RCON_BAD_RESPONSE', status);
    if (status === 401 || status === 403) return fail('RCON_AUTH_FAILED', status);
    if (status === 404) return fail('RCON_ROUTE_NOT_FOUND', status);
    if (status === 429) return fail('RCON_RATE_LIMITED', status, { retryAfterSec: parseRetryAfter(res.headers.get('Retry-After')) });
    if (status >= 400 && status < 500) {
      const msg = parsed.ok ? extractRconMessage(parsed.value) : undefined;
      return fail('RCON_REJECTED', status, msg === undefined ? {} : { rconMessage: msg });
    }
    if (status >= 500) return fail('RCON_ERROR', status);
    return fail('RCON_BAD_RESPONSE', status);
  } finally {
    clearTimeout(timer);
  }
}
