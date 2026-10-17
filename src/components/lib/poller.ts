// 読み取り API の取得と定期更新(React に依存しない小さなストア)。docs/ARCHITECTURE.md 9.3。
// - useResource(各アイランドの取得)と status-store(/api/status をサイドバーとメインで共有)の両方がこれを使う
// - 購読者が 1 つ以上いる間だけ動き、0 になったら止める(参照カウント)
// - タブが非表示(document.visibilityState === 'hidden')の間はタイマーを止め、表示に戻ったら残り時間で再開する
// - 間隔は POLL_MIN_INTERVAL_SEC より短くしない。取得中に refresh されたら新しく取らずに相乗りする
// - UNAUTHENTICATED(セッション切れ。api.ts が /login へ移動する)を受けたら以後は自動更新しない
import { POLL_MIN_INTERVAL_SEC } from '../../types/api';
import { apiGet } from './api';
import type { ClientError } from './api';

export interface PollerSnapshot<T> {
  data: T | null;
  error: ClientError | null;
  /** 取得中(初回を含む) */
  loading: boolean;
  /** 最後に成功した時刻(epoch ミリ秒) */
  updatedAt: number | null;
}

export interface Poller<T> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PollerSnapshot<T>;
  /** 購読者がいるときだけ取り直す(取得中なら相乗り) */
  refresh: () => void;
  /** 購読者の数(0 なら止まっている) */
  subscribers: () => number;
}

/** サーバー描画と初回の hydration で使う値(参照を固定する) */
export const INITIAL_SNAPSHOT: PollerSnapshot<never> = Object.freeze({ data: null, error: null, loading: true, updatedAt: null });

/**
 * @param path 取得する API のパス
 * @param pollSec 自動更新の間隔(秒)。null なら手動更新のみ。POLL_MIN_INTERVAL_SEC 未満は切り上げる
 */
export function createPoller<T>(path: string, pollSec: number | null): Poller<T> {
  const intervalMs = pollSec === null ? null : Math.max(pollSec, POLL_MIN_INTERVAL_SEC) * 1000;
  const listeners = new Set<() => void>();
  let snapshot: PollerSnapshot<T> = INITIAL_SNAPSHOT;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let lastAttempt = 0;
  let stoppedByAuth = false;

  const emit = (next: Partial<PollerSnapshot<T>>) => {
    snapshot = { ...snapshot, ...next };
    for (const l of listeners) l();
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delay: number) => {
    clearTimer();
    if (intervalMs === null || stoppedByAuth || listeners.size === 0) return;
    if (document.visibilityState === 'hidden') return;
    timer = setTimeout(() => void load(), Math.max(delay, 0));
  };

  const load = async () => {
    if (inFlight || listeners.size === 0) return;
    clearTimer();
    const ctrl = new AbortController();
    inFlight = ctrl;
    lastAttempt = Date.now();
    if (!snapshot.loading) emit({ loading: true });
    const result = await apiGet<T>(path, ctrl.signal);
    if (inFlight === ctrl) inFlight = null;
    if (ctrl.signal.aborted) return;
    if (result.ok) {
      emit({ data: result.data, error: null, loading: false, updatedAt: Date.now() });
    } else {
      if (result.error.code === 'UNAUTHENTICATED') stoppedByAuth = true;
      emit({ error: result.error, loading: false });
    }
    if (intervalMs !== null) schedule(intervalMs);
  };

  const onVisibility = () => {
    if (intervalMs === null) return;
    if (document.visibilityState === 'hidden') {
      clearTimer();
      return;
    }
    const elapsed = Date.now() - lastAttempt;
    if (elapsed >= intervalMs) void load();
    else schedule(intervalMs - elapsed);
  };

  const start = () => {
    document.addEventListener('visibilitychange', onVisibility);
    void load();
  };

  const stop = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimer();
    inFlight?.abort();
    inFlight = null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    refresh: () => void load(),
    subscribers: () => listeners.size,
  };
}
