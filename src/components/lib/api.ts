// ブラウザから /api/* を呼ぶ小さなラッパー(React アイランド専用)。
// - fetch は credentials: 'same-origin'。401 ならログイン画面へ移動する
// - 応答は ApiResponse<T>。表示文言は返らないので、失敗は code(とパラメータ)だけを持ち帰る
// - 通信自体の失敗はカタログの error.NETWORK を引けるよう code: 'NETWORK' にする
import { API_ERROR_CODES } from '../../types/api';
import type { ApiErrorCode, ApiFailure } from '../../types/api';

export type ClientErrorCode = ApiErrorCode | 'NETWORK';
export type ClientError = Omit<ApiFailure['error'], 'code' | 'message'> & { code: ClientErrorCode };
export type Result<T> = { ok: true; data: T } | { ok: false; error: ClientError };

const KNOWN_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toClientError(raw: unknown, status: number): ClientError {
  if (isObject(raw) && typeof raw.code === 'string' && KNOWN_CODES.has(raw.code)) {
    const out: ClientError = { code: raw.code as ApiErrorCode };
    if (isObject(raw.fields)) out.fields = raw.fields as ClientError['fields'];
    if (typeof raw.retryAfterSec === 'number') out.retryAfterSec = raw.retryAfterSec;
    if (typeof raw.rconMessage === 'string') out.rconMessage = raw.rconMessage;
    return out;
  }
  return { code: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST' };
}

async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    return { ok: false, error: { code: 'NETWORK' } };
  }
  if (res.status === 401) {
    window.location.assign('/login');
    return { ok: false, error: { code: 'UNAUTHENTICATED' } };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: { code: res.ok ? 'INTERNAL_ERROR' : toClientError(null, res.status).code } };
  }
  if (isObject(body) && body.ok === true && 'data' in body) return { ok: true, data: body.data as T };
  if (isObject(body) && body.ok === false) return { ok: false, error: toClientError(body.error, res.status) };
  return { ok: false, error: { code: 'INTERNAL_ERROR' } };
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<Result<T>> {
  return request<T>(path, { method: 'GET' }, signal);
}

function sendJson<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, signal?: AbortSignal): Promise<Result<T>> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
}

export function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<Result<T>> {
  return sendJson<T>('POST', path, body, signal);
}

export function apiPut<T>(path: string, body: unknown, signal?: AbortSignal): Promise<Result<T>> {
  return sendJson<T>('PUT', path, body, signal);
}

/** DELETE は本文必須(docs/API.md 1 章・7 章) */
export function apiDelete<T>(path: string, body: unknown, signal?: AbortSignal): Promise<Result<T>> {
  return sendJson<T>('DELETE', path, body, signal);
}

/** 読み取り API のパスに対象サーバーを付ける(docs/ARCHITECTURE.md 15.5。画面は常に明示して送る) */
export function withServer(path: string, serverId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}server=${encodeURIComponent(serverId)}`;
}

/** AbortController で中断された結果か(画面に出さない) */
export function isAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
