// React アイランド共通の hook。
// - useResource: 読み取り API の取得と(任意で)定期更新。タブが非表示の間は止め、POLL_MIN_INTERVAL_SEC より短くしない
//   (処理は poller.ts。/api/status はサイドバーと共有するので status-store.ts の useSharedStatus を使う)
// - useCapabilities: /api/capabilities を画面表示時に 1 回だけ取る
// - useI18n: サーバーで決めた言語・タイムゾーンから t と日時・数値の整形関数を作る
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { POLL_MIN_INTERVAL_SEC } from '../../types/api';
import type { CapabilitiesResponse, ServerId } from '../../types/api';
import { formatDateTime, formatNumber, getTranslator, toLocale } from '../../i18n';
import type { Language, Locale, Translator } from '../../i18n';
import { apiGet, withServer } from './api';
import type { ClientError } from './api';
import { createPoller, INITIAL_SNAPSHOT } from './poller';
import type { PollerSnapshot } from './poller';

export interface I18nProps {
  language: Language;
  timeZone: string;
}

export interface I18n {
  t: Translator;
  dateTime: (epochMs: number) => string;
  time: (epochMs: number) => string;
  num: (value: number | null | undefined) => string;
  /** Intl に渡す locale とタイムゾーン(個別の書式が要る画面用) */
  locale: Locale;
  timeZone: string;
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
      locale,
      timeZone,
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
 * 読み取り API を取得する(取得・タイマー処理は poller.ts。/api/status の共有ストアと同じ実装)。
 * @param path 取得する API のパス
 * @param pollSec 自動更新の間隔(秒)。null なら手動更新のみ。POLL_MIN_INTERVAL_SEC 未満は切り上げる
 */
export function useResource<T>(path: string, pollSec: number | null): ResourceState<T> {
  const poller = useMemo(() => createPoller<T>(path, pollSec), [path, pollSec]);
  const snap = useSyncExternalStore(poller.subscribe, poller.getSnapshot, getInitialSnapshot) as PollerSnapshot<T>;
  return { ...snap, refresh: poller.refresh };
}

const getInitialSnapshot = (): PollerSnapshot<never> => INITIAL_SNAPSHOT;

/**
 * enabled の間だけ sec 秒ごとに refresh を呼ぶ(タブが非表示の間は呼ばない。POLL_MIN_INTERVAL_SEC 未満は切り上げる)。
 * 「記録中の試合だけ 60 秒ごと」のように、取得した内容によって自動更新を切り替えるときに使う(useResource は手動更新で作る)
 */
export function useAutoRefresh(refresh: () => void, enabled: boolean, sec: number): void {
  useEffect(() => {
    if (!enabled) return;
    const ms = Math.max(sec, POLL_MIN_INTERVAL_SEC) * 1000;
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, ms);
    return () => clearInterval(id);
  }, [refresh, enabled, sec]);
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
