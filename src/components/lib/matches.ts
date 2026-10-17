// スコア記録(試合)の表示用の小さな関数(概要タブとキルフィードタブで共通。docs/ARCHITECTURE.md 17.9)。
// マップ名・陣営名は RCON の生データなので翻訳しない。終了理由・上限の出所はカタログで引く。
import type { FactionScore, MatchSummary } from '../../types/api';
import type { I18n } from './hooks';
import { tCode } from './keys';

/** 上限と出所(例「100(既定)」) */
export function scoreCapText(match: Pick<MatchSummary, 'scoreCap' | 'scoreCapSource'>, i18n: I18n): string {
  const { t, num } = i18n;
  return t('recording.scoreCapValue', { cap: num(match.scoreCap), source: tCode(t, `recording.capSource.${match.scoreCapSource}`) });
}

/** 開始からの経過(分。切り捨て)。終了済みなら終了時刻まで */
export function elapsedMinutes(match: Pick<MatchSummary, 'startedAt' | 'endedAt'>, now: number): number {
  const end = match.endedAt ?? now;
  return Math.max(0, Math.floor((end - match.startedAt) / 60_000));
}

/** 陣営名(RCON の生データ)。名前が無い陣営は「不明な陣営 n」 */
export function factionLabel(faction: string | null, index: number, i18n: I18n): string {
  return faction ?? i18n.t('chart.unknownFaction', { n: index + 1 });
}

/** 陣営スコアを 1 行にする(例「A 12・B 30」) */
export function scoresLine(scores: readonly FactionScore[], i18n: I18n): string {
  if (scores.length === 0) return i18n.t('common.none');
  return scores
    .map((s, i) => i18n.t('chart.ariaValue', { name: factionLabel(s.faction, i, i18n), value: i18n.num(s.score) }))
    .join(i18n.t('status.listSeparator'));
}

/** 試合の選択肢・見出しに使う 1 行 */
export function matchOptionLabel(match: MatchSummary, i18n: I18n): string {
  const { t, dateTime } = i18n;
  const map = match.map ?? t('common.unknown');
  if (match.status === 'recording') return t('killfeed.match.current', { time: dateTime(match.startedAt), map });
  const reason = match.endReason ? tCode(t, `match.endReason.${match.endReason}`) : t('common.unknown');
  return t('killfeed.match.ended', { time: dateTime(match.startedAt), map, reason });
}
