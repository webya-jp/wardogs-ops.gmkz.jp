// ログイン試行のレート制限(固定窓)。docs/ARCHITECTURE.md 5.6・11.3。
// - 接続元ごと(ip:<HMAC 先頭 16 桁>): パスワードを評価する「前に」試行を 1 回加算し(UPSERT … RETURNING で原子的)、
//   15 分の窓で 5 回を超えたら評価せずに拒否する。成功したら行を消す。並行リクエストでも 5 回を超えて評価されない
// - ロック中(窓内で 5 回に達している)は UPSERT の WHERE で更新しない(書き込みを増やさない)
// - 全体(global): 失敗を 1 時間の窓で数えるだけ(全体ロックはしない)。50 回超で LOGIN_FAILURES_HIGH の警告。
//   1,000 回を超えたら以後その時間は D1 に書かずメモリで近似する(D1 の書き込み枠を守る)
// - D1 が無い場合は isolate 内のメモリで同じ規則を近似する(isolate ごとに独立し、再起動で消える)
import type { SetupWarning } from '../types/api';

export const IP_WINDOW_MS = 15 * 60 * 1000;
/** 1 つの窓で評価する試行の上限(これを超えた試行は評価しない) */
export const IP_MAX_FAILURES = 5;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
/** これを超えたら画面に警告(SetupWarning の LOGIN_FAILURES_HIGH) */
export const GLOBAL_ALERT_FAILURES = 50;
/** これを超えたら D1 への書き込みを止めてメモリで近似する */
export const GLOBAL_D1_WRITE_LIMIT = 1000;
export const GLOBAL_KEY = 'global';

export interface ThrottleRow {
  windowStart: number;
  failures: number;
}

export type AcquireResult = { ok: true; count: number } | { ok: false; retryAfterMs: number };

export interface ThrottleStore {
  get(key: string): Promise<ThrottleRow | null>;
  /**
   * 試行を 1 回加算する(窓が過ぎていれば新しい窓の 1 回目)。窓内で既に max 回に達していれば加算せず拒否。
   * 判定と加算は 1 つの原子的な操作で行う
   */
  tryAcquire(key: string, now: number, windowMs: number, max: number): Promise<AcquireResult>;
  /** 回数だけを数える(global 用) */
  increment(key: string, now: number, windowMs: number): Promise<void>;
  clear(key: string): Promise<void>;
}

function retryAfter(row: ThrottleRow | null, now: number, windowMs: number): number {
  return row ? Math.max(1, row.windowStart + windowMs - now) : windowMs;
}

export class MemoryThrottleStore implements ThrottleStore {
  private rows = new Map<string, ThrottleRow>();
  constructor(private readonly maxEntries = 10_000) {}

  async get(key: string): Promise<ThrottleRow | null> {
    return this.rows.get(key) ?? null;
  }

  // await を挟まずに判定と加算をするので、同じ isolate 内では原子的
  async tryAcquire(key: string, now: number, windowMs: number, max: number): Promise<AcquireResult> {
    const row = this.rows.get(key);
    if (!row || row.windowStart <= now - windowMs) {
      this.rows.set(key, { windowStart: now, failures: 1 });
      this.pruneIfNeeded(now);
      return { ok: true, count: 1 };
    }
    if (row.failures >= max) return { ok: false, retryAfterMs: retryAfter(row, now, windowMs) };
    row.failures += 1;
    return { ok: true, count: row.failures };
  }

  async increment(key: string, now: number, windowMs: number): Promise<void> {
    const row = this.rows.get(key);
    if (!row || row.windowStart <= now - windowMs) this.rows.set(key, { windowStart: now, failures: 1 });
    else row.failures += 1;
    this.pruneIfNeeded(now);
  }

  async clear(key: string): Promise<void> {
    this.rows.delete(key);
  }

  private pruneIfNeeded(now: number): void {
    if (this.rows.size <= this.maxEntries) return;
    for (const [k, r] of this.rows) if (r.windowStart <= now - GLOBAL_WINDOW_MS) this.rows.delete(k);
    while (this.rows.size > this.maxEntries) {
      const first = this.rows.keys().next();
      if (first.done) break;
      this.rows.delete(first.value);
    }
  }
}

// UPDATE の右辺・WHERE の列はすべて更新前の行の値で評価される
const WINDOW_RESET = 'window_start <= ?2 - ?3';

export class D1ThrottleStore implements ThrottleStore {
  constructor(private readonly db: D1Database) {}

  async get(key: string): Promise<ThrottleRow | null> {
    const row = await this.db
      .prepare('SELECT window_start, failures FROM login_throttle WHERE key = ?1')
      .bind(key)
      .first<{ window_start: number; failures: number }>();
    return row ? { windowStart: Number(row.window_start), failures: Number(row.failures) } : null;
  }

  async tryAcquire(key: string, now: number, windowMs: number, max: number): Promise<AcquireResult> {
    const row = await this.db
      .prepare(
        `INSERT INTO login_throttle (key, window_start, failures) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           window_start = CASE WHEN ${WINDOW_RESET} THEN ?2 ELSE window_start END,
           failures     = CASE WHEN ${WINDOW_RESET} THEN 1 ELSE failures + 1 END
         WHERE ${WINDOW_RESET} OR failures < ?4
         RETURNING failures`,
      )
      .bind(key, now, windowMs, max)
      .first<{ failures: number }>();
    if (row) return { ok: true, count: Number(row.failures) };
    // 更新されなかった = 窓内で上限に達している(ロック中)。残り時間を読む
    return { ok: false, retryAfterMs: retryAfter(await this.get(key), now, windowMs) };
  }

  async increment(key: string, now: number, windowMs: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO login_throttle (key, window_start, failures) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           window_start = CASE WHEN ${WINDOW_RESET} THEN ?2 ELSE window_start END,
           failures     = CASE WHEN ${WINDOW_RESET} THEN 1 ELSE failures + 1 END`,
      )
      .bind(key, now, windowMs)
      .run();
  }

  async clear(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM login_throttle WHERE key = ?1').bind(key).run();
  }
}

/** isolate 内で共有するメモリの記録(D1 が無い場合・global が上限を超えた場合・D1 が失敗した場合に使う) */
const sharedMemory = new MemoryThrottleStore();

export type ThrottleCheck = { locked: false } | { locked: true; retryAfterMs: number };

function inWindow(row: ThrottleRow | null, now: number, windowMs: number): number {
  return row && row.windowStart > now - windowMs ? row.failures : 0;
}

export class LoginThrottle {
  private readonly d1: ThrottleStore | null;
  private readonly memory: ThrottleStore;

  constructor(opts: { db?: D1Database | null; store?: ThrottleStore | null; memory?: ThrottleStore } = {}) {
    this.d1 = opts.store ?? (opts.db ? new D1ThrottleStore(opts.db) : null);
    this.memory = opts.memory ?? sharedMemory;
  }

  /** D1 に書いてよいか(global の失敗が 1 時間の上限未満) */
  private async d1Writable(now: number): Promise<boolean> {
    if (!this.d1) return false;
    try {
      return inWindow(await this.d1.get(GLOBAL_KEY), now, GLOBAL_WINDOW_MS) < GLOBAL_D1_WRITE_LIMIT;
    } catch {
      return false;
    }
  }

  /**
   * パスワードを評価する前に呼ぶ。試行を先に加算し、上限を超えていれば locked(評価しない)。
   * メモリ側に(D1 の障害中・上限超過中の)ロックが残っていればそれも優先する
   */
  async acquire(ipKey: string, now = Date.now()): Promise<ThrottleCheck> {
    const memRow = await this.memory.get(ipKey);
    if (memRow && memRow.windowStart > now - IP_WINDOW_MS && memRow.failures >= IP_MAX_FAILURES) {
      return { locked: true, retryAfterMs: retryAfter(memRow, now, IP_WINDOW_MS) };
    }
    if (await this.d1Writable(now)) {
      try {
        const r = await this.d1!.tryAcquire(ipKey, now, IP_WINDOW_MS, IP_MAX_FAILURES);
        return r.ok ? { locked: false } : { locked: true, retryAfterMs: r.retryAfterMs };
      } catch {
        // D1 の失敗時はメモリで近似する
      }
    }
    const r = await this.memory.tryAcquire(ipKey, now, IP_WINDOW_MS, IP_MAX_FAILURES);
    return r.ok ? { locked: false } : { locked: true, retryAfterMs: r.retryAfterMs };
  }

  /** パスワードが違ったとき(接続元の回数は acquire で加算済み。ここでは全体の回数だけを数える) */
  async recordFailure(now = Date.now()): Promise<void> {
    if (await this.d1Writable(now)) {
      try {
        await this.d1!.increment(GLOBAL_KEY, now, GLOBAL_WINDOW_MS);
        return;
      } catch {
        // メモリで近似する
      }
    }
    await this.memory.increment(GLOBAL_KEY, now, GLOBAL_WINDOW_MS);
  }

  /** 成功したら接続元の行を消す */
  async recordSuccess(ipKey: string): Promise<void> {
    await this.memory.clear(ipKey);
    if (this.d1) await this.d1.clear(ipKey).catch(() => undefined);
  }

  /** 直近 1 時間の全体の失敗が警告の閾値を超えているか */
  async globalAlert(now = Date.now()): Promise<boolean> {
    let n = inWindow(await this.memory.get(GLOBAL_KEY), now, GLOBAL_WINDOW_MS);
    if (this.d1) {
      try {
        n += inWindow(await this.d1.get(GLOBAL_KEY), now, GLOBAL_WINDOW_MS);
      } catch {
        // 無視
      }
    }
    return n > GLOBAL_ALERT_FAILURES;
  }
}

export function throttleKeyForIp(ipHash: string): string {
  return `ip:${ipHash}`;
}

/** 全体の失敗が多ければ warnings に LOGIN_FAILURES_HIGH を足す(/api/session 用。ログインは止めない) */
export async function withLoginAlert(
  warnings: SetupWarning[],
  throttle: LoginThrottle,
  now = Date.now(),
): Promise<SetupWarning[]> {
  const alert = await throttle.globalAlert(now).catch(() => false);
  return alert && !warnings.includes('LOGIN_FAILURES_HIGH') ? [...warnings, 'LOGIN_FAILURES_HIGH'] : warnings;
}
