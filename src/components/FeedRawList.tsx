// キルフィードタブの「受信した生データ(観測モード)」(docs/ARCHITECTURE.md 17.6・17.9、docs/API.md 9 章・7.3)。
// - 受信の状況(最後に受信・保存・拒否・捨てた時刻と理由、今日の件数)は GET /api/servers/:id/feed
// - 生データは GET /api/feed/raw?server=&limit=20 の最新 20 件。手動更新(「再読み込み」)と「さらに読み込む」(before)
// - 本文はゲームサーバーから届いた JSON 文字列のまま。**テキストとして**表示する(HTML として解釈しない。
//   React の文字列の子要素は常にエスケープされる。dangerouslySetInnerHTML は使わない)。既定は折りたたみ
// - 本文には Steam ID・プレイヤー名が含まれ得る(ログイン後の画面にだけ出す。docs/ARCHITECTURE.md の方針どおり)
// - 各件の「正規化の結果」で GET /api/feed/raw/:id/normalized(今の対応表で読み取った結果。保存はしない。API.md 11.2)を表示する
import { useCallback, useEffect, useRef, useState } from 'react';
import { FEED_RAW_PAGE_DEFAULT, FEED_RETENTION_DAYS } from '../types/api';
import type { FeedRawEntry, FeedRawResponse, ServerFeedStatus, ServerId } from '../types/api';
import FeedNormalizeView from './FeedNormalizeView';
import { apiGet, withServer } from './lib/api';
import type { ClientError } from './lib/api';
import type { I18n } from './lib/hooks';
import ErrorView from './ErrorView';
import FeedStatusView from './FeedStatusView';

interface Props {
  i18n: I18n;
  serverId: ServerId;
  /** 設定タブのキルフィードの節へのリンク */
  settingsHref: string;
}

export default function FeedRawList({ i18n, serverId, settingsHref }: Props) {
  const { t, time, dateTime, num } = i18n;
  const [entries, setEntries] = useState<FeedRawEntry[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [status, setStatus] = useState<ServerFeedStatus | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (before: number | null) => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ limit: String(FEED_RAW_PAGE_DEFAULT) });
      if (before !== null) qs.set('before', String(before));
      const [raw, st] = await Promise.all([
        apiGet<FeedRawResponse>(withServer(`/api/feed/raw?${qs.toString()}`, serverId), ctrl.signal),
        before === null
          ? apiGet<ServerFeedStatus>(`/api/servers/${encodeURIComponent(serverId)}/feed`, ctrl.signal)
          : Promise.resolve(null),
      ]);
      if (ctrl.signal.aborted) return;
      setLoading(false);
      if (st && st.ok) setStatus(st.data);
      if (!raw.ok) {
        setError(raw.error);
        return;
      }
      setConfigured(raw.data.configured);
      setEntries((prev) => (before === null ? raw.data.entries : [...prev, ...raw.data.entries]));
      setNextBefore(raw.data.nextBefore);
      setUpdatedAt(Date.now());
    },
    [serverId],
  );

  useEffect(() => {
    setEntries([]);
    setStatus(null);
    setConfigured(null);
    void load(null);
    return () => ctrlRef.current?.abort();
  }, [load]);

  const eventsText = (e: FeedRawEntry) =>
    e.eventCount === null ? t('feed.raw.eventsUnknown') : t('feed.raw.events', { count: num(e.eventCount) });

  return (
    <section className="card feed-raw" aria-labelledby="feed-raw-title">
      <div className="toolbar">
        <h2 id="feed-raw-title">{t('feed.raw.title')}</h2>
        <span className="spacer" />
        <button type="button" className="button-small" onClick={() => void load(null)} disabled={loading}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <p className="alert">{t('killfeed.raw.intro')}</p>
      <p className="muted">
        {t('feed.raw.personalData')} {t('feed.raw.retention', { days: num(FEED_RETENTION_DAYS) })}
      </p>
      <p className="muted">
        {updatedAt !== null && <>{t('common.lastUpdated', { time: time(updatedAt) })} </>}
        {t('common.manualRefresh')}
      </p>

      {error && <ErrorView error={error} t={t} />}

      {status && <FeedStatusView i18n={i18n} status={status} />}

      {configured === false && (
        <div className="alert alert-warn">
          <p>{t('feed.raw.notConfigured')}</p>
          <p>
            <a href={settingsHref}>{t('feed.raw.toSettings')}</a>
          </p>
        </div>
      )}

      {configured !== null && entries.length === 0 && !error && <p className="muted">{t('feed.raw.empty')}</p>}

      {entries.length > 0 && (
        <ol className="feed-raw-list">
          {entries.map((e) => (
            <li key={e.id}>
              <details>
                <summary>
                  {t('feed.raw.entry', { time: dateTime(e.receivedAt), bytes: num(e.bytes), events: eventsText(e) })}
                </summary>
                <pre className="feed-raw-body">{e.body}</pre>
                <FeedNormalizeView i18n={i18n} serverId={serverId} entryId={e.id} />
              </details>
            </li>
          ))}
        </ol>
      )}

      {entries.length > 0 && (
        <div className="button-row tight">
          {nextBefore !== null ? (
            <button type="button" onClick={() => void load(nextBefore)} disabled={loading}>
              {t('feed.raw.loadMore')}
            </button>
          ) : (
            <p className="muted">{t('feed.raw.end')}</p>
          )}
        </div>
      )}
    </section>
  );
}
