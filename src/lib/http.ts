// JSON 応答・エラー整形・本文の読み取り・セキュリティヘッダ。docs/API.md 1 章、docs/ARCHITECTURE.md 5.7。
// cloudflare:workers に依存させない(単体テストできるようにする)。
// エラー応答に Secrets・接続先・内部例外の文字列・入力値を含めない。表示文言は返さない(画面がカタログで引く)。
import { API_ERROR_STATUS, MAX_REQUEST_BYTES } from '../types/api';
import type { ApiErrorCode, ApiFailure, ValidationIssue } from '../types/api';

/** 開発者向けの英語固定の短い説明(画面には出さない) */
const DEV_MESSAGES: Record<ApiErrorCode, string> = {
  BAD_REQUEST: 'Bad request',
  VALIDATION_FAILED: 'Validation failed',
  UNAUTHENTICATED: 'Not logged in',
  FORBIDDEN_ORIGIN: 'Origin check failed',
  NOT_FOUND: 'Not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA_TYPE: 'Content-Type must be application/json',
  RATE_LIMITED: 'Rate limited',
  CONFIRM_INVALID: 'Confirm token is invalid',
  CONFIRM_EXPIRED: 'Confirm token expired',
  ALREADY_EXECUTED: 'Already executed',
  CAPABILITY_MISSING: 'Route not provided by this RCON build',
  WRITES_DISABLED: 'Writes are disabled (audit log unavailable)',
  NOT_CONFIGURED: 'D1 unavailable or not migrated',
  SETUP_REQUIRED: 'Admin password is not registered yet',
  SERVER_NOT_FOUND: 'Server not found',
  SERVER_DISABLED: 'Server is disabled',
  SERVER_NEEDS_PASSWORD: 'Stored RCON password cannot be decrypted',
  SERVER_LIMIT_REACHED: 'Server limit reached',
  NO_SERVERS: 'No server is configured',
  RCON_UNREACHABLE: 'RCON unreachable',
  RCON_TIMEOUT: 'RCON request timed out',
  RCON_AUTH_FAILED: 'RCON authentication failed',
  RCON_RATE_LIMITED: 'RCON rate limited',
  RCON_ROUTE_NOT_FOUND: 'RCON route not found',
  RCON_REJECTED: 'RCON rejected the request',
  RCON_BAD_RESPONSE: 'RCON response could not be parsed',
  RCON_ERROR: 'RCON server error',
  INTERNAL_ERROR: 'Internal error',
};

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function jsonOk<T>(data: T, headers: Record<string, string> = {}): Response {
  return jsonResponse({ ok: true, data }, 200, headers);
}

export interface ErrorOptions {
  fields?: Record<string, ValidationIssue>;
  retryAfterSec?: number;
  rconMessage?: string;
  headers?: Record<string, string>;
}

export function buildError(code: ApiErrorCode, opts: ErrorOptions = {}): ApiFailure {
  const error: ApiFailure['error'] = { code, message: DEV_MESSAGES[code] };
  if (opts.fields) error.fields = opts.fields;
  if (opts.retryAfterSec !== undefined) error.retryAfterSec = opts.retryAfterSec;
  if (opts.rconMessage !== undefined) error.rconMessage = opts.rconMessage;
  return { ok: false, error };
}

export function jsonError(code: ApiErrorCode, opts: ErrorOptions = {}): Response {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.retryAfterSec !== undefined && headers['Retry-After'] === undefined) {
    headers['Retry-After'] = String(opts.retryAfterSec);
  }
  return jsonResponse(buildError(code, opts), API_ERROR_STATUS[code], headers);
}

export const methodNotAllowed = (): Response => jsonError('METHOD_NOT_ALLOWED');

/** ストリームを最大 maxBytes まで読む。超えた時点で読み取りを中止する */
export async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | 'too_large' | 'error'> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch {
    return 'error';
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * 読まずに返す応答の前に本文を捨てる(上限 64 KiB まで読み、超えたら打ち切る)。
 * 未読の本文を残すと、開発サーバー(miniflare)で同じ接続の次のリクエストが失敗することがあったため
 */
const DRAIN_MAX_BYTES = 64 * 1024;

export async function discardBody(request: Request, maxBytes = DRAIN_MAX_BYTES): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  await readLimited(request.body, maxBytes).catch(() => undefined);
}

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Content-Type(application/json 必須)・サイズ(8 KiB)・JSON を確認して読む。
 * POST / PUT / DELETE で共通(docs/API.md 1 章)。本文が空なら JSON として読めないので 400 BAD_REQUEST
 * (本文の無い DELETE は受け付けない)
 */
export async function readJsonBody(request: Request, maxBytes: number = MAX_REQUEST_BYTES): Promise<JsonBodyResult> {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(ct)) {
    await discardBody(request);
    return { ok: false, response: jsonError('UNSUPPORTED_MEDIA_TYPE') };
  }
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > DRAIN_MAX_BYTES) return { ok: false, response: jsonError('PAYLOAD_TOO_LARGE') };
  // 上限を少し超える程度の本文は読み切ってから 413 を返す(未読の本文を残さない。discardBody の注記)
  const read = await readLimited(request.body, DRAIN_MAX_BYTES);
  if (read === 'too_large' || (typeof read !== 'string' && read.byteLength > maxBytes)) {
    return { ok: false, response: jsonError('PAYLOAD_TOO_LARGE') };
  }
  if (read === 'error') return { ok: false, response: jsonError('BAD_REQUEST') };
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(read)) as unknown };
  } catch {
    return { ok: false, response: jsonError('BAD_REQUEST') };
  }
}

/** フォーム(application/x-www-form-urlencoded)を上限付きで読む。形式・サイズが不正なら null */
export async function readFormBody(request: Request, maxBytes: number = MAX_REQUEST_BYTES): Promise<URLSearchParams | null> {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(ct)) {
    await discardBody(request);
    return null;
  }
  const read = await readLimited(request.body, maxBytes);
  if (typeof read === 'string') return null;
  try {
    return new URLSearchParams(new TextDecoder().decode(read));
  } catch {
    return null;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 全応答に付けるヘッダ(docs/ARCHITECTURE.md 5.7) */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  // script-src は絞っていない(Astro のアイランド用インラインスクリプトとの両立が未確認。要確認 C-15)
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  // no-referrer だと Chrome が同一オリジンのフォーム送信でも Origin: null を送り CSRF 検査に落ちるため same-origin にする
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** 応答にセキュリティヘッダと Cache-Control: no-store を付ける(ヘッダが不変の応答は複製する) */
export function withSecurityHeaders(response: Response, noStore = true): Response {
  const apply = (h: Headers) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
    if (noStore) h.set('Cache-Control', 'no-store');
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    apply(copy.headers);
    return copy;
  }
}

/** ページ用の簡易 HTML 応答(403 など)。text は呼び出し側でカタログから引いた文言 */
export function simpleHtml(status: number, lang: string, title: string, text: string): Response {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  const html = `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title></head><body><main><p>${esc(text)}</p></main></body></html>`;
  return withSecurityHeaders(new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
}

export function redirect(location: string, status = 303, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store', ...headers } });
}

/** @astrojs/cloudflare v14 は locals.cfContext に ExecutionContext を置く。無ければ(テスト等)そのまま待たずに捨てる */
export function getWaitUntil(locals: unknown): (p: Promise<unknown>) => void {
  const ctx = (locals as { cfContext?: { waitUntil?: (p: Promise<unknown>) => void } } | null)?.cfContext;
  if (ctx && typeof ctx.waitUntil === 'function') return (p) => ctx.waitUntil!(p.catch(() => undefined));
  return (p) => {
    void p.catch(() => undefined);
  };
}

/** 例外の名前だけを返す(ログ用。メッセージには入力値や接続先が含まれ得るので出さない) */
export function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Unknown';
}

/** 接続元 IP(Cloudflare が付ける CF-Connecting-IP)。開発時など無い場合は固定値 */
export function clientIp(request: Request): string {
  return (request.headers.get('CF-Connecting-IP') ?? '').trim() || 'unknown';
}
