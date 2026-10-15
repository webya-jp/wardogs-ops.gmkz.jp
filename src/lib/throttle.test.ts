import { describe, expect, it } from 'vitest';
import {
  D1ThrottleStore,
  GLOBAL_ALERT_FAILURES,
  GLOBAL_D1_WRITE_LIMIT,
  GLOBAL_KEY,
  GLOBAL_WINDOW_MS,
  IP_MAX_FAILURES,
  IP_WINDOW_MS,
  LoginThrottle,
  MemoryThrottleStore,
  withLoginAlert,
} from './throttle';
import type { ThrottleStore } from './throttle';
import { makeD1 } from './testing/sqlite-d1';

const T = 1_800_000_000_000;
const KEY = 'ip:0123456789abcdef';

describe('throttle(D1 必須。node:sqlite で実際の SQL を実行)', () => {
  it('評価前に加算: 5 回までは評価、6 回目は拒否。窓の終わりで解除', async () => {
    const th = new LoginThrottle({ db: await makeD1(), memory: new MemoryThrottleStore() });
    for (let i = 0; i < IP_MAX_FAILURES; i++) expect(await th.acquire(KEY, T + i)).toEqual({ locked: false });
    const c = await th.acquire(KEY, T + 20);
    expect(c.locked).toBe(true);
    if (c.locked) expect(c.retryAfterMs).toBe(IP_WINDOW_MS - 20);
    expect(await th.acquire(KEY, T + IP_WINDOW_MS)).toEqual({ locked: false });
  });

  it('並行に acquire しても上限を超えて通さない', async () => {
    const th = new LoginThrottle({ db: await makeD1(), memory: new MemoryThrottleStore() });
    const results = await Promise.all(Array.from({ length: 20 }, () => th.acquire(KEY, T)));
    expect(results.filter((r) => !r.locked)).toHaveLength(IP_MAX_FAILURES);
  });

  it('成功で行を消す。接続元ごとに独立', async () => {
    const th = new LoginThrottle({ db: await makeD1(), memory: new MemoryThrottleStore() });
    for (let i = 0; i < IP_MAX_FAILURES; i++) await th.acquire(KEY, T);
    expect((await th.acquire('ip:other', T)).locked).toBe(false);
    expect((await th.acquire(KEY, T)).locked).toBe(true);
    await th.recordSuccess(KEY);
    expect((await th.acquire(KEY, T)).locked).toBe(false);
  });
});

describe('LOGIN_FAILURES_HIGH', () => {
  it('1 時間に 50 回を超えたら warnings に足し、50 回ちょうど・窓の外では足さない', async () => {
    const th = new LoginThrottle({ db: await makeD1(), memory: new MemoryThrottleStore() });
    for (let i = 0; i < GLOBAL_ALERT_FAILURES; i++) await th.recordFailure(T);
    expect(await withLoginAlert(['SERVER_PASSWORDS_UNREADABLE'], th, T)).toEqual(['SERVER_PASSWORDS_UNREADABLE']);
    await th.recordFailure(T);
    expect(await withLoginAlert(['SERVER_PASSWORDS_UNREADABLE'], th, T)).toEqual(['SERVER_PASSWORDS_UNREADABLE', 'LOGIN_FAILURES_HIGH']);
    expect(await withLoginAlert(['LOGIN_FAILURES_HIGH'], th, T)).toEqual(['LOGIN_FAILURES_HIGH']);
    expect(await withLoginAlert([], th, T + GLOBAL_WINDOW_MS)).toEqual([]);
  });
});

describe('throttle(D1 ストア)', () => {
  it('UPSERT … RETURNING: 5 回まで加算、6 回目は更新せず拒否、窓が過ぎたら 1 回目から', async () => {
    const db = await makeD1();
    const store = new D1ThrottleStore(db);
    for (let i = 1; i <= IP_MAX_FAILURES; i++) {
      expect(await store.tryAcquire(KEY, T, IP_WINDOW_MS, IP_MAX_FAILURES)).toEqual({ ok: true, count: i });
    }
    expect(await store.tryAcquire(KEY, T + 1000, IP_WINDOW_MS, IP_MAX_FAILURES)).toEqual({ ok: false, retryAfterMs: IP_WINDOW_MS - 1000 });
    // ロック中は回数を増やさない
    expect((await store.get(KEY))?.failures).toBe(IP_MAX_FAILURES);
    expect(await store.tryAcquire(KEY, T + IP_WINDOW_MS, IP_WINDOW_MS, IP_MAX_FAILURES)).toEqual({ ok: true, count: 1 });
    await store.clear(KEY);
    expect(await store.get(KEY)).toBeNull();
  });

  it('LoginThrottle 経由: 並行でも 5 回まで、成功で行を消す', async () => {
    const db = await makeD1();
    const th = new LoginThrottle({ db, memory: new MemoryThrottleStore() });
    const results = await Promise.all(Array.from({ length: 12 }, () => th.acquire(KEY, T)));
    expect(results.filter((r) => !r.locked)).toHaveLength(IP_MAX_FAILURES);
    await th.recordSuccess(KEY);
    expect((await th.acquire(KEY, T)).locked).toBe(false);
  });

  it('global が上限を超えたら D1 に書かずメモリで近似する', async () => {
    const db = await makeD1();
    const store = new D1ThrottleStore(db);
    for (let i = 0; i < GLOBAL_D1_WRITE_LIMIT; i++) await store.increment(GLOBAL_KEY, T, GLOBAL_WINDOW_MS);
    const mem = new MemoryThrottleStore();
    const th = new LoginThrottle({ db, memory: mem });
    for (let i = 0; i < IP_MAX_FAILURES; i++) expect((await th.acquire(KEY, T)).locked).toBe(false);
    expect(await store.get(KEY)).toBeNull();
    expect((await mem.get(KEY))?.failures).toBe(IP_MAX_FAILURES);
    expect((await th.acquire(KEY, T)).locked).toBe(true);
  });

  it('global が上限(200)に達したら、失敗の記録も D1 に書かない', async () => {
    expect(GLOBAL_D1_WRITE_LIMIT).toBe(200);
    const db = await makeD1();
    const store = new D1ThrottleStore(db);
    for (let i = 0; i < GLOBAL_D1_WRITE_LIMIT; i++) await store.increment(GLOBAL_KEY, T, GLOBAL_WINDOW_MS);
    const mem = new MemoryThrottleStore();
    const th = new LoginThrottle({ db, memory: mem });
    await th.recordFailure(T);
    expect((await store.get(GLOBAL_KEY))?.failures).toBe(GLOBAL_D1_WRITE_LIMIT);
    expect((await mem.get(GLOBAL_KEY))?.failures).toBe(1);
  });

  it('D1 が一時的に失敗してもメモリで近似する', async () => {
    const broken: ThrottleStore = {
      get: async () => {
        throw new Error('d1 down');
      },
      tryAcquire: async () => {
        throw new Error('d1 down');
      },
      increment: async () => {
        throw new Error('d1 down');
      },
      clear: async () => {
        throw new Error('d1 down');
      },
    };
    const th = new LoginThrottle({ store: broken, memory: new MemoryThrottleStore() });
    for (let i = 0; i < IP_MAX_FAILURES; i++) expect((await th.acquire(KEY, T)).locked).toBe(false);
    expect((await th.acquire(KEY, T)).locked).toBe(true);
    await th.recordFailure(T);
  });
});
