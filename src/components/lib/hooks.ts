// React アイランド共通の hook。
// - useResource: 読み取り API の取得と(任意で)定期更新。タブが非表示の間は止め、POLL_MIN_INTERVAL_SEC より短くしない
// - useCapabilities: /api/capabilities を画面表示時に 1 回だけ取る
// - useI18n: サーバーで決めた言語・タイムゾーンから t と日時・数値の整形関数を作る
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_MIN_INTERVAL_SEC } from '../../types/api';
import type { CapabilitiesResponse, ServerId } from '../../types/api';
import { formatDateTime, formatNumber, getTranslator, toLocale } from '../../i18n';
import type { Language, Translator } from '../../i18n';
import { apiGet, withServer } from './api';
import type { ClientError, Result } from './api';

export interface I18nProps {
  language: Language;
  timeZone: string;
}

export interface I18n {
  t: Translator;
  dateTime: (epochMs: number) => string;
  time: (epochMs: number) => string;
  num: (value: number | null | undefined) => string;
}

export function useI18n({ language, timeZone }: I18nProps): I18n {
  return useMemo(() => {
    const t = getTranslator(language);
    const locale = toLocale(language);
    return {
      t,
      dateTime: (ms) => formatDateTime(ms, locale, timeZone),
      time: (ms) => formatDateTime(ms, locale, timeZone, { timeStyle: 'medium' }),
      num: (v) => (typeof v === 'number' && Number.isFinite(v) ? formatNumber(v, locale) : t('common.none')),
    };
  }, [language, timeZone]);
}

export interface ResourceState<T> {
  data: T | null;
  error: ClientError | null;
  loading: boolean;
  /** 最後に成功した時刻(epoch ミリ秒) */
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * @param path 取得する API のパス
 * @param pollSec 自動更新の間隔(秒)。null なら手動更新のみ。POLL_MIN_INTERVAL_SEC 未満は切り上げる
 */
export function useResource<T>(path: string, pollSec: number | null): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const lastAttempt = useRef(0);
  const mounted = useRef(true);
  const intervalMs = pollSec === null ? null : Math.max(pollSec, POLL_MIN_INTERVAL_SEC) * 1000;

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const schedule = useCallback(
    (delay: number, run: () => void) => {
      clearTimer();
      if (intervalMs === null || document.visibilityState === 'hidden') return;
      timer.current = setTimeout(run, Math.max(delay, 0));
    },
    [intervalMs],
  );

  const load = useCallback(async () => {
    if (inFlight.current) return;
    clearTimer();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    lastAttempt.current = Date.now();
    setLoading(true);
    const result: Result<T> = await apiGet<T>(path, ctrl.signal);
    inFlight.current = null;
    if (!mounted.current || ctrl.signal.aborted) return;
    if (result.ok) {
      setData(result.data);
      setError(null);
      setUpdatedAt(Date.now());
    } else {
      setError(result.error);
    }
    setLoading(false);
    if (intervalMs !== null) schedule(intervalMs, () => void load());
  }, [path, intervalMs, schedule]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const onVisibility = () => {
      if (intervalMs === null) return;
      if (document.visibilityState === 'hidden') {
        clearTimer();
        return;
      }
      const elapsed = Date.now() - lastAttempt.current;
      if (elapsed >= intervalMs) void load();
      else schedule(intervalMs - elapsed, () => void load());
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimer();
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [load, schedule, intervalMs]);

  const refresh = useCallback(() => void load(), [load]);
  return { data, error, loading, updatedAt, refresh };
}

/** capabilities は画面表示時に 1 回だけ取る(Worker 側でサーバーごとに 10 分キャッシュ)。取れなければ null のまま */
export function useCapabilities(serverId: ServerId): CapabilitiesResponse | null {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    void apiGet<CapabilitiesResponse>(withServer('/api/capabilities', serverId), ctrl.signal).then((r) => {
      if (!ctrl.signal.aborted && r.ok) setCaps(r.data);
    });
    return () => ctrl.abort();
  }, [serverId]);
  return caps;
}
