// /api/status の共有ストア(docs/ARCHITECTURE.md 9.3)。
// サイドバー(SidebarStatus)とメイン(StatusPanel)は別々の React ルート(アイランド)だが、同じページで同じ URL の
// ES モジュールは 1 回だけ評価されるので、このモジュールの Map は両方で共有される。サーバー id ごとに 1 つの取得・
// 30 秒ごとの更新だけを持ち、二重に取得しない。共有されなかった場合に備えて登録先は globalThis の 1 つのキーに置く(要確認 I-6)。
// サーバー描画(SSR)では共有しない(Worker の isolate にリクエストをまたいだ状態を残さないため)。
import { useSyncExternalStore } from 'react';
import { POLL_MIN_INTERVAL_SEC } from '../../types/api';
import type { ServerId, StatusResponse } from '../../types/api';
import { withServer } from './api';
import { createPoller, INITIAL_SNAPSHOT } from './poller';
import type { Poller, PollerSnapshot } from './poller';
import type { ResourceState } from './hooks';

const REGISTRY_KEY = '__wardogsOpsStatusStores';

type Registry = Map<ServerId, Poller<StatusResponse>>;

function registry(): Registry | null {
  if (typeof window === 'undefined') return null;
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  return (g[REGISTRY_KEY] ??= new Map());
}

/** サーバー id ごとの /api/status のストア(ブラウザでは同じ id に対して常に同じもの) */
export function getStatusStore(serverId: ServerId): Poller<StatusResponse> {
  const reg = registry();
  const existing = reg?.get(serverId);
  if (existing) return existing;
  const store = createPoller<StatusResponse>(withServer('/api/status', serverId), POLL_MIN_INTERVAL_SEC);
  reg?.set(serverId, store);
  return store;
}

/** 書き込み操作の成功後などに、表示中のストアだけを取り直す(誰も購読していなければ何もしない) */
export function refreshSharedStatus(serverId: ServerId): void {
  const store = registry()?.get(serverId);
  if (store && store.subscribers() > 0) store.refresh();
}

const getServerSnapshot = (): PollerSnapshot<StatusResponse> => INITIAL_SNAPSHOT;

/** /api/status を共有して読む。返す形は useResource と同じ */
export function useSharedStatus(serverId: ServerId): ResourceState<StatusResponse> {
  const store = getStatusStore(serverId);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
  return { ...snap, refresh: store.refresh };
}
