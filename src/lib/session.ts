// ログイン Cookie の発行・検証。docs/ARCHITECTURE.md 5.3。
// 値: v2.<aid>.<sid>.<iat>.<exp>.<op>.<sig>
//   sig = HMAC-SHA256(session 鍵, "v2.<aid>.<sid>.<iat>.<exp>.<op>." + その管理者の session_stamp) の base64url
// 検証では署名を確かめる前に admins から aid の行を主キーで読む(キャッシュしない)。行が無い・session_stamp が違う → 未ログイン扱い。
// Cookie の値・sid 全体・session_stamp をログや応答に出さない(画面・監査ログには先頭 8 文字の sessionTag だけ)。
import { OPERATOR_NAME_MAX_LENGTH, SESSION_TTL_MS } from '../types/api';
import type { SessionInfo } from '../types/api';
import { b64urlToBytes, b64urlToUtf8, bytesToB64url, hmac, randomB64url, timingSafeEqualBytes, utf8ToB64url } from './keys';

export const COOKIE_NAME_PROD = '__Host-wo_session';
/** 開発時(http://localhost)用。__Host- と Secure が使えない場合に備える(要確認 C-14) */
export const COOKIE_NAME_DEV = 'wo_session';

export interface SessionData {
  /** 管理者の admins.id */
  aid: number;
  /** セッション ID(16 バイト乱数の base64url)。外に出さない */
  sid: string;
  iat: number;
  exp: number;
  operator: string | null;
}

/** 署名の検証に使う管理者の行(admins.id と session_stamp) */
export interface SessionAdmin {
  id: number;
  session_stamp: string;
}

const MAX_COOKIE_LENGTH = 512;

/** 操作者名を整える: 制御文字を除き、前後の空白を除き、32 文字(コードポイント)まで。空なら null */
export function sanitizeOperator(input: string | null | undefined): string | null {
  const s = Array.from((input ?? '').replace(/[\p{Cc}\u2028\u2029]/gu, '').trim())
    .slice(0, OPERATOR_NAME_MAX_LENGTH)
    .join('')
    .trim();
  return s === '' ? null : s;
}

function signingInput(body: string, stamp: string): string {
  return `${body}.${stamp}`;
}

export async function issueSession(
  key: CryptoKey,
  admin: SessionAdmin,
  opts: { operator?: string | null; now?: number } = {},
): Promise<{ value: string; data: SessionData }> {
  const iat = opts.now ?? Date.now();
  const exp = iat + SESSION_TTL_MS;
  const sid = randomB64url(16);
  const operator = sanitizeOperator(opts.operator);
  const op = operator ? utf8ToB64url(operator) : '';
  const body = `v2.${admin.id}.${sid}.${iat}.${exp}.${op}`;
  const sig = bytesToB64url(await hmac(key, signingInput(body, admin.session_stamp)));
  return { value: `${body}.${sig}`, data: { aid: admin.id, sid, iat, exp, operator } };
}

/**
 * Cookie を検証する。形式を確かめた後に lookup(aid) で管理者の行を読み、その session_stamp を混ぜて署名を確かめる。
 * v1(旧方式)は形式不正。lookup の例外(D1 の障害)はそのまま投げる
 */
export async function verifySession(
  key: CryptoKey,
  value: string | null | undefined,
  lookup: (aid: number) => Promise<SessionAdmin | null>,
  now = Date.now(),
): Promise<SessionData | null> {
  if (!value || value.length > MAX_COOKIE_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 7) return null;
  const [v, aidS = '', sid = '', iatS = '', expS = '', op = '', sig = ''] = parts;
  if (
    v !== 'v2' ||
    !/^[1-9][0-9]{0,15}$/.test(aidS) ||
    !/^[A-Za-z0-9_-]{22}$/.test(sid) ||
    !/^\d{1,16}$/.test(iatS) ||
    !/^\d{1,16}$/.test(expS) ||
    !/^[A-Za-z0-9_-]*$/.test(op)
  ) {
    return null;
  }
  const sigBytes = b64urlToBytes(sig);
  if (!sigBytes || sigBytes.byteLength !== 32) return null;
  const aid = Number(aidS);
  const admin = await lookup(aid);
  if (!admin || Number(admin.id) !== aid) return null;
  const expected = await hmac(key, signingInput(`v2.${aidS}.${sid}.${iatS}.${expS}.${op}`, admin.session_stamp));
  if (!timingSafeEqualBytes(sigBytes, expected)) return null;
  const iat = Number(iatS);
  const exp = Number(expS);
  // 期限切れ・未来の発行時刻(時計のずれ 5 分まで許す)・期間の改ざんを拒否する
  if (now >= exp || iat > now + 5 * 60 * 1000 || exp - iat !== SESSION_TTL_MS) return null;
  let operator: string | null = null;
  if (op !== '') {
    const decoded = b64urlToUtf8(op);
    if (decoded === null) return null;
    operator = sanitizeOperator(decoded);
  }
  return { aid, sid, iat, exp, operator };
}

export function toSessionInfo(data: SessionData): SessionInfo {
  return { sessionTag: data.sid.slice(0, 8), operator: data.operator, issuedAt: data.iat, expiresAt: data.exp };
}

export function cookieName(dev: boolean): string {
  return dev ? COOKIE_NAME_DEV : COOKIE_NAME_PROD;
}

export function serializeSessionCookie(value: string, dev: boolean, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000)): string {
  const attrs = [`${cookieName(dev)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (!dev) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie(dev: boolean): string {
  return serializeSessionCookie('', dev, 0);
}

/** Cookie ヘッダから 1 つの値を取り出す(同名が複数あれば最初のもの) */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// middleware が検証したセッション(sid 全体を含む)を API ハンドラに渡すための入れ物。
// App.Locals(契約)には SessionInfo しか無いため、locals オブジェクトをキーにした WeakMap で持つ
const sessionByLocals = new WeakMap<object, SessionData>();

export function attachSession(locals: object, data: SessionData): void {
  sessionByLocals.set(locals, data);
}

export function getAttachedSession(locals: object): SessionData | null {
  return sessionByLocals.get(locals) ?? null;
}
