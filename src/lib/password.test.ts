import { describe, expect, it } from 'vitest';
import { PASSWORD_HASH_ITERATIONS, PASSWORD_HASH_ITERATIONS_MAX, PASSWORD_HASH_ITERATIONS_MIN } from '../types/env';
import { timingSafeEqualBytes } from './keys';
import { hashPassword, parsePasswordHash, PASSWORD_INPUT_MAX, verifyPasswordHash } from './password';

const PW = 'correct-horse-battery-staple-01';

describe('password(PBKDF2-SHA256)', () => {
  it('反復回数は 1 万回(定数は types/env.ts の 1 か所)', () => {
    expect(PASSWORD_HASH_ITERATIONS).toBe(10_000);
  });

  it('往復: 保存形式、平文を含まない、salt は毎回変わる', async () => {
    const h = await hashPassword(PW);
    expect(h).toMatch(/^pbkdf2-sha256\$10000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(h).not.toContain(PW);
    expect(await hashPassword(PW)).not.toBe(h);
    expect(await verifyPasswordHash(PW, h)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPasswordHash(`${PW} `, h)).toEqual({ ok: false, invalidHash: false });
    expect(await verifyPasswordHash('', h)).toEqual({ ok: false, invalidHash: false });
  });

  it('回数を引数で変えられ、現在の値と違えば needsRehash。範囲外の回数では作らない', async () => {
    const h = await hashPassword(PW, PASSWORD_HASH_ITERATIONS_MIN);
    expect(parsePasswordHash(h)?.iterations).toBe(PASSWORD_HASH_ITERATIONS_MIN);
    expect(await verifyPasswordHash(PW, h)).toEqual({ ok: true, needsRehash: true });
    await expect(hashPassword(PW, PASSWORD_HASH_ITERATIONS_MAX + 1)).rejects.toThrow();
    await expect(hashPassword(PW, PASSWORD_HASH_ITERATIONS_MIN - 1)).rejects.toThrow();
  });

  it('保存値の破損(形式不正・回数が範囲外・長さ違い)は検証失敗(invalidHash)', async () => {
    const h = await hashPassword(PW, PASSWORD_HASH_ITERATIONS_MIN);
    const [, , salt, dk] = h.split('$');
    const D = '$';
    for (const bad of [
      '',
      'plain-text',
      ['pbkdf2-sha1', '1000', salt, dk].join(D),
      ['pbkdf2-sha256', '999', salt, dk].join(D),
      ['pbkdf2-sha256', '100001', salt, dk].join(D),
      ['pbkdf2-sha256', '01000', salt, dk].join(D),
      ['pbkdf2-sha256', '1000', salt, `${dk}A`].join(D),
      ['pbkdf2-sha256', '1000', '', dk].join(D),
    ]) {
      expect(await verifyPasswordHash(PW, bad)).toEqual({ ok: false, invalidHash: true });
    }
    expect(await verifyPasswordHash(PW, null)).toEqual({ ok: false, invalidHash: true });
  });

  it('入力は 256 文字で打ち切る(正規化・空白の除去はしない)', async () => {
    const pw = 'a'.repeat(PASSWORD_INPUT_MAX);
    const h = await hashPassword(pw, PASSWORD_HASH_ITERATIONS_MIN);
    expect((await verifyPasswordHash(`${pw}zzzz`, h)).ok).toBe(true);
    const sp = await hashPassword(` ${PW} `, PASSWORD_HASH_ITERATIONS_MIN);
    expect((await verifyPasswordHash(PW, sp)).ok).toBe(false);
  });

  it('timingSafeEqualBytes: 全桁を比べ、長さ違いは false', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
