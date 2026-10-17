// キルフィードの受信の状況(ServerFeedStatus)の表示。設定タブとキルフィードタブで共通(docs/ARCHITECTURE.md 17.9)。
// 理由はカタログ feed.reject.* / feed.drop.*。トークンの値・ハッシュは API が返さないので扱わない(末尾 4 文字のみ)。
import type { ServerFeedStatus } from '../types/api';
import type { I18n } from './lib/hooks';
import { tCode } from './lib/keys';

interface Props {
  i18n: I18n;
  status: ServerFeedStatus;
}

const KIB = 1024;

export default function FeedStatusView({ i18n, status }: Props) {
  const { t, dateTime, num } = i18n;
  const at = (v: number | null) => (v === null ? t('feed.status.never') : dateTime(v));
  const kib = (bytes: number) => num(Math.ceil(bytes / KIB));

  return (
    <div className="feed-status">
      <h3>{t('feed.status.title')}</h3>
      {!status.configured && <p className="muted">{t('feed.status.notConfigured')}</p>}
      <dl className="kv">
        {status.configured && status.tokenHint !== null && (
          <>
            <dt>{t('feed.token.title')}</dt>
            <dd>
              {t('feed.token.hint', {
                hint: status.tokenHint,
                time: status.tokenCreatedAt !== null ? dateTime(status.tokenCreatedAt) : t('common.unknown'),
              })}
            </dd>
          </>
        )}
        <dt>{t('feed.status.lastReceived')}</dt>
        <dd>{at(status.lastReceivedAt)}</dd>
        <dt>{t('feed.status.lastStored')}</dt>
        <dd>{at(status.lastStoredAt)}</dd>
        <dt>{t('feed.status.lastRejected')}</dt>
        <dd>
          {status.lastRejectedAt !== null && status.lastRejectedReason !== null
            ? t('feed.status.withReason', { time: dateTime(status.lastRejectedAt), reason: tCode(t, `feed.reject.${status.lastRejectedReason}`) })
            : at(status.lastRejectedAt)}
        </dd>
        <dt>{t('feed.status.lastDropped')}</dt>
        <dd>
          {status.lastDroppedAt !== null && status.lastDroppedReason !== null
            ? t('feed.status.withReason', { time: dateTime(status.lastDroppedAt), reason: tCode(t, `feed.drop.${status.lastDroppedReason}`) })
            : at(status.lastDroppedAt)}
        </dd>
        <dt>{t('feed.status.today')}</dt>
        <dd>
          {t('feed.status.todayValue', {
            batches: num(status.today.batches),
            maxBatches: num(status.limits.dailyBatches),
            kib: kib(status.today.bytes),
            maxKib: kib(status.limits.dailyBytes),
          })}
        </dd>
      </dl>
      <p className="muted">{t('feed.status.receivedLag')}</p>
    </div>
  );
}
