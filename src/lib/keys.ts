// HKDF による鍵の派生と、base64url・HMAC の小道具。docs/ARCHITECTURE.md 5.1。
// ikm = UTF-8(SESSION_SECRET ?? "") || 0x00 || UTF-8(ADMIN_PASSWORD)
// 鍵・ikm をログや戻り値に出さない。
import type { OpsEnv } from '../types/env';

export interface DerivedKeys {
  session: CryptoKey;
  confirm: CryptoKey;
  ipHash: CryptoKey;
  passwordCompare: CryptoKey;
}

const SALT = 'wardogs-ops/v1';
const enc = new TextEncoder();

let cached: { ikm: string; keys: Promise<DerivedKeys> } | null = null;

async function deriveHmacKey(base: CryptoKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT), info: enc.encode(info) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export async function deriveKeysFrom(sessionSecret: string, adminPassword: string): Promise<DerivedKeys> {
  const ikm = new Uint8Array([...enc.encode(sessionSecret), 0, ...enc.encode(adminPassword)]);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const [session, confirm, ipHash, passwordCompare] = await Promise.all([
    deriveHmacKey(base, 'session'),
    deriveHmacKey(base, 'confirm'),
    deriveHmacKey(base, 'ip-hash'),
    deriveHmacKey(base, 'password-compare'),
  ]);
  return { session, confirm, ipHash, passwordCompare };
}

/** env から鍵を派生する(isolate 内で直近 1 組だけキャッシュ。Secrets が変われば作り直す) */
export function getKeys(env: OpsEnv): Promise<DerivedKeys> {
  const ss = env.SESSION_SECRET ?? '';
  const ap = env.ADMIN_PASSWORD ?? '';
  const ikm = `${ss}\u0000${ap}`;
  if (cached && cached.ikm === ikm) return cached.keys;
  const keys = deriveKeysFrom(ss, ap);
  cached = { ikm, keys };
  keys.catch(() => {
    if (cached?.keys === keys) cached = null;
  });
  return keys;
}

// ------------------------------------------------------------
// 登録サーバーの RCON パスワードの暗号鍵(AES-256-GCM)。docs/ARCHITECTURE.md 15.3
// ikm は上の鍵と分ける: k = "s" は SESSION_SECRET だけ、k = "a" は ADMIN_PASSWORD だけ
// ------------------------------------------------------------

/** 鍵の出所。s = SESSION_SECRET 由来、a = ADMIN_PASSWORD 由来 */
export type ServerKeyId = 's' | 'a';

export interface ServerPasswordKeys {
  /** SESSION_SECRET が設定されているときだけ非 null */
  s: CryptoKey | null;
  /** ADMIN_PASSWORD が設定されているときだけ非 null */
  a: CryptoKey | null;
  /** 新しく暗号化するときに使う鍵の出所(SESSION_SECRET があれば s)。どちらも無ければ null */
  preferred: ServerKeyId | null;
}

export async function deriveServerPasswordKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT), info: enc.encode('server-password') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function deriveServerPasswordKeysFrom(sessionSecret: string, adminPassword: string): Promise<ServerPasswordKeys> {
  const [s, a] = await Promise.all([
    sessionSecret === '' ? Promise.resolve(null) : deriveServerPasswordKey(sessionSecret),
    adminPassword === '' ? Promise.resolve(null) : deriveServerPasswordKey(adminPassword),
  ]);
  return { s, a, preferred: s ? 's' : a ? 'a' : null };
}

let serverKeysCache: { ikm: string; keys: Promise<ServerPasswordKeys> } | null = null;

/** env から暗号鍵を派生する(isolate 内で直近 1 組だけキャッシュ) */
export function getServerPasswordKeys(env: OpsEnv): Promise<ServerPasswordKeys> {
  const ss = env.SESSION_SECRET ?? '';
  const ap = env.ADMIN_PASSWORD ?? '';
  const ikm = `${ss}\u0000${ap}`;
  if (serverKeysCache && serverKeysCache.ikm === ikm) return serverKeysCache.keys;
  const keys = deriveServerPasswordKeysFrom(ss, ap);
  serverKeysCache = { ikm, keys };
  keys.catch(() => {
    if (serverKeysCache?.keys === keys) serverKeysCache = null;
  });
  return keys;
}

// ------------------------------------------------------------
// エンコード・HMAC
// ------------------------------------------------------------

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function utf8ToB64url(s: string): string {
  return bytesToB64url(enc.encode(s));
}

export function b64urlToUtf8(s: string): string | null {
  const bytes = b64urlToBytes(s);
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmac(key: CryptoKey, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

export function randomB64url(byteLength: number): string {
  const b = new Uint8Array(byteLength);
  crypto.getRandomValues(b);
  return bytesToB64url(b);
}

/**
 * 定数時間比較。Workers の crypto.subtle.timingSafeEqual があれば使い、無ければ(Node のテスト等)XOR の累積で比べる。
 * 長さが違えば false(長さは呼び出し側で HMAC により揃えてある前提)。
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ------------------------------------------------------------
// 接続元 IP のハッシュ(生の IP は保存しない)
// ------------------------------------------------------------

/** IPv6 は /64 に丸める。IPv4 射影アドレスは IPv4 として扱う */
export function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  const mapped = /^(?:::ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped?.[1]) return mapped[1];
  if (!v.includes(':')) return v;
  const [head = '', tail] = v.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : Math.max(0, 8 - headParts.length - tailParts.length);
  const parts = [...headParts, ...Array<string>(fill).fill('0'), ...tailParts];
  return `${parts
    .slice(0, 4)
    .map((p) => (p.replace(/^0+(?=.)/, '') || '0'))
    .join(':')}::/64`;
}

/** HMAC(ip-hash 鍵, 正規化した IP) の先頭 16 桁(16 進) */
export async function hashClientIp(keys: DerivedKeys, ip: string): Promise<string> {
  return toHex(await hmac(keys.ipHash, normalizeIp(ip))).slice(0, 16);
}
