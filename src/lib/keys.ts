// instance_key(D1 settings)の取得と HKDF による用途別の鍵の派生、base64url・HMAC の小道具。docs/ARCHITECTURE.md 5.1.2・15.3。
// - instance_key: 32 バイトの乱数(base64url)。必要になった時点で INSERT OR IGNORE → SELECT(並行しても最初の 1 つだけが使われる)
// - 鍵: HKDF-SHA256(ikm = instance_key, salt = "wardogs-ops/v1", info = session / confirm / ip-hash / server-password)。extractable: false
// - isolate 内で 5 分キャッシュする(毎リクエストの D1 読み取りを避ける)
// instance_key・鍵をログや戻り値(API 応答)に出さない。
import { INSTANCE_KEY_BYTES } from '../types/env';

export interface DerivedKeys {
  /** ログイン Cookie の署名(HMAC-SHA256) */
  session: CryptoKey;
  /** 確認トークンの署名(HMAC-SHA256) */
  confirm: CryptoKey;
  /** 接続元 IP のハッシュ(HMAC-SHA256) */
  ipHash: CryptoKey;
  /** 登録サーバーの RCON パスワードの暗号化(AES-256-GCM) */
  serverPassword: CryptoKey;
}

const SALT = 'wardogs-ops/v1';
const INSTANCE_KEY_NAME = 'instance_key';
const enc = new TextEncoder();

async function deriveHmacKey(base: CryptoKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT), info: enc.encode(info) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

async function deriveAesKey(base: CryptoKey, info: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT), info: enc.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** instance_key のバイト列から用途別の鍵を派生する */
export async function deriveKeysFrom(instanceKey: Uint8Array): Promise<DerivedKeys> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(instanceKey), 'HKDF', false, ['deriveKey']);
  const [session, confirm, ipHash, serverPassword] = await Promise.all([
    deriveHmacKey(base, 'session'),
    deriveHmacKey(base, 'confirm'),
    deriveHmacKey(base, 'ip-hash'),
    deriveAesKey(base, 'server-password'),
  ]);
  return { session, confirm, ipHash, serverPassword };
}

/** D1 settings の instance_key を読む。無ければ作る(INSERT OR IGNORE → SELECT)。形式が壊れていれば例外 */
export async function loadInstanceKey(db: D1Database, now = Date.now()): Promise<Uint8Array> {
  const read = () =>
    db.prepare('SELECT value FROM settings WHERE key = ?1').bind(INSTANCE_KEY_NAME).first<{ value: string }>();
  let row = await read();
  if (!row) {
    await db
      .prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)')
      .bind(INSTANCE_KEY_NAME, randomB64url(INSTANCE_KEY_BYTES), now)
      .run();
    row = await read();
  }
  const bytes = row ? b64urlToBytes(row.value) : null;
  if (!bytes || bytes.byteLength !== INSTANCE_KEY_BYTES) throw new Error('INSTANCE_KEY_INVALID');
  return bytes;
}

const KEYS_CACHE_MS = 5 * 60 * 1000;
let cached: { db: D1Database; at: number; keys: Promise<DerivedKeys> } | null = null;

/** テスト用 */
export function resetKeysCacheForTest(): void {
  cached = null;
}

/**
 * D1 から鍵を用意する(isolate 内で 5 分キャッシュ)。D1 の失敗はキャッシュせず例外のまま返す。
 * instance_key を手で消した直後の最大 5 分は isolate ごとに新旧の鍵が混在し得る(docs/ARCHITECTURE.md 5.1.2 で受け入れ済み)
 */
export function getKeys(db: D1Database, now = Date.now()): Promise<DerivedKeys> {
  if (cached && cached.db === db && now - cached.at < KEYS_CACHE_MS) return cached.keys;
  const keys = loadInstanceKey(db, now).then(deriveKeysFrom);
  const entry = { db, at: now, keys };
  cached = entry;
  keys.catch(() => {
    if (cached === entry) cached = null;
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
