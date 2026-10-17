// 受信した生データ 1 件の「正規化の結果」(GET /api/feed/raw/:id/normalized。docs/API.md 11.2、docs/ARCHITECTURE.md 17.10.2)。
// 今の対応表で読み取った結果(本文の形・件数・イベントごとの結果・読み取れた項目と候補名・使われなかった項目名)を表示する。保存はしない。
// 項目名・値は生データ。React の文字列の子要素として描画する(HTML として解釈しない)。
import { Fragment, useRef, useState } from 'react';
import { FEED_NORMALIZE_RESULTS, KILL_FIELD_NAMES } from '../types/api';
import type { FeedNormalizePreviewResponse, KillFieldName, ServerId } from '../types/api';
import { apiGet, withServer } from './lib/api';
import type { ClientError } from './lib/api';
import type { I18n } from './lib/hooks';
import ErrorView from './ErrorView';

interface Props {
  i18n: I18n;
  serverId: ServerId;
  entryId: number;
}

export default function FeedNormalizeView({ i18n, serverId, entryId }: Props) {
  const { t, num } = i18n;
  const [data, setData] = useState<FeedNormalizePreviewResponse | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);

  const load = async () => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    const r = await apiGet<FeedNormalizePreviewResponse>(
      withServer(`/api/feed/raw/${encodeURIComponent(String(entryId))}/normalized`, serverId),
      ctrl.signal,
    );
    if (ctrl.signal.aborted) return;
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setData(r.data);
  };

  const hide = () => {
    ctrlRef.current?.abort();
    setData(null);
    setError(null);
    setLoading(false);
  };

  const total = data ? FEED_NORMALIZE_RESULTS.reduce((n, k) => n + data.counts[k], 0) : 0;
  const titleId = `feed-normalize-${entryId}`;

  return (
    <div className="feed-normalize">
      <div className="button-row tight">
        <button type="button" className="button-small" onClick={() => void load()} disabled={loading} aria-busy={loading}>
          {loading ? t('killfeed.normalize.loading') : t('killfeed.normalize.button')}
        </button>
        {(data || error) && (
          <button type="button" className="button-small" onClick={hide}>
            {t('killfeed.normalize.hide')}
          </button>
        )}
      </div>
      <div aria-live="polite">
        {error && <ErrorView error={error} t={t} lead={t('killfeed.normalize.failed')} />}
      </div>
      {data && (
        <section className="feed-normalize-result" aria-labelledby={titleId}>
          <h3 id={titleId}>{t('killfeed.normalize.title')}</h3>
          <p>{t('killfeed.normalize.envelope', { envelope: t(`killfeed.envelope.${data.envelope}`) })}</p>
          <p>
            {t('killfeed.normalize.counts', {
              kill: num(data.counts.kill),
              other: num(data.counts.other),
              incomplete: num(data.counts.incomplete),
              invalid: num(data.counts.invalid),
            })}
          </p>
          {data.bigIntegersQuoted > 0 && (
            <p className="muted">{t('killfeed.normalize.bigIntegers', { count: num(data.bigIntegersQuoted) })}</p>
          )}
          {data.events.length < total && (
            <p className="muted">{t('killfeed.normalize.shownFirst', { count: num(data.events.length) })}</p>
          )}
          {data.events.length === 0 ? (
            <p className="muted">{t('killfeed.normalize.noEvents')}</p>
          ) : (
            <ol className="feed-normalize-events">
              {data.events.map((ev) => {
                const matched = KILL_FIELD_NAMES.filter((f): f is KillFieldName => typeof ev.matched[f] === 'string');
                return (
                  <li key={ev.index}>
                    <p className="feed-normalize-head">
                      {t('killfeed.normalize.event', {
                        index: num(ev.index + 1),
                        type: ev.type ?? t('common.none'),
                        result: t(`killfeed.normalizeResult.${ev.result}`),
                      })}
                    </p>
                    <h4>{t('killfeed.normalize.matched')}</h4>
                    {matched.length === 0 ? (
                      <p className="muted">{t('killfeed.normalize.noneMatched')}</p>
                    ) : (
                      <dl className="kv">
                        {matched.map((f) => (
                          <Fragment key={f}>
                            <dt>{t(`killfeed.field.${f}`)}</dt>
                            <dd className="mono">{ev.matched[f]}</dd>
                          </Fragment>
                        ))}
                      </dl>
                    )}
                    {ev.unmappedKeys.length > 0 && (
                      <>
                        <h4>{t('killfeed.normalize.unmapped')}</h4>
                        <ul className="key-chips">
                          {ev.unmappedKeys.map((k) => (
                            <li key={k} className="mono">
                              {k}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
