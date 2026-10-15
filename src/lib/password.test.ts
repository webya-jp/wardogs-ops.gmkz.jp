import { describe, expect, it, vi } from 'vitest';
import { deriveKeysFrom, timingSafeEqualBytes } from './keys';
import { PASSWORD_INPUT_MAX, verifyPassword } from './password';

describe('password', () => {
  it('一致・不一致', async () => {
    const pw = 'correct-horse-battery-staple';
    const keys = await deriveKeysFrom('', pw);
    expect(await verifyPassword(keys.passwordCompare, pw, pw)).toBe(true);
    expect(await verifyPassword(keys.passwordCompare, `${pw} `, pw)).toBe(false);
    expect(await verifyPassword(keys.passwordCompare, '', pw)).toBe(false);
    expect(await verifyPassword(keys.passwordCompare, 'x', '')).toBe(false);
  });

  it('入力は 256 文字で打ち切る', async () => {
    const pw = 'a'.repeat(PASSWORD_INPUT_MAX);
    const keys = await deriveKeysFrom('', pw);
    expect(await verifyPassword(keys.passwordCompare, `${pw}zzzz`, pw)).toBe(true);
  });

  it('長さの違う入力でも HMAC で長さを揃えて比べる(長さの差で早期に返さない)', async () => {
    const pw = 'correct-horse-battery-staple';
    const keys = await deriveKeysFrom('', pw);
    const spy = vi.spyOn(crypto.subtle, 'sign');
    await verifyPassword(keys.passwordCompare, 'x', pw);
    // 入力と正解の両方を HMAC してから比較する
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('timingSafeEqualBytes: 全桁を比べ、長さ違いは false', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
