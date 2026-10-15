import { beforeEach, describe, expect, it } from 'vitest';
import { b64urlToBytes, getKeys, hmac, loadInstanceKey, resetKeysCacheForTest, toHex } from './keys';
import { makeD1 } from './testing/sqlite-d1';

beforeEach(() => resetKeysCacheForTest());

describe('instance_key と鍵の派生', () => {
  it('無ければ 32 バイトを作って settings に保存し、2 回目以降は同じ値(INSERT OR IGNORE → SELECT)', async () => {
    const db = await makeD1();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settings').first()).toEqual({ n: 0 });
    const a = await loadInstanceKey(db, 1_000);
    expect(a.byteLength).toBe(32);
    const row = await db
      .prepare(`SELECT value, updated_at FROM settings WHERE key = 'instance_key'`)
      .first<{ value: string; updated_at: number }>();
    expect(b64urlToBytes(row!.value)).toEqual(a);
    expect(row!.updated_at).toBe(1_000);
    expect(await loadInstanceKey(db)).toEqual(a);
    // 並行に呼んでも 1 つだけ
    const many = await Promise.all(Array.from({ length: 5 }, () => loadInstanceKey(db)));
    for (const k of many) expect(k).toEqual(a);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settings').first()).toEqual({ n: 1 });
  });

  it('壊れた値は例外(鍵を作り直さない)', async () => {
    const db = await makeD1();
    await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('instance_key', 'short', 0)`).run();
    await expect(loadInstanceKey(db)).rejects.toThrow();
    await expect(getKeys(db)).rejects.toThrow();
  });

  it('用途ごとに別の鍵。鍵は取り出せない(extractable: false)。isolate 内で 5 分キャッシュ', async () => {
    const db = await makeD1();
    const k = await getKeys(db, 0);
    const s = toHex(await hmac(k.session, 'x'));
    const c = toHex(await hmac(k.confirm, 'x'));
    const i = toHex(await hmac(k.ipHash, 'x'));
    expect(new Set([s, c, i]).size).toBe(3);
    for (const key of [k.session, k.confirm, k.ipHash, k.serverPassword]) expect(key.extractable).toBe(false);
    expect(k.serverPassword.algorithm.name).toBe('AES-GCM');
    expect(await getKeys(db, 60_000)).toBe(k);
    // 行を消しても 5 分はキャッシュの鍵のまま(5.1.2 で受け入れた挙動)。期限後は新しい instance_key になる
    await db.prepare('DELETE FROM settings').run();
    expect(await getKeys(db, 4 * 60_000)).toBe(k);
    const next = await getKeys(db, 6 * 60_000);
    expect(toHex(await hmac(next.session, 'x'))).not.toBe(s);
  });
});
