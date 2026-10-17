// キルの一覧の取得と差分の取得(docs/ARCHITECTURE.md 17.10.7「更新」、docs/API.md 11.1)。
// - 表示したときに全件(after なし)を 1 回取る
// - 記録中の試合・記録外を表示している間は KILLFEED_POLL_SEC ごとに after=<cursor> で差分を取り、末尾に足す
//   (タブが非表示の間は止める。useAutoRefresh)。差分が truncated なら全件を取り直す
// - 応答の match.status が ended になったら止める。終了済みの試合は 1 回だけ
// - 試合の全件が上限で打ち切られた(truncated)ときは「最初の n 件」を表示・集計するため、差分は足さない
// - 記録外は新しい方から KILLFEED_UNRECORDED_MAX 件だけを持つ
import { useCallback, useEffect, useRef, useState } from 'react';
import { KILLFEED_POLL_SEC, KILLFEED_UNRECORDED, KILLFEED_UNRECORDED_MAX } from '../../types/api';
import type { KillfeedKillsResponse, KillfeedScope, ServerId } from '../../types/api';
import { apiGet, withServer } from './api';
import type { ClientError } from './api';
import { useAutoRefresh } from './hooks';
import { mergeKills } from './killstats';

export interface KillfeedState {
  data: KillfeedKillsResponse | null;
  error: ClientError | null;
  loading: boolean;
  updatedAt: number | null;
  /** 全件の取得で上限に当たった(試合のときだけ意味を持つ) */
  truncated: boolean;
  /** 差分を自動で取っている */
  live: boolean;
  /** 全件を取り直す */
  refresh: () => void;
}

interface Inner {
  data: KillfeedKillsResponse | null;
  error: ClientError | null;
  loading: boolean;
  updatedAt: number | null;
  truncated: boolean;
}

const INITIAL: Inner = { data: null, error: null, loading: true, updatedAt: null, truncated: false };

function killsPath(serverId: ServerId, scope: KillfeedScope, after: string | null): string {
  const qs = new URLSearchParams({ match: scope });
  if (after !== null) qs.set('after', after);
  return withServer(`/api/killfeed/kills?${qs.toString()}`, serverId);
}

export function useKillfeed(serverId: ServerId, scope: KillfeedScope): KillfeedState {
  const [state, setState] = useState<Inner>(INITIAL);
  const stateRef = useRef<Inner>(INITIAL);
  const ctrlRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const unrecorded = scope === KILLFEED_UNRECORDED;

  const update = useCallback((next: Partial<Inner>) => {
    stateRef.current = { ...stateRef.current, ...next };
    setState(stateRef.current);
  }, []);

  const loadFull = useCallback(async () => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    busyRef.current = true;
    update({ loading: true });
    const r = await apiGet<KillfeedKillsResponse>(killsPath(serverId, scope, null), ctrl.signal);
    if (ctrl.signal.aborted) return;
    busyRef.current = false;
    if (!r.ok) {
      update({ error: r.error, loading: false });
      return;
    }
    update({ data: r.data, error: null, loading: false, updatedAt: Date.now(), truncated: r.data.truncated });
  }, [serverId, scope, update]);

  const loadIncrement = useCallback(async () => {
    if (busyRef.current) return;
    const cur = stateRef.current.data;
    if (!cur || cur.cursor === null) {
      await loadFull();
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    busyRef.current = true;
    const r = await apiGet<KillfeedKillsResponse>(killsPath(serverId, scope, cur.cursor), ctrl.signal);
    if (ctrl.signal.aborted) return;
    busyRef.current = false;
    if (!r.ok) {
      update({ error: r.error });
      return;
    }
    if (r.data.truncated) {
      await loadFull();
      return;
    }
    const base = stateRef.current.data ?? cur;
    const kills = mergeKills(base.kills, r.data.kills, unrecorded ? KILLFEED_UNRECORDED_MAX : undefined);
    update({
      data: { ...r.data, kills, incremental: false, truncated: base.truncated, cursor: r.data.cursor ?? base.cursor },
      error: null,
      updatedAt: Date.now(),
    });
  }, [serverId, scope, unrecorded, loadFull, update]);

  useEffect(() => {
    stateRef.current = INITIAL;
    setState(INITIAL);
    busyRef.current = false;
    void loadFull();
    return () => {
      ctrlRef.current?.abort();
      busyRef.current = false;
    };
  }, [loadFull]);

  const data = state.data;
  const live =
    data !== null && (unrecorded || (data.match?.status === 'recording' && !state.truncated));
  const tick = useCallback(() => void loadIncrement(), [loadIncrement]);
  useAutoRefresh(tick, live, KILLFEED_POLL_SEC);
  const refresh = useCallback(() => void loadFull(), [loadFull]);

  return { ...state, live, refresh };
}
