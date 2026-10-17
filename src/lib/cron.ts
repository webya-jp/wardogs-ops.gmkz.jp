// Cron(1 分ごと): スコア記録のサンプル取得と自動終了、毎時の掃除。docs/ARCHITECTURE.md 17.3・17.5・17.7。
// D1・fetch・時刻は引数で受け取る(単体テストできるように。src/worker.ts の scheduled から呼ぶ)。
// - 記録中が 0 件なら RCON を呼ばない(D1 の読み取り 1 回だけ。毎時 CLEANUP_MINUTE_UTC 分は掃除を続けて行う)
// - 例外は投げない(1 台の失敗で他の台を止めない)。D1 が無い・0003 未適用なら何もせずに終える
// - ログに出すのは件数とエラーコードだけ(ホスト名・サーバー名・プレイヤー名・パスワードは出さない。5.7)
import {
  FEED_RETENTION_DAYS,
  MAX_ACTIVE_RECORDINGS,
  RECORDING_EMPTY_END_MS,
  RECORDING_MAX_DURATION_MS,
} from '../types/api';
import type { ApiErrorCode, MatchEndReason, ScoreCapSource } from '../types/api';
import { CLEANUP_BATCH_ROWS, CLEANUP_MINUTE_UTC, CRON_RCON_CONCURRENCY } from '../types/env';
import type { CronEnv } from '../types/env';
import { utcDay } from './feed';
import { getKeys } from './keys';
import { rconRequest, READ_TIMEOUT_MS } from './rcon/client';
import type { ClientDeps } from './rcon/client';
import { normalizeRecordingPlayers, normalizeStatus } from './rcon/normalize';
import { READ_ROUTES } from './rcon/routes';
import { bucketMinute, buildSample, effectiveScoreCap, endRecording, reachedCap, RECORDING_RETENTION_MS, sampleInsertStmt } from './recordings';
import { baseUrlOf, decryptPassword } from './servers';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CronDeps extends ClientDeps {
  /** 鍵(server-password)。省略時は D1 の instance_key から派生する(isolate 内キャッシュ) */
  serverKey?: CryptoKey;
  /** ログ(テストで差し替える) */
  logSummary?: (entry: CronSummary) => void;
}

export interface CronSummary {
  kind: 'cron';
  recordings: number;
  sampled: number;
  ended: number;
  cleanup: boolean;
  failures: Partial<Record<ApiErrorCode | 'D1_UNAVAILABLE' | 'KEY_UNAVAILABLE' | 'INTERNAL', number>>;
}

interface ActiveRow {
  id: number;
  server_id: number;
  started_at: number;
  map: string | null;
  score_cap: number;
  score_cap_source: string;
  empty_since: number | null;
  s_id: number | null;
  s_host: string | null;
  s_port: number | null;
  s_scheme: string | null;
  s_password: string | null;
  s_enabled: number | null;
  s_score_cap: number | null;
}

const ACTIVE_SQL = `SELECT r.id, r.server_id, r.started_at, r.map, r.score_cap, r.score_cap_source, r.empty_since,
       s.id AS s_id, s.host AS s_host, s.port AS s_port, s.scheme AS s_scheme, s.rcon_password_enc AS s_password,
       s.enabled AS s_enabled, s.score_cap AS s_score_cap
  FROM match_recordings r LEFT JOIN servers s ON s.id = r.server_id
 WHERE r.status = 'recording' ORDER BY r.id LIMIT ?1`;

/** 毎時の掃除をする実行か(scheduledTime の UTC の分) */
export function isCleanupMinute(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() === CLEANUP_MINUTE_UTC;
}

/** 毎時の掃除(17.7)。1 つの表あたり CLEANUP_BATCH_ROWS 行まで */
export async function runCleanup(db: D1Database, now: number): Promise<void> {
  const n = CLEANUP_BATCH_ROWS;
  await db.batch([
    db
      .prepare(
        `DELETE FROM match_recordings WHERE id IN
           (SELECT id FROM match_recordings WHERE status = 'ended' AND ended_at < ?1 ORDER BY id LIMIT ?2)`,
      )
      .bind(now - RECORDING_RETENTION_MS, n),
    // 所属する試合が無いサンプル(上で消した試合の分を含む)
    db
      .prepare(
        `DELETE FROM match_samples WHERE (recording_id, bucket_minute) IN
           (SELECT recording_id, bucket_minute FROM match_samples
             WHERE recording_id NOT IN (SELECT id FROM match_recordings) LIMIT ?1)`,
      )
      .bind(n),
    db
      .prepare(
        `DELETE FROM feed_raw_events WHERE id IN
           (SELECT id FROM feed_raw_events WHERE received_at < ?1 ORDER BY id LIMIT ?2)`,
      )
      .bind(now - FEED_RETENTION_DAYS * DAY_MS, n),
    db.prepare('DELETE FROM feed_daily WHERE day < ?1').bind(utcDay(now) - 8),
    db.prepare('DELETE FROM server_feeds WHERE server_id NOT IN (SELECT id FROM servers)'),
  ]);
}

type ProcessResult = { sampled: boolean; ended: boolean; failure?: ApiErrorCode | 'INTERNAL' };

/** 1 台分(17.3 の 3)。例外は呼び出し側で数える */
async function processRecording(db: D1Database, row: ActiveRow, key: CryptoKey | null, t: number, deps: ClientDeps): Promise<ProcessResult> {
  const end = async (reason: MatchEndReason, lastScores?: Parameters<typeof endRecording>[1]['lastScores']): Promise<boolean> =>
    endRecording(db, { recordingId: Number(row.id), reason, now: t, ...(lastScores === undefined ? {} : { lastScores }) });

  // 1. サーバーが無い・無効・復号できない
  if (row.s_id === null || Number(row.s_enabled) !== 1 || row.s_host === null || row.s_port === null || row.s_scheme === null || !key) {
    return { sampled: false, ended: await end('server_unavailable') };
  }
  const ep = { scheme: row.s_scheme, host: row.s_host, port: Number(row.s_port) };
  const baseUrl = baseUrlOf(ep);
  const pw = row.s_password === null ? { ok: false as const } : await decryptPassword(key, row.s_password, ep);
  if (!baseUrl || !pw.ok) return { sampled: false, ended: await end('server_unavailable') };

  // 2. 開始から 3 時間
  if (t - Number(row.started_at) >= RECORDING_MAX_DURATION_MS) return { sampled: false, ended: await end('max_duration') };

  // 3. status(失敗したらこの分は何もしない)
  const rcon = { baseUrl, password: pw.plaintext };
  const st = await rconRequest(rcon, { route: READ_ROUTES.status, path: READ_ROUTES.status.template, timeoutMs: READ_TIMEOUT_MS }, deps);
  if (!st.ok) return { sampled: false, ended: false, failure: st.code };
  const status = normalizeStatus(st.data, t);
  if (!status) return { sampled: false, ended: false, failure: 'RCON_BAD_RESPONSE' };

  // 4. マップの変化(このサンプルは保存しない)
  if (status.map !== null && row.map !== null && status.map !== row.map) return { sampled: false, ended: await end('map_changed') };

  // 5. players(失敗しても続ける)
  const pr = await rconRequest(rcon, { route: READ_ROUTES.players, path: READ_ROUTES.players.template, timeoutMs: READ_TIMEOUT_MS }, deps);
  const players = pr.ok ? normalizeRecordingPlayers(pr.data) : null;

  // 6. サンプル(記録中のときだけ。同じ分は主キーで 1 行)
  const sample = buildSample(status, players, t);
  await sampleInsertStmt(db, { recordingId: Number(row.id) }, sample, bucketMinute(t)).run();

  // 7. 上限(status.scoreCap → サーバーの設定 → 既定)。記録の値と違えば更新する(変化したときだけ)
  const cap = effectiveScoreCap(status.scoreCap, row.s_score_cap);
  const updates: { cap?: { cap: number; source: ScoreCapSource }; emptySince?: number | null } = {};
  if (cap.cap !== Number(row.score_cap) || cap.source !== row.score_cap_source) updates.cap = cap;
  if (reachedCap(sample.factionScores, cap.cap)) {
    if (updates.cap) await writeUpdates(db, row, updates, t);
    return { sampled: true, ended: await end('score_cap', sample.factionScores) };
  }

  // 8. 人数 0 が 10 分
  const current = status.players.current;
  if (current === 0) {
    if (row.empty_since === null) updates.emptySince = t;
    else if (t - Number(row.empty_since) >= RECORDING_EMPTY_END_MS) {
      if (updates.cap) await writeUpdates(db, row, { cap: updates.cap }, t);
      return { sampled: true, ended: await end('empty', sample.factionScores) };
    }
  } else if (typeof current === 'number' && current > 0 && row.empty_since !== null) {
    updates.emptySince = null;
  }
  await writeUpdates(db, row, updates, t);
  return { sampled: true, ended: false };
}

/** 上限・empty_since の変化を 1 文で書く(変化が無ければ書かない) */
async function writeUpdates(
  db: D1Database,
  row: ActiveRow,
  u: { cap?: { cap: number; source: ScoreCapSource }; emptySince?: number | null },
  t: number,
): Promise<void> {
  if (u.cap === undefined && u.emptySince === undefined) return;
  const sets: string[] = ['updated_at = ?2'];
  const args: unknown[] = [Number(row.id), t];
  if (u.cap) {
    args.push(u.cap.cap, u.cap.source);
    sets.push(`score_cap = ?${args.length - 1}`, `score_cap_source = ?${args.length}`);
  }
  if (u.emptySince !== undefined) {
    args.push(u.emptySince);
    sets.push(`empty_since = ?${args.length}`);
  }
  await db
    .prepare(`UPDATE match_recordings SET ${sets.join(', ')} WHERE id = ?1 AND status = 'recording'`)
    .bind(...args)
    .run();
}

/** 同時に limit 件まで処理する */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * scheduled ハンドラの本体。scheduledTime = controller.scheduledTime(サンプルの時刻と 1 分バケットに使う)。
 * 例外を投げない
 */
export async function runCron(env: CronEnv, scheduledTime: number, deps: CronDeps = {}): Promise<CronSummary> {
  const summary: CronSummary = { kind: 'cron', recordings: 0, sampled: 0, ended: 0, cleanup: false, failures: {} };
  const count = (code: keyof CronSummary['failures']) => {
    summary.failures[code] = (summary.failures[code] ?? 0) + 1;
  };
  const log = deps.logSummary ?? ((e: CronSummary) => console.log(JSON.stringify(e)));
  const db = env.DB;
  const t = scheduledTime;
  if (!db) {
    count('D1_UNAVAILABLE');
    log(summary);
    return summary;
  }

  let rows: ActiveRow[];
  try {
    const { results } = await db.prepare(ACTIVE_SQL).bind(MAX_ACTIVE_RECORDINGS).all<ActiveRow>();
    rows = results ?? [];
  } catch {
    // D1 が無い・0003 未適用。何も書かない
    count('D1_UNAVAILABLE');
    log(summary);
    return summary;
  }
  summary.recordings = rows.length;

  if (rows.length > 0) {
    let key: CryptoKey | null = deps.serverKey ?? null;
    if (!key) {
      try {
        key = (await getKeys(db)).serverPassword;
      } catch {
        // 鍵が読めない間は各記録を server_unavailable で終えず、この分は何もしない(D1 の一時的な失敗の可能性)
        count('KEY_UNAVAILABLE');
        log(summary);
        return summary;
      }
    }
    const results = await pool(rows, CRON_RCON_CONCURRENCY, async (row) => {
      try {
        return await processRecording(db, row, key, t, deps);
      } catch {
        return { sampled: false, ended: false, failure: 'INTERNAL' as const };
      }
    });
    for (const r of results) {
      if (r.sampled) summary.sampled += 1;
      if (r.ended) summary.ended += 1;
      if (r.failure) count(r.failure);
    }
  }

  if (isCleanupMinute(t)) {
    try {
      await runCleanup(db, t);
      summary.cleanup = true;
    } catch {
      count('INTERNAL');
    }
  }
  log(summary);
  return summary;
}
