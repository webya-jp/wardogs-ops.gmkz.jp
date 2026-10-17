// 書き込み操作の確認トークン(prepare → execute)。docs/ARCHITECTURE.md 4.3、docs/API.md 4 章。
// 形式: v1.<payload>.<sig>
//   payload = base64url(JSON { v:1, a:action, h:SHA-256(正規化 params の JSON) 先頭 128 bit, s:セッション ID, e:期限, n:nonce 128 bit, t?:対象名,
//                              sv:ServerId, sh:SHA-256(対象サーバーの baseUrl) 先頭 128 bit })
//   sig     = base64url(HMAC-SHA256(confirm 鍵, "v1.<payload>"))
// 中身は秘密ではないが改ざんできない。1 回限りの保証は audit_log.confirm_nonce の UNIQUE で行う(D1 必須)。
// a には record_start / record_stop も入る(17.2。その 1 回限りは settings_audit_log.confirm_nonce の UNIQUE)。
// t(対象名)は監査ログの target_name に使う。sv / sh は別サーバーへのすり替えと prepare 後の宛先変更を検出する(ARCHITECTURE 15.6)。
import { CONFIRM_TTL_MS } from '../types/api';
import { SERVER_ID_PATTERN } from '../types/api';
import type { ConfirmableAction, ServerId } from '../types/api';
import { b64urlToBytes, b64urlToUtf8, bytesToB64url, hmac, randomB64url, sha256, timingSafeEqualBytes, utf8ToB64url } from './keys';
import { isConfirmableAction } from './validate';

const MAX_TOKEN_LENGTH = 1024;
const TARGET_NAME_MAX = 64;

/** キーを並べ替えた JSON(params は平坦だが、念のため再帰的に並べる) */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** 対象サーバーの宛先のハッシュ(SHA-256(baseUrl) の先頭 128 bit の base64url)。baseUrl 自体はトークンに入れない */
export async function serverHash(baseUrl: string): Promise<string> {
  return bytesToB64url((await sha256(baseUrl)).slice(0, 16));
}

export async function paramsHash(params: unknown): Promise<string> {
  return bytesToB64url((await sha256(canonicalJson(params))).slice(0, 16));
}

interface Payload {
  v: 1;
  a: ConfirmableAction;
  h: string;
  s: string;
  e: number;
  n: string;
  t?: string;
  sv: ServerId;
  sh: string;
}

export interface IssueInput {
  /** 書き込み操作、またはスコア記録の開始・停止(docs/ARCHITECTURE.md 17.2。形式・検証の順序は同じ) */
  action: ConfirmableAction;
  params: unknown;
  sid: string;
  targetName?: string | null;
  /** 対象サーバーの id と、その時点の baseUrl */
  server: ServerId;
  baseUrl: string;
  now?: number;
}

export async function issueConfirmToken(
  key: CryptoKey,
  input: IssueInput,
): Promise<{ token: string; nonce: string; expiresAt: number }> {
  const now = input.now ?? Date.now();
  const expiresAt = now + CONFIRM_TTL_MS;
  const nonce = randomB64url(16);
  const payload: Payload = {
    v: 1,
    a: input.action,
    h: await paramsHash(input.params),
    s: input.sid,
    e: expiresAt,
    n: nonce,
    sv: input.server,
    sh: await serverHash(input.baseUrl),
  };
  if (input.targetName) payload.t = Array.from(input.targetName).slice(0, TARGET_NAME_MAX).join('');
  const body = `v1.${utf8ToB64url(JSON.stringify(payload))}`;
  const sig = bytesToB64url(await hmac(key, body));
  return { token: `${body}.${sig}`, nonce, expiresAt };
}

export type ConfirmVerifyResult =
  | { ok: true; nonce: string; targetName: string | null; expiresAt: number }
  | { ok: false; code: 'CONFIRM_INVALID' | 'CONFIRM_EXPIRED' };

/** 署名・形式だけを確かめて payload を返す */
async function decode(key: CryptoKey, token: unknown): Promise<Payload | null> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payloadB64 = '', sigB64 = ''] = parts;
  const sig = b64urlToBytes(sigB64);
  if (!sig || sig.byteLength !== 32) return null;
  const expected = await hmac(key, `v1.${payloadB64}`);
  if (!timingSafeEqualBytes(sig, expected)) return null;
  const json = b64urlToUtf8(payloadB64);
  if (json === null) return null;
  let p: unknown;
  try {
    p = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (
    o.v !== 1 ||
    !isConfirmableAction(o.a) ||
    typeof o.h !== 'string' ||
    typeof o.s !== 'string' ||
    typeof o.e !== 'number' ||
    typeof o.n !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(o.n) ||
    (o.t !== undefined && typeof o.t !== 'string') ||
    typeof o.sv !== 'string' ||
    !SERVER_ID_PATTERN.test(o.sv) ||
    typeof o.sh !== 'string'
  ) {
    return null;
  }
  return o as unknown as Payload;
}

export interface BaseExpect {
  action: ConfirmableAction;
  params: unknown;
  sid: string;
}

/** 検証の 1〜3(署名・形式 → セッション一致 → action と params のハッシュ)だけを行う。通れば payload を返す */
async function verifyBase(key: CryptoKey, token: unknown, expect: BaseExpect): Promise<Payload | null> {
  const p = await decode(key, token);
  if (!p) return null;
  if (!timingSafeEqualStr(p.s, expect.sid)) return null;
  if (p.a !== expect.action || p.h !== (await paramsHash(expect.params))) return null;
  return p;
}

/**
 * 検証の 1〜3 だけを確かめる(execute でサーバーの解決に失敗したとき、CONFIRM_INVALID を SERVER_* より優先するため)
 */
export async function confirmTokenBaseValid(key: CryptoKey, token: unknown, expect: BaseExpect): Promise<boolean> {
  return (await verifyBase(key, token, expect)) !== null;
}

/**
 * 検証の順序(docs/API.md 4 章): 1 署名・形式 → 2 セッション一致 → 3 action と params のハッシュ
 * → 3' sv が本文の server と一致し、sh が現在の baseUrl と一致 → 4 期限
 */
export async function verifyConfirmToken(
  key: CryptoKey,
  token: unknown,
  expect: BaseExpect & { server: ServerId; baseUrl: string; now?: number },
): Promise<ConfirmVerifyResult> {
  const p = await verifyBase(key, token, expect);
  if (!p) return { ok: false, code: 'CONFIRM_INVALID' };
  if (p.sv !== expect.server || !timingSafeEqualStr(p.sh, await serverHash(expect.baseUrl))) {
    return { ok: false, code: 'CONFIRM_INVALID' };
  }
  const now = expect.now ?? Date.now();
  if (now >= p.e) return { ok: false, code: 'CONFIRM_EXPIRED' };
  return { ok: true, nonce: p.n, targetName: p.t ?? null, expiresAt: p.e };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && timingSafeEqualBytes(x, y);
}
