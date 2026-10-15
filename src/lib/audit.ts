// 監査ログ(D1 audit_log)。docs/ARCHITECTURE.md 4.3・8.1・8.4。
// - 書き込み操作は実行前に pending で INSERT(confirm_nonce の UNIQUE で 1 回限り)→ RCON の結果で succeeded / failed に UPDATE
// - 表示文言は保存しない(event + params + target_name を保存し、画面がカタログで組み立てる)
// - 生の IP・パスワード・Cookie・RCON の接続先は保存しない
import { API_ERROR_CODES } from '../types/api';
import type { ApiErrorCode, AuditEntry, AuditEventType, AuditStatus, WriteAction } from '../types/api';

export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const THROTTLE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface AuditActor {
  operator: string | null;
  sessionTag: string | null;
  ipHash: string | null;
}

export interface PendingInput extends AuditActor {
  now: number;
  event: AuditEventType;
  targetSteamId: string | null;
  targetName: string | null;
  params: Record<string, unknown>;
  rconRoute: string | null;
  nonce: string;
}

/** pending の行を作る。同じ nonce が既にあれば 'duplicate' */
export async function insertPending(db: D1Database, p: PendingInput): Promise<number | 'duplicate'> {
  const row = await db
    .prepare(
      `INSERT INTO audit_log (created_at, event, status, operator, session_tag, ip_hash,
                              target_steam_id, target_name, params_json, rcon_route, confirm_nonce)
       VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(confirm_nonce) DO NOTHING
       RETURNING id`,
    )
    .bind(
      p.now,
      p.event,
      p.operator,
      p.sessionTag,
      p.ipHash,
      p.targetSteamId,
      p.targetName,
      JSON.stringify(p.params),
      p.rconRoute,
      p.nonce,
    )
    .first<{ id: number }>();
  return row ? Number(row.id) : 'duplicate';
}

export async function finishAudit(
  db: D1Database,
  id: number,
  r: { status: 'succeeded' | 'failed'; now: number; rconStatus: number | null; errorCode: ApiErrorCode | null },
): Promise<void> {
  await db
    .prepare(`UPDATE audit_log SET status = ?2, finished_at = ?3, rcon_status = ?4, error_code = ?5 WHERE id = ?1`)
    .bind(id, r.status, r.now, r.rconStatus, r.errorCode)
    .run();
}

/**
 * RCON を呼ぶ前に拒否した書き込み操作を 1 行で記録する(status=failed、error_code 付き、nonce なし)。
 * 対象: execute の確認トークン検証失敗(CONFIRM_INVALID / CONFIRM_EXPIRED)、CAPABILITY_MISSING。
 * 入力検証失敗(400 VALIDATION_FAILED)とログイン失敗は記録しない(D1 の書き込み枠の節約)
 */
export async function recordRejected(
  db: D1Database,
  e: AuditActor & {
    now: number;
    event: WriteAction;
    targetSteamId: string | null;
    params: Record<string, unknown>;
    errorCode: ApiErrorCode;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (created_at, finished_at, event, status, operator, session_tag, ip_hash,
                              target_steam_id, params_json, error_code)
       VALUES (?1, ?1, ?2, 'failed', ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(e.now, e.event, e.operator, e.sessionTag, e.ipHash, e.targetSteamId, JSON.stringify(e.params), e.errorCode)
    .run();
}

/** login / logout を 1 行で記録する */
export async function recordSessionEvent(
  db: D1Database,
  e: AuditActor & { event: 'login' | 'logout'; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (created_at, finished_at, event, status, operator, session_tag, ip_hash, params_json)
       VALUES (?1, ?1, ?2, 'succeeded', ?3, ?4, ?5, '{}')`,
    )
    .bind(e.now, e.event, e.operator, e.sessionTag, e.ipHash)
    .run();
}

export interface AuditRow {
  id: number;
  created_at: number;
  finished_at: number | null;
  event: string;
  status: string;
  operator: string | null;
  session_tag: string | null;
  target_steam_id: string | null;
  target_name: string | null;
  params_json: string | null;
  rcon_status: number | null;
  error_code: string | null;
}

const ERROR_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** D1 の status は pending / succeeded / failed のまま。RCON タイムアウトの failed だけ API では 'unknown'(結果不明) */
export function toApiStatus(status: string, errorCode: string | null): AuditStatus {
  return status === 'failed' && errorCode === 'RCON_TIMEOUT' ? 'unknown' : (status as AuditStatus);
}

export function toEntry(r: AuditRow): AuditEntry {
  let params: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(r.params_json ?? '{}');
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) params = v as Record<string, unknown>;
  } catch {
    params = {};
  }
  return {
    id: Number(r.id),
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    event: r.event as AuditEventType,
    status: toApiStatus(r.status, r.error_code),
    operator: r.operator,
    sessionTag: r.session_tag,
    targetSteamId: r.target_steam_id,
    targetName: r.target_name,
    params,
    rconStatus: r.rcon_status === null ? null : Number(r.rcon_status),
    errorCode: r.error_code !== null && ERROR_CODES.has(r.error_code) ? (r.error_code as ApiErrorCode) : null,
  };
}

export async function listAudit(
  db: D1Database,
  q: { limit: number; before: number | null },
): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const cols = `id, created_at, finished_at, event, status, operator, session_tag, target_steam_id, target_name,
                params_json, rcon_status, error_code`;
  const stmt =
    q.before === null
      ? db.prepare(`SELECT ${cols} FROM audit_log ORDER BY id DESC LIMIT ?1`).bind(q.limit + 1)
      : db.prepare(`SELECT ${cols} FROM audit_log WHERE id < ?2 ORDER BY id DESC LIMIT ?1`).bind(q.limit + 1, q.before);
  const { results } = await stmt.all<AuditRow>();
  const rows = results ?? [];
  const page = rows.slice(0, q.limit).map(toEntry);
  const last = page[page.length - 1];
  return { entries: page, nextBefore: rows.length > q.limit && last ? last.id : null };
}

/** BAN 一覧の名前補完: 成功した ban の、同じ Steam ID の最新の target_name */
export async function knownBanNames(db: D1Database, steamIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(steamIds)].slice(0, 2000);
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT target_steam_id AS sid, target_name AS name, MAX(created_at) AS at
         FROM audit_log
        WHERE event = 'ban' AND status = 'succeeded' AND target_name IS NOT NULL
          AND target_steam_id IN (SELECT value FROM json_each(?1))
        GROUP BY target_steam_id`,
    )
    .bind(JSON.stringify(ids))
    .all<{ sid: string; name: string }>();
  for (const r of results ?? []) if (r.sid && r.name) out.set(r.sid, r.name);
  return out;
}

/** unban の対象名: 監査ログに残る同じ Steam ID の最新の名前 */
export async function lastKnownName(db: D1Database, steamId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT target_name FROM audit_log
        WHERE target_steam_id = ?1 AND target_name IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(steamId)
    .first<{ target_name: string }>();
  return row?.target_name ?? null;
}

/** 保持期間を過ぎた行の掃除(ログイン成功時に実行。docs/ARCHITECTURE.md 8.4) */
export async function cleanupOldRows(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM audit_log WHERE created_at < ?1').bind(now - AUDIT_RETENTION_MS),
    db.prepare('DELETE FROM status_snapshots WHERE taken_at < ?1').bind(now - SNAPSHOT_RETENTION_MS),
    db.prepare('DELETE FROM login_throttle WHERE window_start < ?1').bind(now - THROTTLE_RETENTION_MS),
  ]);
}

/**
 * D1 が無く AUDIT_REQUIRED="false" で書き込みを実行した場合の記録。Workers Logs に操作種別・結果コード・sessionTag だけを出す
 * (対象の Steam ID・本文・名前は出さない。docs/ARCHITECTURE.md 7.4)
 */
export function logWithoutAudit(action: string, result: ApiErrorCode | 'OK', sessionTag: string | null): void {
  console.log(JSON.stringify({ kind: 'write-without-audit', action, result, sessionTag }));
}
