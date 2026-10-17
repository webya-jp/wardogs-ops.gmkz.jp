// キルフィードタブ(/killfeed)。docs/ARCHITECTURE.md 9.6・17.9、docs/API.md 8・9 章。上から:
// 1. 試合の選択(現在の試合〔記録中〕+ 直近 5 試合。開始時刻・マップ・終了理由)。記録が無ければ概要タブへの案内
// 2. グラフ(ScoreChart。スコア / cash の切り替え)
// 3. 試合の要約(開始・終了・理由・上限と出所・記録数・最後の陣営スコア)
// 4. 受信した生データ(FeedRawList。観測モード)
// 自動更新は「記録中の試合を表示している間」だけ 60 秒ごと(試合の一覧と推移)。終了済みの試合は 1 回だけ取る。
// マップ名・陣営名は RCON の生データなので翻訳しない。
import { useEffect, useState } from 'react';
import { RECORDING_SAMPLE_INTERVAL_SEC } from '../types/api';
import type { MatchesResponse, MatchSamplesResponse, MatchSummary } from '../types/api';
import { withServer } from './lib/api';
import { useAutoRefresh, useI18n, useResource } from './lib/hooks';
import type { I18n, I18nProps } from './lib/hooks';
import { tCode } from './lib/keys';
import { elapsedMinutes, matchOptionLabel, scoreCapText, scoresLine } from './lib/matches';
import type { TargetServer } from './ConfirmDialog';
import ErrorView from './ErrorView';
import FeedRawList from './FeedRawList';
import ScoreChart from './ScoreChart';

interface Props extends I18nProps {
  server: TargetServer;
}

export default function KillfeedPanel({ language, timeZone, server }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time } = i18n;
  const matches = useResource<MatchesResponse>(withServer('/api/matches', server.id), null);
  const list = matches.data?.matches ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 選択が無い・一覧から消えた(古い試合の削除)ときは先頭(記録中があればそれ)を選ぶ
  useEffect(() => {
    if (!matches.data) return;
    const ids = matches.data.matches.map((m) => m.id);
    if (selectedId === null || !ids.includes(selectedId)) setSelectedId(ids[0] ?? null);
  }, [matches.data, selectedId]);

  const selected = list.find((m) => m.id === selectedId) ?? null;
  const overviewHref = `/?server=${encodeURIComponent(server.id)}`;
  const settingsHref = `/servers?server=${encodeURIComponent(server.id)}#feed`;

  return (
    <>
      <section className="card" aria-labelledby="killfeed-title">
        <div className="toolbar">
          <h1 id="killfeed-title">{t('killfeed.title')}</h1>
          <span className="spacer" />
          <button type="button" className="button-small" onClick={matches.refresh} disabled={matches.loading}>
            {matches.loading ? t('common.loading') : t('common.refresh')}
          </button>
        </div>
        <p>{t('killfeed.why')}</p>
        <p className="muted">{t('killfeed.comingSoon')}</p>
        {matches.updatedAt !== null && <p className="muted">{t('common.lastUpdated', { time: time(matches.updatedAt) })}</p>}
        {matches.error && <ErrorView error={matches.error} t={t} />}
        {!matches.data && !matches.error && <p aria-live="polite">{t('common.loading')}</p>}
        {matches.data && list.length === 0 && (
          <div className="alert">
            <p>{t('killfeed.noMatches')}</p>
            <p>
              <a href={overviewHref}>{t('killfeed.toOverview')}</a>
            </p>
          </div>
        )}
        {list.length > 0 && (
          <div className="field match-select">
            <label htmlFor="killfeed-match">{t('killfeed.match.label')}</label>
            <select id="killfeed-match" value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {matchOptionLabel(m, i18n)}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {selected && (
        <MatchView key={selected.id} i18n={i18n} serverId={server.id} match={selected} onRecordingRefresh={matches.refresh} />
      )}

      <FeedRawList i18n={i18n} serverId={server.id} settingsHref={settingsHref} />
    </>
  );
}

interface MatchViewProps {
  i18n: I18n;
  serverId: string;
  /** 一覧の値(推移の応答が届くまでの表示と、記録中かどうかの判定に使う) */
  match: MatchSummary;
  /** 記録中の試合を自動更新するときに、試合の一覧も取り直す */
  onRecordingRefresh: () => void;
}

function MatchView({ i18n, serverId, match, onRecordingRefresh }: MatchViewProps) {
  const { t, time, dateTime, num } = i18n;
  const samples = useResource<MatchSamplesResponse>(
    withServer(`/api/matches/${encodeURIComponent(match.id)}/samples`, serverId),
    null,
  );
  // 推移の応答の要約を優先する(一覧より新しい)
  const m = samples.data?.match ?? match;
  const recording = m.status === 'recording';
  useAutoRefresh(samples.refresh, recording, RECORDING_SAMPLE_INTERVAL_SEC);
  useAutoRefresh(onRecordingRefresh, recording, RECORDING_SAMPLE_INTERVAL_SEC);

  return (
    <>
      <section className="card" aria-labelledby="killfeed-chart-title">
        <div className="toolbar">
          <h2 id="killfeed-chart-title">{t('killfeed.chart.title')}</h2>
          {recording && <span className="badge badge-ok">{t('killfeed.summary.recording')}</span>}
          <span className="spacer" />
          <button type="button" className="button-small" onClick={samples.refresh} disabled={samples.loading}>
            {samples.loading ? t('common.loading') : t('common.refresh')}
          </button>
        </div>
        <p className="muted">
          {samples.updatedAt !== null && <>{t('common.lastUpdated', { time: time(samples.updatedAt) })} </>}
          {recording ? t('killfeed.autoRefresh', { seconds: RECORDING_SAMPLE_INTERVAL_SEC }) : t('killfeed.endedNoRefresh')}
        </p>
        {samples.error && (
          <>
            <ErrorView error={samples.error} t={t} />
            {samples.data && <p className="muted">{t('common.staleData')}</p>}
          </>
        )}
        {!samples.data && !samples.error && <p aria-live="polite">{t('common.loading')}</p>}
        {samples.data && <ScoreChart i18n={i18n} match={m} samples={samples.data.samples} />}
      </section>

      <section className="card" aria-labelledby="killfeed-summary-title">
        <h2 id="killfeed-summary-title">{t('killfeed.summary.title')}</h2>
        <dl className="kv">
          <dt>{t('killfeed.summary.status')}</dt>
          <dd>{recording ? t('killfeed.summary.recording') : t('killfeed.summary.ended')}</dd>
          <dt>{t('killfeed.summary.map')}</dt>
          <dd className="mono">{m.map ?? t('common.unknown')}</dd>
          <dt>{t('killfeed.summary.startedAt')}</dt>
          <dd>{dateTime(m.startedAt)}</dd>
          <dt>{t('killfeed.summary.endedAt')}</dt>
          <dd>{m.endedAt !== null ? dateTime(m.endedAt) : t('common.none')}</dd>
          <dt>{t('recording.elapsed')}</dt>
          <dd>{t('recording.elapsedValue', { minutes: num(elapsedMinutes(m, Date.now())) })}</dd>
          <dt>{t('killfeed.summary.endReason')}</dt>
          <dd>{m.endReason ? tCode(t, `match.endReason.${m.endReason}`) : t('common.none')}</dd>
          <dt>{t('killfeed.summary.scoreCap')}</dt>
          <dd>{scoreCapText(m, i18n)}</dd>
          <dt>{t('killfeed.summary.sampleCount')}</dt>
          <dd>{t('recording.sampleCountValue', { count: num(m.sampleCount) })}</dd>
          <dt>{t('killfeed.summary.lastSample')}</dt>
          <dd>{m.lastSampleAt !== null ? dateTime(m.lastSampleAt) : t('recording.noSample')}</dd>
          <dt>{t('killfeed.summary.lastScores')}</dt>
          <dd>{scoresLine(m.lastScores, i18n)}</dd>
        </dl>
      </section>
    </>
  );
}
