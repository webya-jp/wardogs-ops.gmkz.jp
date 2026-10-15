// パスワードの定数時間比較。docs/ARCHITECTURE.md 5.2。
// HMAC(password-compare 鍵, 入力) と HMAC(同, ADMIN_PASSWORD) を比べる(長さの差も隠れる)。
// 入力・正解をログや戻り値に出さない。
import { hmac, timingSafeEqualBytes } from './keys';

/** 評価する入力の最大長(文字数) */
export const PASSWORD_INPUT_MAX = 256;

export async function verifyPassword(compareKey: CryptoKey, input: string, expected: string): Promise<boolean> {
  if (expected === '') return false;
  const truncated = Array.from(input).slice(0, PASSWORD_INPUT_MAX).join('');
  const [a, b] = await Promise.all([hmac(compareKey, truncated), hmac(compareKey, expected)]);
  return timingSafeEqualBytes(a, b);
}
