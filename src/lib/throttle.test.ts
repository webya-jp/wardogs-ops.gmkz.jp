import { describe, expect, it } from 'vitest';
import {
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

const T = 1_800_000_000_000;
const KEY = 'ip:0123456789abcdef';

describe('throttle (memory)', () => {
  it('15 分に 5 回失敗でロック、窓の終わりで解除', async () => {
    const th = new LoginThrottle({ memory: new MemoryThrottleStore() });
    for (let i = 0; i < IP_MAX_FAILURES - 1; i++) await th.recordFailure(KEY, T + i);
    expect(await th.check(KEY, T + 10)).toEqual({ locked: false });
    await th.recordFailure(KEY, T + 10);
    const c = await th.check(KEY, T + 20);
    expect(c.locked).toBe(true);
    if (c.locked) expect(c.retryAfterMs).toBe(IP_WINDOW_MS - 20);
    expect(await th.check(KEY, T + IP_WINDOW_MS)).toEqual({ locked: false });
    // 窓が過ぎた後の失敗は新しい窓の 1 回目
    await th.recordFailure(KEY, T + IP_WINDOW_MS + 1);
    expect(await th.check(KEY, T + IP_WINDOW_MS + 2)).toEqual({ locked: false });
  });

  it('成功で接続元の記録を消す。接続元ごとに独立', async () => {
    const th = new LoginThrottle({ memory: new MemoryThrottleStore() });
    for (let i = 0; i < IP_MAX_FAILURES; i++) await th.recordFailure(KEY, T);
    expect((await th.check('ip:other', T)).locked).toBe(false);
    await th.recordSuccess(KEY);
    expect((await th.check(KEY, T)).locked).toBe(false);
  });

  it('全体の失敗が多いと警告(全体ロックはしない)', async () => {
    const th = new LoginThrottle({ memory: new MemoryThrottleStore() });
    for (let i = 0; i < 51; i++) await th.recordFailure(`ip:${i}`, T);
    expect(await th.globalAlert(T)).toBe(true);
    expect((await th.check('ip:new', T)).locked).toBe(false);
  });
});

describe('LOGIN_FAILURES_HIGH', () => {
  it('1 時間に 50 回を超えたら warnings に足し、50 回ちょうど・窓の外では足さない', async () => {
    const th = new LoginThrottle({ memory: new MemoryThrottleStore() });
    for (let i = 0; i < GLOBAL_ALERT_FAILURES; i++) await th.recordFailure(`ip:${i}`, T);
    expect(await withLoginAlert(['RCON_PASSWORD_SHORT'], th, T)).toEqual(['RCON_PASSWORD_SHORT']);
    await th.recordFailure('ip:last', T);
    expect(await withLoginAlert(['RCON_PASSWORD_SHORT'], th, T)).toEqual(['RCON_PASSWORD_SHORT', 'LOGIN_FAILURES_HIGH']);
    expect(await withLoginAlert(['LOGIN_FAILURES_HIGH'], th, T)).toEqual(['LOGIN_FAILURES_HIGH']);
    expect(await withLoginAlert([], th, T + GLOBAL_WINDOW_MS)).toEqual([]);
  });
});

/** D1 相当のストア(呼ばれ方を記録する) */
class SpyStore extends MemoryThrottleStore {
  writes = 0;
  failGet = false;
  override async get(key: string) {
    if (this.failGet) throw new Error('d1 down');
    return super.get(key);
  }
  override async recordFailure(key: string, now: number, windowMs: number) {
    this.writes++;
    return super.recordFailure(key, now, windowMs);
  }
}

describe('throttle (D1 + memory)', () => {
  it('D1 に ip と global を記録し、D1 の値でロック判定する', async () => {
    const d1 = new SpyStore();
    const mem = new MemoryThrottleStore();
    const th = new LoginThrottle({ store: d1 as ThrottleStore, memory: mem });
    for (let i = 0; i < IP_MAX_FAILURES; i++) await th.recordFailure(KEY, T);
    expect(d1.writes).toBe(IP_MAX_FAILURES * 2);
    expect(await mem.get(KEY)).toBeNull();
    expect((await th.check(KEY, T)).locked).toBe(true);
  });

  it('global が 1 時間に上限を超えたら D1 に書かずメモリで近似する', async () => {
    const d1 = new SpyStore();
    for (let i = 0; i < GLOBAL_D1_WRITE_LIMIT; i++) await d1.recordFailure(GLOBAL_KEY, T, 3_600_000);
    d1.writes = 0;
    const mem = new MemoryThrottleStore();
    const th = new LoginThrottle({ store: d1 as ThrottleStore, memory: mem });
    for (let i = 0; i < IP_MAX_FAILURES; i++) await th.recordFailure(KEY, T);
    expect(d1.writes).toBe(0);
    expect((await mem.get(KEY))?.failures).toBe(IP_MAX_FAILURES);
    expect((await th.check(KEY, T)).locked).toBe(true);
  });

  it('D1 が失敗してもメモリで動く', async () => {
    const d1 = new SpyStore();
    d1.failGet = true;
    const mem = new MemoryThrottleStore();
    const th = new LoginThrottle({ store: d1 as ThrottleStore, memory: mem });
    for (let i = 0; i < IP_MAX_FAILURES; i++) await th.recordFailure(KEY, T);
    expect((await th.check(KEY, T)).locked).toBe(true);
  });
});
