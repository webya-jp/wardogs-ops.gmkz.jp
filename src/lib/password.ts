// 管理パスワードのハッシュ化・検証(PBKDF2-HMAC-SHA256)。docs/ARCHITECTURE.md 5.2。
// 保存形式: pbkdf2-sha256$<反復回数>$<salt(base64url)>$<導出値(base64url)>
// 入力・保存値・導出値をログや戻り値に出さない(破損時に Workers Logs に出すのはコード PASSWORD_HASH_INVALID だけ)。
import { ADMIN_PASSWORD_MAX_LENGTH } from '../types/api';
import {
  PASSWORD_HASH_BYTES,
  PASSWORD_HASH_ITERATIONS,
  PASSWORD_HASH_ITERATIONS_MAX,
  PASSWORD_HASH_ITERATIONS_MIN,
  PASSWORD_HASH_SALT_BYTES,
  PASSWORD_HASH_SCHEME,
} from '../types/env';
import { b64urlToBytes, bytesToB64url, timingSafeEqualBytes } from './keys';

const enc = new TextEncoder();

/** 評価する入力の最大長(文字数、コードポイント)。登録時に 256 文字超を拒否するので、登録したパスワードは常に全体が評価される */
export const PASSWORD_INPUT_MAX = ADMIN_PASSWORD_MAX_LENGTH;

/** 入力を 256 文字(コードポイント)で打ち切る。正規化・前後の空白の除去はしない */
export function truncatePasswordInput(input: string): string {
  return Array.from(input).slice(0, PASSWORD_INPUT_MAX).join('');
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
    base,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 新しい salt でハッシュを作る。iterations はテストで小さくするための引数(本番は既定値。範囲外は例外)
 */
export async function hashPassword(password: string, iterations: number = PASSWORD_HASH_ITERATIONS): Promise<string> {
  if (!Number.isInteger(iterations) || iterations < PASSWORD_HASH_ITERATIONS_MIN || iterations > PASSWORD_HASH_ITERATIONS_MAX) {
    throw new Error('PASSWORD_HASH_ITERATIONS_OUT_OF_RANGE');
  }
  const salt = new Uint8Array(PASSWORD_HASH_SALT_BYTES);
  crypto.getRandomValues(salt);
  const dk = await pbkdf2(truncatePasswordInput(password), salt, iterations);
  return `${PASSWORD_HASH_SCHEME}$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(dk)}`;
}

export interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/** 保存値を解釈する。形式不正・反復回数が範囲外・長さ違いは null(破損として扱う) */
export function parsePasswordHash(stored: string | null | undefined): ParsedHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 4) return null;
  const [scheme, itS = '', saltS = '', hashS = ''] = parts;
  if (scheme !== PASSWORD_HASH_SCHEME || !/^[1-9][0-9]{0,8}$/.test(itS)) return null;
  const iterations = Number(itS);
  if (iterations < PASSWORD_HASH_ITERATIONS_MIN || iterations > PASSWORD_HASH_ITERATIONS_MAX) return null;
  const salt = b64urlToBytes(saltS);
  const hash = b64urlToBytes(hashS);
  if (!salt || salt.byteLength !== PASSWORD_HASH_SALT_BYTES || !hash || hash.byteLength !== PASSWORD_HASH_BYTES) return null;
  return { iterations, salt, hash };
}

export type VerifyResult =
  /** needsRehash: 保存値の反復回数が現在の PASSWORD_HASH_ITERATIONS と違う(ログイン成功時に保存し直す) */
  | { ok: true; needsRehash: boolean }
  | { ok: false; invalidHash: boolean };

/** 入力を保存値と同じ salt・回数で導出し、32 バイト同士を定数時間で比べる */
export async function verifyPasswordHash(input: string, stored: string | null | undefined): Promise<VerifyResult> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return { ok: false, invalidHash: true };
  if (input === '') return { ok: false, invalidHash: false };
  const dk = await pbkdf2(truncatePasswordInput(input), parsed.salt, parsed.iterations);
  if (!timingSafeEqualBytes(dk, parsed.hash)) return { ok: false, invalidHash: false };
  return { ok: true, needsRehash: parsed.iterations !== PASSWORD_HASH_ITERATIONS };
}
