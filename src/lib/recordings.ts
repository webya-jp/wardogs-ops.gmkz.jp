// スコア記録: サンプルの組み立て・上限の決め方・終了処理・保持数の削除・一覧と推移の読み取り。docs/ARCHITECTURE.md 17.1〜17.3・17.5・17.7、docs/API.md 8 章。
// D1・時刻は引数で受け取る(cloudflare:workers に依存させない)。開始・停止の二段階(prepare / execute)は actions.ts、毎分の処理は cron.ts。
// - サンプルにはプレイヤー名を入れない(陣営ごとの人数と cash の合計。roster_json は Steam ID → 陣営の添字だけ。17.10.4)
// - 終了は `status = 'recording'` 条件の UPDATE で 1 回だけ。record_end は UPDATE が行を返したときだけ書く(Cron の二重実行でも 1 行)
import {
  MATCH_END_REASONS,
  MATCH_FACTIONS_MAX,
  MATCH_SAMPLES_MAX,
  MAX_ACTIVE_RECORDINGS,
  RECORDING_KEEP_ENDED,
  RECORDING_RETENTION_DAYS,
  SCORE_CAP_DEFAULT,
} from '../types/api';
import type {
  FactionScore,
  FactionStat,
  MatchEndReason,
  MatchSample,
  MatchSamplesResponse,
  MatchesResponse,
  MatchId,
  MatchSummary,
  ScoreCapSource,
  ServerId,
  StatusResponse,
} from '../types/api';
import type { RecordingPlayer } from './rcon/normalize';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECORDING_RETENTION_MS = RECORDING_RETENTION_DAYS * DAY_MS;

/** match_samples.bucket_minute = floor(unix 秒 / 60) */
export function bucketMinute(nowMs: number): number {
  return Math.floor(nowMs / 60_000);
}

// ============================================================
// 上限(17.5): status.scoreCap(正の数)→ servers.score_cap → SCORE_CAP_DEFAULT
// ============================================================

export function effectiveScoreCap(statusCap: number | null | undefined, settingCap: number | null | undefined): { cap: number; source: ScoreCapSource } {
  if (typeof statusCap === 'number' && Number.isFinite(statusCap) && statusCap > 0) return { cap: statusCap, source: 'status' };
  if (typeof settingCap === 'number' && Number.isFinite(settingCap) && settingCap > 0) return { cap: settingCap, source: 'setting' };
  return { cap: SCORE_CAP_DEFAULT, source: 'default' };
}

/** 保存したサンプルのいずれかの陣営スコアが上限以上か(スコアが上限に向かって増える前提。R-21) */
export function reachedCap(scores: FactionScore[], cap: number): boolean {
  return scores.some((s) => typeof s.score === 'number' && s.score >= cap);
}

// ============================================================
// サンプルの組み立て
// ============================================================

/**
 * status(必須)と players(取れなければ null)から 1 分のサンプルを作る。
 * players が null なら cashTotal は null、factions は空。数値の cash を持つ人が 1 人もいなければ cash は null
 */
export function buildSample(status: StatusResponse, players: RecordingPlayer[] | null, at: number): MatchSample {
  let cashTotal: number | null = null;
  const factions: FactionStat[] = [];
  if (players) {
    const byFaction = new Map<string | null, FactionStat>();
    for (const p of players) {
      if (typeof p.cash === 'number') cashTotal = (cashTotal ?? 0) + p.cash;
      let f = byFaction.get(p.faction);
      if (!f) {
        // 陣営の数は上限まで(超えた陣営の人は数えない。cashTotal には入る)
        if (byFaction.size >= MATCH_FACTIONS_MAX) continue;
        f = { faction: p.faction, players: 0, cash: null };
        byFaction.set(p.faction, f);
      }
      f.players += 1;
      if (typeof p.cash === 'number') f.cash = (f.cash ?? 0) + p.cash;
    }
    factions.push(...byFaction.values());
  }
  return {
    at,
    map: status.map,
    players: { current: status.players.current, max: status.players.max },
    factionScores: status.factionScores.slice(0, MATCH_FACTIONS_MAX),
    cashTotal,
    factions,
  };
}

/**
 * サンプルを INSERT OR IGNORE する文。どちらの形も「記録中の試合」があるときだけ入れる
 * (Cron が手動停止と同じ分に動いても終了後の行を作らない。17.3 の 6)。
 * - recordingId: Cron(試合を指定)
 * - activeServerId: record_start の batch(同じ batch で作った記録中の試合を副問い合わせで引く。17.2)
 */
export function sampleInsertStmt(
  db: D1Database,
  target: { recordingId: number } | { activeServerId: number },
  sample: MatchSample,
  bucket: number,
  /** 陣営の付与用の観測(killfeed/store.ts の buildRosterJson。名前は入れない。17.10.4)。無ければ null */
  rosterJson: string | null = null,
): D1PreparedStatement {
  const values = [
    bucket,
    sample.at,
    sample.map,
    sample.players.current,
    sample.players.max,
    JSON.stringify(sample.factionScores),
    sample.cashTotal,
    JSON.stringify(sample.factions),
  ];
  if ('recordingId' in target) {
    return db
      .prepare(
        `INSERT OR IGNORE INTO match_samples (recording_id, bucket_minute, taken_at, map, players_current, players_max,
                                              faction_scores_json, cash_total, faction_stats_json, roster_json)
         SELECT ?9, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10
          WHERE EXISTS (SELECT 1 FROM match_recordings WHERE id = ?9 AND status = 'recording')`,
      )
      .bind(...values, target.recordingId, rosterJson);
  }
  return db
    .prepare(
      `INSERT OR IGNORE INTO match_samples (recording_id, bucket_minute, taken_at, map, players_current, players_max,
                                            faction_scores_json, cash_total, faction_stats_json, roster_json)
       SELECT id, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10 FROM match_recordings WHERE server_id = ?9 AND status = 'recording'`,
    )
    .bind(...values, target.activeServerId, rosterJson);
}

// ============================================================
// D1 の行 → API の型
// ============================================================

export interface RecordingRow {
  id: number;
  server_id: number;
  server_name: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  map: string | null;
  score_cap: number;
  score_cap_source: string;
  empty_since: number | null;
  last_scores_json: string | null;
  created_at: number;
  updated_at: number;
}

interface SummaryRow extends RecordingRow {
  sample_count: number;
  last_sample_at: number | null;
  last_sample_scores: string | null;
}

const END_REASONS: ReadonlySet<string> = new Set(MATCH_END_REASONS);
const CAP_SOURCES: ReadonlySet<string> = new Set(['status', 'setting', 'default']);

function parseJsonArray(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseScores(json: string | null | undefined): FactionScore[] {
  return parseJsonArray(json)
    .slice(0, MATCH_FACTIONS_MAX)
    .map((s): FactionScore => {
      const o = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
      return {
        faction: typeof o.faction === 'string' ? o.faction : null,
        score: typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : null,
      };
    });
}

function parseStats(json: string | null | undefined): FactionStat[] {
  return parseJsonArray(json)
    .slice(0, MATCH_FACTIONS_MAX)
    .map((s): FactionStat => {
      const o = typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
      return {
        faction: typeof o.faction === 'string' ? o.faction : null,
        players: typeof o.players === 'number' && Number.isFinite(o.players) ? o.players : 0,
        cash: typeof o.cash === 'number' && Number.isFinite(o.cash) ? o.cash : null,
      };
    });
}

const SUMMARY_COLS = `r.id, r.server_id, r.server_name, r.status, r.started_at, r.ended_at, r.end_reason, r.map, r.score_cap,
  r.score_cap_source, r.empty_since, r.last_scores_json, r.created_at, r.updated_at,
  (SELECT COUNT(*) FROM match_samples s WHERE s.recording_id = r.id) AS sample_count,
  (SELECT MAX(s.taken_at) FROM match_samples s WHERE s.recording_id = r.id) AS last_sample_at,
  (SELECT s.faction_scores_json FROM match_samples s WHERE s.recording_id = r.id ORDER BY s.bucket_minute DESC LIMIT 1) AS last_sample_scores`;

function toSummary(r: SummaryRow): MatchSummary {
  const recording = r.status === 'recording';
  return {
    id: String(r.id),
    serverId: String(r.server_id),
    serverName: r.server_name ?? null,
    status: recording ? 'recording' : 'ended',
    startedAt: Number(r.started_at),
    endedAt: recording || r.ended_at === null ? null : Number(r.ended_at),
    endReason: !recording && r.end_reason && END_REASONS.has(r.end_reason) ? (r.end_reason as MatchEndReason) : null,
    map: r.map ?? null,
    scoreCap: Number(r.score_cap),
    scoreCapSource: CAP_SOURCES.has(r.score_cap_source) ? (r.score_cap_source as ScoreCapSource) : 'default',
    sampleCount: Number(r.sample_count ?? 0),
    lastSampleAt: r.last_sample_at === null || r.last_sample_at === undefined ? null : Number(r.last_sample_at),
    // 記録中は最後のサンプル、終了済みは終了時の値(無ければ最後のサンプル)
    lastScores: parseScores(recording ? r.last_sample_scores : (r.last_scores_json ?? r.last_sample_scores)),
  };
}

/** 1 試合の要約(無ければ null) */
export async function getMatchSummary(db: D1Database, id: number): Promise<MatchSummary | null> {
  const row = await db.prepare(`SELECT ${SUMMARY_COLS} FROM match_recordings r WHERE r.id = ?1`).bind(id).first<SummaryRow>();
  return row ? toSummary(row) : null;
}

/** そのサーバーの記録中の試合(無ければ null) */
export async function getActiveRecording(db: D1Database, serverId: number): Promise<RecordingRow | null> {
  return db
    .prepare(`SELECT * FROM match_recordings WHERE server_id = ?1 AND status = 'recording'`)
    .bind(serverId)
    .first<RecordingRow>();
}

/** 全サーバーで記録中の数 */
export async function countActiveRecordings(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM match_recordings WHERE status = 'recording'`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** GET /api/matches?server=: 記録中(あれば先頭)→ 終了済みの新しい順(最大 RECORDING_KEEP_ENDED 件) */
export async function listMatches(db: D1Database, server: ServerId): Promise<MatchesResponse> {
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLS} FROM match_recordings r WHERE r.server_id = ?1
        ORDER BY CASE WHEN r.status = 'recording' THEN 0 ELSE 1 END, r.id DESC LIMIT ?2`,
    )
    .bind(Number(server), RECORDING_KEEP_ENDED + 2)
    .all<SummaryRow>();
  const all = (results ?? []).map(toSummary);
  const active = all.filter((m) => m.status === 'recording').slice(0, 1);
  const ended = all.filter((m) => m.status === 'ended').slice(0, RECORDING_KEEP_ENDED);
  return { server, matches: [...active, ...ended], activeLimit: MAX_ACTIVE_RECORDINGS, activeCount: await countActiveRecordings(db) };
}

/** GET /api/matches/:id/samples(server を指定して違えば null = MATCH_NOT_FOUND) */
export async function getMatchSamples(db: D1Database, id: MatchId, server: ServerId | null): Promise<MatchSamplesResponse | null> {
  const match = await getMatchSummary(db, Number(id));
  if (!match || (server !== null && match.serverId !== server)) return null;
  const { results } = await db
    .prepare(
      `SELECT taken_at, map, players_current, players_max, faction_scores_json, cash_total, faction_stats_json
         FROM match_samples WHERE recording_id = ?1 ORDER BY bucket_minute LIMIT ?2`,
    )
    .bind(Number(id), MATCH_SAMPLES_MAX)
    .all<{
      taken_at: number;
      map: string | null;
      players_current: number | null;
      players_max: number | null;
      faction_scores_json: string;
      cash_total: number | null;
      faction_stats_json: string;
    }>();
  const samples: MatchSample[] = (results ?? []).map((r) => ({
    at: Number(r.taken_at),
    map: r.map ?? null,
    players: {
      current: r.players_current === null ? null : Number(r.players_current),
      max: r.players_max === null ? null : Number(r.players_max),
    },
    factionScores: parseScores(r.faction_scores_json),
    cashTotal: r.cash_total === null ? null : Number(r.cash_total),
    factions: parseStats(r.faction_stats_json),
  }));
  return { match, samples };
}

// ============================================================
// 終了(共通)と保持数の削除(17.3 の 4、17.7)
// ============================================================

/**
 * 終了時の削除: そのサーバーの終了済みの試合のうち、新しい順で RECORDING_KEEP_ENDED + 1 番目以降と、
 * ended_at が 30 日より古いものをサンプルごと削除する
 */
export async function pruneEndedRecordings(db: D1Database, serverId: number, now: number): Promise<void> {
  const victims = `SELECT id FROM match_recordings
                    WHERE server_id = ?1 AND status = 'ended'
                      AND (ended_at < ?2 OR id NOT IN (SELECT id FROM match_recordings
                                                        WHERE server_id = ?1 AND status = 'ended' ORDER BY id DESC LIMIT ?3))`;
  await db.batch([
    db.prepare(`DELETE FROM match_samples WHERE recording_id IN (${victims})`).bind(serverId, now - RECORDING_RETENTION_MS, RECORDING_KEEP_ENDED),
    db.prepare(`DELETE FROM match_recordings WHERE id IN (${victims})`).bind(serverId, now - RECORDING_RETENTION_MS, RECORDING_KEEP_ENDED),
  ]);
}

export interface EndInput {
  recordingId: number;
  reason: MatchEndReason;
  now: number;
  /** 終了時の陣営スコア。省略時は最後のサンプルの値 */
  lastScores?: FactionScore[];
}

/**
 * 記録を終える(manual 以外の理由。manual は actions.ts の record_stop が同じ形の UPDATE を batch で行う)。
 * 終了の UPDATE と record_end の INSERT を 1 つの batch(1 トランザクション)で行い、監査行の無い終了を作らない(QA M-3)。
 * INSERT は「この呼び出しの UPDATE で終わった行」(status = ended・ended_at・end_reason が今回の値)があり、
 * その試合の record_end がまだ無いときだけ入る(UPDATE が空振りした二重実行では入らない)。
 * 終えた場合は保持数を超えた試合を消して true
 */
export async function endRecording(db: D1Database, e: EndInput): Promise<boolean> {
  const scores = e.lastScores === undefined ? null : JSON.stringify(e.lastScores.slice(0, MATCH_FACTIONS_MAX));
  const [updated] = await db.batch<{ id: number; server_id: number }>([
    db
      .prepare(
        `UPDATE match_recordings SET status = 'ended', ended_at = ?2, end_reason = ?3, updated_at = ?2,
                last_scores_json = COALESCE(?4, (SELECT faction_scores_json FROM match_samples
                                                  WHERE recording_id = ?1 ORDER BY bucket_minute DESC LIMIT 1))
          WHERE id = ?1 AND status = 'recording'
         RETURNING id, server_id`,
      )
      .bind(e.recordingId, e.now, e.reason, scores),
    db
      .prepare(
        `INSERT INTO settings_audit_log (created_at, event, operator, session_tag, ip_hash, server_id, server_name, params_json)
         SELECT ?2, 'record_end', NULL, NULL, NULL, r.server_id, r.server_name,
                json_object('recordingId', CAST(r.id AS TEXT), 'reason', ?3)
           FROM match_recordings r
          WHERE r.id = ?1 AND r.status = 'ended' AND r.ended_at = ?2 AND r.end_reason = ?3
            AND NOT EXISTS (SELECT 1 FROM settings_audit_log a
                             WHERE a.event = 'record_end' AND a.server_id = r.server_id
                               AND json_extract(a.params_json, '$.recordingId') = CAST(r.id AS TEXT))`,
      )
      .bind(e.recordingId, e.now, e.reason),
  ]);
  const row = updated?.results?.[0];
  if (!row) return false;
  await pruneEndedRecordings(db, Number(row.server_id), e.now);
  return true;
}

/** そのサーバーの記録中の試合があれば終える(このパネルの map / match_end の成功時。17.5 の match_action) */
export async function endActiveRecording(db: D1Database, serverId: number, reason: MatchEndReason, now: number): Promise<boolean> {
  const active = await getActiveRecording(db, serverId);
  if (!active) return false;
  return endRecording(db, { recordingId: Number(active.id), reason, now });
}
