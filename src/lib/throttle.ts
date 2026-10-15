// ログイン失敗のレート制限(固定窓)。docs/ARCHITECTURE.md 5.6・11.3。
// - 接続元ごと(ip:<HMAC 先頭 16 桁>): 15 分の窓で失敗 5 回 → その窓の終わりまでロック
// - ロック中はパスワードを評価せず、失敗回数も増やさない
// - 全体(global): 1 時間の窓で数えるだけ(全体ロックはしない)。1,000 回を超えたら以後その時間は D1 に書かずメモリで近似
// - D1 が無い場合は isolate 内のメモリで同じ規則を近似する(isolate ごとに独立し、再起動で消える)

export const IP_WINDOW_MS = 15 * 60 * 1000;
export const IP_MAX_FAILURES = 5;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
/** これを超えたら画面に警告(表示用の SetupWarning コードは未定義。要確認) */
export const GLOBAL_ALERT_FAILURES = 50;
/** これを超えたら D1 への書き込みを止めてメモリで近似する */
export const GLOBAL_D1_WRITE_LIMIT = 1000;
export const GLOBAL_KEY = 'global';

export interface ThrottleRow {
  windowStart: number;
  failures: number;
}

export interface ThrottleStore {
  get(key: string): Promise<ThrottleRow | null>;
  /** 窓が過ぎていれば新しい窓で 1 回目、窓内なら +1 */
  recordFailure(key: string, now: number, windowMs: number): Promise<void>;
  clear(key: string): Promise<void>;
}

export class MemoryThrottleStore implements ThrottleStore {
  private rows = new Map<string, ThrottleRow>();
  constructor(private readonly maxEntries = 10_000) {}

  async get(key: string): Promise<ThrottleRow | null> {
    return this.rows.get(key) ?? null;
  }

  async recordFailure(key: string, now: number, windowMs: number): Promise<void> {
    const row = this.rows.get(key);
    if (!row || row.windowStart <= now - windowMs) this.rows.set(key, { windowStart: now, failures: 1 });
    else row.failures += 1;
    if (this.rows.size > this.maxEntries) this.prune(now);
  }

  async clear(key: string): Promise<void> {
    this.rows.delete(key);
  }

  private prune(now: number): void {
    for (const [k, r] of this.rows) if (r.windowStart <= now - GLOBAL_WINDOW_MS) this.rows.delete(k);
    // それでも多ければ古い順に捨てる
    while (this.rows.size > this.maxEntries) {
      const first = this.rows.keys().next();
      if (first.done) break;
      this.rows.delete(first.value);
    }
  }
}

export class D1ThrottleStore implements ThrottleStore {
  constructor(private readonly db: D1Database) {}

  async get(key: string): Promise<ThrottleRow | null> {
    const row = await this.db
      .prepare('SELECT window_start, failures FROM login_throttle WHERE key = ?1')
      .bind(key)
      .first<{ window_start: number; failures: number }>();
    return row ? { windowStart: Number(row.window_start), failures: Number(row.failures) } : null;
  }

  async recordFailure(key: string, now: number, windowMs: number): Promise<void> {
    // UPDATE の右辺はすべて更新前の値で評価される
    await this.db
      .prepare(
        `INSERT INTO login_throttle (key, window_start, failures) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END,
           failures     = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE failures + 1 END`,
      )
      .bind(key, now, windowMs)
      .run();
  }

  async clear(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM login_throttle WHERE key = ?1').bind(key).run();
  }
}

/** isolate 内で共有するメモリの記録(D1 が無い場合・global が上限を超えた場合に使う) */
const sharedMemory = new MemoryThrottleStore();

export type ThrottleCheck = { locked: false } | { locked: true; retryAfterMs: number };

function lockState(row: ThrottleRow | null, now: number): ThrottleCheck {
  if (!row) return { locked: false };
  const end = row.windowStart + IP_WINDOW_MS;
  if (now < end && row.failures >= IP_MAX_FAILURES) return { locked: true, retryAfterMs: end - now };
  return { locked: false };
}

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

  /** ロック中か。D1 とメモリの両方を見る(どちらかがロックならロック) */
  async check(ipKey: string, now = Date.now()): Promise<ThrottleCheck> {
    const mem = lockState(await this.memory.get(ipKey), now);
    if (mem.locked || !this.d1) return mem;
    try {
      return lockState(await this.d1.get(ipKey), now);
    } catch {
      return mem;
    }
  }

  /** 失敗を記録する(ロック中には呼ばない) */
  async recordFailure(ipKey: string, now = Date.now()): Promise<void> {
    if (this.d1) {
      try {
        const global = inWindow(await this.d1.get(GLOBAL_KEY), now, GLOBAL_WINDOW_MS);
        if (global < GLOBAL_D1_WRITE_LIMIT) {
          await this.d1.recordFailure(ipKey, now, IP_WINDOW_MS);
          await this.d1.recordFailure(GLOBAL_KEY, now, GLOBAL_WINDOW_MS);
          return;
        }
      } catch {
        // D1 の失敗時はメモリで近似する
      }
    }
    await this.memory.recordFailure(ipKey, now, IP_WINDOW_MS);
    await this.memory.recordFailure(GLOBAL_KEY, now, GLOBAL_WINDOW_MS);
  }

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
