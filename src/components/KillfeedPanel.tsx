// キルフィードタブ(/killfeed)。docs/ARCHITECTURE.md 9.6・17.9・17.10.7、docs/API.md 8・9・11 章。上から:
//  1. 試合の選択(現在の試合〔記録中〕+ 直近 5 試合 + 記録外のキル〔受信用トークンを発行済みのとき〕)
//  2. 現在のスコア(記録中はサイドバーと共有の /api/status。終了済みは試合終了時のスコア。記録外は出さない)
//  3. スコアの推移(ScoreChart)と試合の要約(折りたたみ)
//  4. 統計カード 5 枚 → 5. 時間帯別 + 6. 最長キル → 7. 上位のプレイヤー + 武器・原因 → 8. 距離
//  9. キルログ(フィルタ・検索・JSON で書き出す)→ 10. 今日の受信 → 11. 受信した生データ(FeedRawList)→ 12. この画面について
// 集計はブラウザで行う(src/components/lib/killstats.ts)。キルは記録中・記録外を表示している間 30 秒ごとに差分を取る。
// マップ名・陣営名・プレイヤー名・武器名は生データなので翻訳しない(テキストとして描画する)。
import { useEffect, useMemo, useState } from 'react';
import {
  KILLFEED_UNRECORDED,
  KILLFEED_UNRECORDED_MAX,
  KILLFEED_UNRECORDED_RETENTION_DAYS,
  POLL_MIN_INTERVAL_SEC,
  RECORDING_SAMPLE_INTERVAL_SEC,
} from '../types/api';
import type { FactionScore, KillfeedScope, KillfeedSummary, MatchesResponse, MatchSample, MatchSamplesResponse, MatchSummary } from '../types/api';
import { withServer } from './lib/api';
import { useAutoRefresh, useI18n, useResource } from './lib/hooks';
import type { I18n, I18nProps } from './lib/hooks';
import { tCode } from './lib/keys';
import { useKillfeed } from './lib/killfeed-data';
import type { KillfeedState } from './lib/killfeed-data';
import { meters, partyName, ratio, weaponLabel } from './lib/killfmt';
import { buildKillfeedExport, exportFileName, formatGameTime, summarizeKills, summarizeOptionsFor } from './lib/killstats';
import type { TimeRange } from './lib/killstats';
import { elapsedMinutes, factionLabel, matchOptionLabel, scoreCapText, scoresLine } from './lib/matches';
import { useSharedStatus } from './lib/status-store';
import type { TargetServer } from './ConfirmDialog';
import ErrorView from './ErrorView';
import FactionBadge from './FactionBadge';
import FeedRawList from './FeedRawList';
import KillDistanceChart from './KillDistanceChart';
import KillLog from './KillLog';
import KillStatsCards from './KillStatsCards';
import KillTimelineChart from './KillTimelineChart';
import ScoreChart from './ScoreChart';

interface Props extends I18nProps {
  server: TargetServer;
  /** 受信用トークンを発行済みか(ServerSummary.feedConfigured)。記録外のキルの選択肢を出す */
  feedConfigured?: boolean;
}

export default function KillfeedPanel({ language, timeZone, server, feedConfigured = false }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, num } = i18n;
  const matches = useResource<MatchesResponse>(withServer('/api/matches', server.id), null);
  const list = matches.data?.matches ?? [];
  const [selectedId, setSelectedId] = useState<KillfeedScope | null>(null);
  const showUnrecorded = feedConfigured || selectedId === KILLFEED_UNRECORDED;

  // 選択が無い・一覧から消えた(古い試合の削除)ときは先頭(記録中があればそれ)、試合が無ければ記録外を選ぶ
  useEffect(() => {
    if (!matches.data) return;
    const ids = matches.data.matches.map((m) => m.id);
    if (selectedId === KILLFEED_UNRECORDED) return;
    if (selectedId === null || !ids.includes(selectedId)) {
      setSelectedId(ids[0] ?? (feedConfigured ? KILLFEED_UNRECORDED : null));
    }
  }, [matches.data, selectedId, feedConfigured]);

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
        <p>{t('killfeed.intro')}</p>
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
        {(list.length > 0 || (matches.data && showUnrecorded)) && (
          <div className="field match-select">
            <label htmlFor="killfeed-match">{t('killfeed.match.label')}</label>
            <select id="killfeed-match" value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {matchOptionLabel(m, i18n)}
                </option>
              ))}
              {showUnrecorded && (
                <option value={KILLFEED_UNRECORDED}>{t('killfeed.scope.unrecorded', { count: num(KILLFEED_UNRECORDED_MAX) })}</option>
              )}
            </select>
          </div>
        )}
      </section>

      {selected && (
        <MatchView
          key={selected.id}
          i18n={i18n}
          server={server}
          match={selected}
          settingsHref={settingsHref}
          onRecordingRefresh={matches.refresh}
        />
      )}
      {selectedId === KILLFEED_UNRECORDED && (
        <UnrecordedView key={KILLFEED_UNRECORDED} i18n={i18n} server={server} settingsHref={settingsHref} />
      )}

      <FeedRawList i18n={i18n} serverId={server.id} settingsHref={settingsHref} />

      <section className="card" aria-labelledby="killfeed-notes-title">
        <h2 id="killfeed-notes-title">{t('killfeed.notes.title')}</h2>
        <ul className="kill-notes">
          <li>{t('killfeed.notes.points')}</li>
          <li>{t('killfeed.notes.faction')}</li>
          <li>{t('killfeed.notes.distance')}</li>
          <li>{t('killfeed.notes.unverified')}</li>
          <li>{t('killfeed.notes.time')}</li>
        </ul>
      </section>
    </>
  );
}

interface MatchViewProps {
  i18n: I18n;
  server: TargetServer;
  /** 一覧の値(推移の応答が届くまでの表示と、記録中かどうかの判定に使う) */
  match: MatchSummary;
  settingsHref: string;
  /** 記録中の試合を自動更新するときに、試合の一覧も取り直す */
  onRecordingRefresh: () => void;
}

function MatchView({ i18n, server, match, settingsHref, onRecordingRefresh }: MatchViewProps) {
  const { t, time } = i18n;
  const samples = useResource<MatchSamplesResponse>(
    withServer(`/api/matches/${encodeURIComponent(match.id)}/samples`, server.id),
    null,
  );
  const feed = useKillfeed(server.id, match.id);
  // 推移・キルの応答の要約を優先する(一覧より新しい)
  const m = feed.data?.match ?? samples.data?.match ?? match;
  const recording = m.status === 'recording';
  useAutoRefresh(samples.refresh, recording, RECORDING_SAMPLE_INTERVAL_SEC);
  useAutoRefresh(onRecordingRefresh, recording, RECORDING_SAMPLE_INTERVAL_SEC);
  const factions = feed.data?.factions ?? [];

  return (
    <>
      {recording ? (
        <LiveScore i18n={i18n} serverId={server.id} factions={factions} />
      ) : (
        <ScoreCard i18n={i18n} title={t('killfeed.score.final')} scores={m.lastScores} factions={factions} />
      )}

      <section className="card" aria-labelledby="killfeed-chart-title">
        <div className="toolbar">
          <h2 id="killfeed-chart-title">{t('killfeed.progression.title')}</h2>
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
        <details className="chart-details">
          <summary>{t('killfeed.summary.title')}</summary>
          <MatchSummaryList i18n={i18n} match={m} />
        </details>
      </section>

      <KillsBody
        i18n={i18n}
        server={server}
        scope={match.id}
        match={m}
        samples={samples.data?.samples ?? []}
        feed={feed}
        settingsHref={settingsHref}
      />
    </>
  );
}

function UnrecordedView({ i18n, server, settingsHref }: { i18n: I18n; server: TargetServer; settingsHref: string }) {
  const { t, num } = i18n;
  const feed = useKillfeed(server.id, KILLFEED_UNRECORDED);
  return (
    <>
      <p className="alert">{t('killfeed.scope.unrecordedHelp', { days: num(KILLFEED_UNRECORDED_RETENTION_DAYS) })}</p>
      <KillsBody i18n={i18n} server={server} scope={KILLFEED_UNRECORDED} match={null} samples={[]} feed={feed} settingsHref={settingsHref} />
    </>
  );
}

function MatchSummaryList({ i18n, match: m }: { i18n: I18n; match: MatchSummary }) {
  const { t, dateTime, num } = i18n;
  const recording = m.status === 'recording';
  return (
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
  );
}

/** 記録中の試合のスコア(サイドバーと共有の /api/status。追加のリクエストは無い) */
function LiveScore({ i18n, serverId, factions }: { i18n: I18n; serverId: string; factions: readonly string[] }) {
  const { t, num } = i18n;
  const status = useSharedStatus(serverId);
  return (
    <ScoreCard
      i18n={i18n}
      title={t('killfeed.score.title')}
      scores={status.data?.factionScores ?? []}
      factions={factions}
      note={t('killfeed.score.live', { seconds: num(POLL_MIN_INTERVAL_SEC) })}
      loading={!status.data && !status.error}
    />
  );
}

interface ScoreCardProps {
  i18n: I18n;
  title: string;
  scores: readonly FactionScore[];
  factions: readonly string[];
  note?: string;
  loading?: boolean;
}

function ScoreCard({ i18n, title, scores, factions, note, loading = false }: ScoreCardProps) {
  const { t, num } = i18n;
  return (
    <section className="card" aria-labelledby="killfeed-score-title">
      <h2 id="killfeed-score-title">{title}</h2>
      {note && <p className="muted">{note}</p>}
      {loading ? (
        <p aria-live="polite">{t('common.loading')}</p>
      ) : scores.length === 0 ? (
        <p className="muted">{t('killfeed.score.none')}</p>
      ) : (
        <ul className="score-board">
          {scores.map((s, i) => (
            <li key={`${s.faction ?? '#'}-${i}`}>
              <FactionBadge i18n={i18n} faction={s.faction} factions={factions} />
              <span className="score-board-name">{factionLabel(s.faction, i, i18n)}</span>
              <span className="score-board-value">{num(s.score)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface KillsBodyProps {
  i18n: I18n;
  server: TargetServer;
  scope: KillfeedScope;
  match: MatchSummary | null;
  samples: readonly MatchSample[];
  feed: KillfeedState;
  settingsHref: string;
}

function KillsBody({ i18n, server, scope, match, samples, feed, settingsHref }: KillsBodyProps) {
  const { t, time, num } = i18n;
  const [bucket, setBucket] = useState<TimeRange | null>(null);
  const kills = feed.data?.kills ?? [];
  const factions = feed.data?.factions ?? [];
  const startedAt = match?.startedAt ?? null;
  const endedAt = match?.endedAt ?? null;
  // 起点・終点は試合の開始・終了(記録中は最後に取得した時刻)。記録外はキルから決める。
  // 記録中の終点(summaryAt)は画面の集計と JSON の書き出しで同じ値を使う(棒の数・幅を一致させる)
  const summaryAt = useMemo(() => feed.updatedAt ?? Date.now(), [feed.updatedAt]);
  const summary = useMemo(
    () => summarizeKills(kills, summarizeOptionsFor(startedAt === null ? null : { startedAt, endedAt }, summaryAt)),
    [kills, startedAt, endedAt, summaryAt],
  );

  // 選んだ棒が時間帯の区切りから消えたら(幅が変わったなど)選択を外す
  useEffect(() => {
    if (bucket && !summary.timeline.buckets.some((b) => b.start === bucket.start)) setBucket(null);
  }, [bucket, summary]);

  const onExport = (): boolean => {
    try {
      const exportedAt = Date.now();
      const data = buildKillfeedExport({
        server: { id: server.id, name: server.label },
        scope,
        match,
        samples,
        kills,
        truncated: feed.data?.truncated ?? false,
        timeZone: i18n.timeZone,
        exportedAt,
        summaryAt,
      });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(server.id, scope, exportedAt, i18n.timeZone);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return true;
    } catch {
      return false;
    }
  };

  const today = feed.data?.today ?? null;

  return (
    <>
      <section className="card" aria-labelledby="killfeed-stats-title">
        <div className="toolbar">
          <h2 id="killfeed-stats-title">{t('killfeed.stats.title')}</h2>
          <span className="spacer" />
          <button type="button" className="button-small" onClick={feed.refresh} disabled={feed.loading}>
            {feed.loading ? t('common.loading') : t('common.refresh')}
          </button>
        </div>
        {feed.updatedAt !== null && <p className="muted">{t('common.lastUpdated', { time: time(feed.updatedAt) })}</p>}
        {feed.error && (
          <>
            <ErrorView error={feed.error} t={t} />
            {feed.data && <p className="muted">{t('common.staleData')}</p>}
          </>
        )}
        {!feed.data && !feed.error && <p aria-live="polite">{t('common.loading')}</p>}
        {feed.data && !feed.data.configured && (
          <div className="alert alert-warn">
            <p>{t('feed.raw.notConfigured')}</p>
            <p>
              <a href={settingsHref}>{t('feed.raw.toSettings')}</a>
            </p>
          </div>
        )}
        {feed.data && <KillStatsCards i18n={i18n} summary={summary} />}
      </section>

      {feed.data && (
        <>
          <div className="kill-row kill-row-wide">
            <section className="card" aria-labelledby="killfeed-timeline-title">
              <h2 id="killfeed-timeline-title">{t('killfeed.timeline.title')}</h2>
              <p className="muted">{t('killfeed.timeline.help', { minutes: num(summary.timeline.bucketMinutes) })}</p>
              <KillTimelineChart i18n={i18n} timeline={summary.timeline} selected={bucket} onSelect={setBucket} />
            </section>
            <LongestCard i18n={i18n} summary={summary} factions={factions} />
          </div>

          <div className="kill-row">
            <TopPlayers i18n={i18n} summary={summary} factions={factions} />
            <WeaponsTable i18n={i18n} summary={summary} />
          </div>

          <section className="card" aria-labelledby="killfeed-distance-title">
            <h2 id="killfeed-distance-title">{t('killfeed.distance.title')}</h2>
            <KillDistanceChart i18n={i18n} summary={summary} />
          </section>

          <KillLog
            i18n={i18n}
            kills={kills}
            factions={factions}
            bucket={bucket}
            live={feed.live}
            truncated={match !== null && feed.truncated}
            onExport={onExport}
          />
        </>
      )}

      {today && (
        <section className="card" aria-labelledby="killfeed-ingest-title">
          <h2 id="killfeed-ingest-title">{t('killfeed.ingest.title')}</h2>
          <p>
            {t('killfeed.ingest.value', {
              kills: num(today.kills),
              other: num(today.otherEvents),
              incomplete: num(today.incomplete),
              dropped: num(today.droppedKills),
            })}
          </p>
          {today.incomplete > 0 && <p className="alert alert-warn">{t('killfeed.ingest.incompleteHelp')}</p>}
        </section>
      )}
    </>
  );
}

function LongestCard({ i18n, summary, factions }: { i18n: I18n; summary: KillfeedSummary; factions: readonly string[] }) {
  const { t, time } = i18n;
  const k = summary.longest;
  return (
    <section className="card" aria-labelledby="killfeed-longest-title">
      <h2 id="killfeed-longest-title">{t('killfeed.longest.title')}</h2>
      {!k || k.distanceM === null ? (
        <p className="muted">{t('killfeed.longest.none')}</p>
      ) : (
        <div className="kill-longest">
          <p className="kill-longest-distance">{t('killfeed.stats.longestValue', { distance: meters(i18n, k.distanceM) })}</p>
          <p className="kill-longest-line">
            <span className="visually-hidden">{t('killfeed.log.killer')}</span>
            {k.killer && <FactionBadge i18n={i18n} faction={k.killer.faction} factions={factions} />}
            <span className="kl-name">{partyName(i18n, k.killer)}</span>
            <span aria-hidden="true">{t('killfeed.log.arrow')}</span>
            <span className="visually-hidden">{t('killfeed.log.victim')}</span>
            {k.victim && <FactionBadge i18n={i18n} faction={k.victim.faction} factions={factions} />}
            <span className="kl-name">{partyName(i18n, k.victim)}</span>
          </p>
          <p>{weaponLabel(i18n, k)}</p>
          <p className="muted">
            {t('killfeed.log.received', { time: time(k.receivedAt) })}
            {k.gameTimeSec !== null && <> {t('killfeed.log.gameTime', { time: formatGameTime(k.gameTimeSec) })}</>}
          </p>
          {k.flags.headshot && <span className="kill-flag kill-flag-headshot">{t('killfeed.flag.headshot')}</span>}
        </div>
      )}
    </section>
  );
}

function TopPlayers({ i18n, summary, factions }: { i18n: I18n; summary: KillfeedSummary; factions: readonly string[] }) {
  const { t, num } = i18n;
  return (
    <section className="card" aria-labelledby="killfeed-top-title">
      <h2 id="killfeed-top-title">{t('killfeed.top.title')}</h2>
      {summary.topPlayers.length === 0 ? (
        <p className="muted">{t('killfeed.top.none')}</p>
      ) : (
        <div className="table-wrap">
          <table className="kill-table">
            <thead>
              <tr>
                <th scope="col">{t('killfeed.top.colPlayer')}</th>
                <th scope="col" className="num">
                  <abbr title={t('killfeed.top.colKillsLabel')}>{t('killfeed.top.colKills')}</abbr>
                </th>
                <th scope="col" className="num">
                  <abbr title={t('killfeed.top.colDeathsLabel')}>{t('killfeed.top.colDeaths')}</abbr>
                </th>
                <th scope="col" className="num">
                  <abbr title={t('killfeed.top.colKdLabel')}>{t('killfeed.top.colKd')}</abbr>
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.topPlayers.map((p) => (
                <tr key={p.key}>
                  <td className="kill-table-name">
                    <FactionBadge i18n={i18n} faction={p.faction} factions={factions} />
                    <span className="kl-name">{p.name ?? t('killfeed.log.unknownPlayer')}</span>
                  </td>
                  <td className="num">{num(p.kills)}</td>
                  <td className="num">{num(p.deaths)}</td>
                  <td className="num">{ratio(i18n, p.kd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WeaponsTable({ i18n, summary }: { i18n: I18n; summary: KillfeedSummary }) {
  const { t, num } = i18n;
  return (
    <section className="card" aria-labelledby="killfeed-weapons-title">
      <h2 id="killfeed-weapons-title">{t('killfeed.weapons.title')}</h2>
      {summary.weapons.length === 0 ? (
        <p className="muted">{t('killfeed.weapons.none')}</p>
      ) : (
        <div className="table-wrap">
          <table className="kill-table kill-table-weapons">
            <thead>
              <tr>
                <th scope="col">{t('killfeed.weapons.colWeapon')}</th>
                <th scope="col" className="num">
                  {t('killfeed.weapons.colKills')}
                </th>
                <th scope="col" className="num">
                  <abbr title={t('killfeed.weapons.colHeadshotsLabel')}>{t('killfeed.weapons.colHeadshots')}</abbr>
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.weapons.map((w) => (
                <tr key={w.key}>
                  <td className="kill-table-name">{weaponLabel(i18n, w)}</td>
                  <td className="num">{num(w.kills)}</td>
                  <td className="num">{num(w.headshots)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
