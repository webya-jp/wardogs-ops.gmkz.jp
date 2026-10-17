// 監査ログ(D1 audit_log)。docs/ARCHITECTURE.md 4.3・8.1・8.4。
// - 書き込み操作は実行前に pending で INSERT(confirm_nonce の UNIQUE で 1 回限り)→ RCON の結果で succeeded / failed に UPDATE
// - 表示文言は保存しない(event + params + target_name を保存し、画面がカタログで組み立てる)
// - 生の IP・パスワード(管理・RCON)・ハッシュ・暗号文・鍵・Cookie は保存しない
// - RCON の接続先(ホスト名・ポート)は audit_log には保存しない(rcon_route はパスだけ)。settings_audit_log と servers には
//   運営者が登録したホスト名・ポートを保存する(サーバーの追加・変更・削除の内容として。画面に出る運営者自身のデータ。QA M-4)
// - 書き込み操作の行には対象サーバー(server_id: servers.id、server_name: その時点の表示名)を残す(ARCHITECTURE 15.6)。
//   server_id が NULL の書き込み行は複数サーバー対応前の行(対象不明。API では serverId: null)
// - サーバー設定の変更・管理者の登録は settings_audit_log(別テーブル。listSettingsAudit)
import { API_ERROR_CODES, SETTINGS_EVENTS } from '../types/api';
import type { ApiErrorCode, AuditEntry, AuditEventType, AuditStatus, ServerId, WriteAction } from '../types/api';

export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const THROTTLE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface AuditActor {
  operator: string | null;
  sessionTag: string | null;
  ipHash: string | null;
}

/** 書き込み操作の対象サーバー(audit_log の server_id / server_name) */
export interface AuditServer {
  /** servers.id(解決できなかった場合も指定された id。null は対象不明) */
  serverId: number | null;
  serverName: string | null;
}

export interface PendingInput extends AuditActor, AuditServer {
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
                              target_steam_id, target_name, params_json, rcon_route, confirm_nonce, server_id, server_name)
       VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
      p.serverId,
      p.serverName,
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
  e: AuditActor &
    AuditServer & {
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
                              target_steam_id, params_json, error_code, server_id, server_name)
       VALUES (?1, ?1, ?2, 'failed', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      e.now,
      e.event,
      e.operator,
      e.sessionTag,
      e.ipHash,
      e.targetSteamId,
      JSON.stringify(e.params),
      e.errorCode,
      e.serverId,
      e.serverName,
    )
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
  server_id: number | null;
  server_name: string | null;
}

const ERROR_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** D1 の status は pending / succeeded / failed のまま。RCON タイムアウトの failed だけ API では 'unknown'(結果不明) */
export function toApiStatus(status: string, errorCode: string | null): AuditStatus {
  return status === 'failed' && errorCode === 'RCON_TIMEOUT' ? 'unknown' : (status as AuditStatus);
}

function parseParams(json: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json ?? '{}');
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 壊れた行は空として扱う
  }
  return {};
}

const SESSION_EVENTS: ReadonlySet<string> = new Set(['login', 'logout']);

export function toEntry(r: AuditRow): AuditEntry {
  const params = parseParams(r.params_json);
  const isSession = SESSION_EVENTS.has(r.event);
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
    // login / logout はサーバーに関係しない。書き込み操作で NULL は複数サーバー対応前の行(対象不明)
    serverId: isSession || r.server_id === null || r.server_id === undefined ? null : String(r.server_id),
    serverName: isSession ? null : (r.server_name ?? null),
  };
}

/** /api/audit の server(all = 絞り込みなし) */
export type AuditServerFilter = 'all' | ServerId;

function pageOf(rows: AuditEntry[], limit: number): { entries: AuditEntry[]; nextBefore: number | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { entries: page, nextBefore: rows.length > limit && last ? last.id : null };
}

/** 操作ログ(audit_log)。server を指定すると、その対象サーバーの書き込み操作だけ(login / logout は除く) */
export async function listAudit(
  db: D1Database,
  q: { limit: number; before: number | null; server?: AuditServerFilter },
): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const cols = `id, created_at, finished_at, event, status, operator, session_tag, target_steam_id, target_name,
                params_json, rcon_status, error_code, server_id, server_name`;
  const where: string[] = [];
  const args: unknown[] = [q.limit + 1];
  if (q.before !== null) {
    args.push(q.before);
    where.push(`id < ?${args.length}`);
  }
  const server = q.server ?? 'all';
  if (server !== 'all') {
    where.push(`event NOT IN ('login', 'logout')`);
    args.push(Number(server));
    where.push(`server_id = ?${args.length}`);
  }
  const sql = `SELECT ${cols} FROM audit_log${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?1`;
  const { results } = await db
    .prepare(sql)
    .bind(...args)
    .all<AuditRow>();
  return pageOf((results ?? []).map(toEntry), q.limit);
}

interface SettingsRow {
  id: number;
  created_at: number;
  event: string;
  operator: string | null;
  session_tag: string | null;
  server_id: number | null;
  server_name: string | null;
  params_json: string | null;
}

const SETTINGS_EVENT_SET: ReadonlySet<string> = new Set(SETTINGS_EVENTS);

/** 拒否の記録(QA M-2)。status = failed、errorCode = VALIDATION_FAILED(理由は params.reason) */
const REJECTED_EVENTS: ReadonlySet<string> = new Set(['server_update_rejected', 'server_delete_rejected']);

/**
 * 行の status / errorCode(docs/API.md 3 章): 拒否の 2 つは failed + VALIDATION_FAILED。
 * server_test は params.result が 'ok' なら succeeded、それ以外は failed で errorCode = params.result(RCON_*)。その他は succeeded
 * (2026-10-17 の record_start / record_stop / record_end / feed_token_issue / feed_token_revoke / feed_settings_update もすべて succeeded。
 *  失敗した記録の開始・停止は書かないため。docs/ARCHITECTURE.md 17.2。トークンの値・ハッシュは params に入れていない)
 */
function settingsOutcome(event: string, params: Record<string, unknown>): { status: AuditStatus; errorCode: ApiErrorCode | null } {
  if (REJECTED_EVENTS.has(event)) return { status: 'failed', errorCode: 'VALIDATION_FAILED' };
  if (event === 'server_test') {
    const result = params.result;
    if (result === 'ok') return { status: 'succeeded', errorCode: null };
    return { status: 'failed', errorCode: typeof result === 'string' && ERROR_CODES.has(result) ? (result as ApiErrorCode) : null };
  }
  return { status: 'succeeded', errorCode: null };
}

/** 未知の event(SETTINGS_EVENTS に無いもの)は null(一覧から飛ばす) */
function toSettingsEntry(r: SettingsRow): AuditEntry | null {
  if (!SETTINGS_EVENT_SET.has(r.event)) return null;
  const params = parseParams(r.params_json);
  return {
    id: Number(r.id),
    createdAt: Number(r.created_at),
    finishedAt: Number(r.created_at),
    event: r.event as AuditEventType,
    ...settingsOutcome(r.event, params),
    operator: r.operator,
    sessionTag: r.session_tag,
    targetSteamId: null,
    targetName: null,
    params,
    rconStatus: null,
    serverId: r.server_id === null ? null : String(r.server_id),
    serverName: r.server_name ?? null,
  };
}

/**
 * 設定変更ログ(settings_audit_log)。status / errorCode は settingsOutcome(拒否は failed、接続テストは結果しだい)。target・rcon は null。
 * event はコード側で検証する(未知の値は飛ばす)
 */
export async function listSettingsAudit(
  db: D1Database,
  q: { limit: number; before: number | null; server?: AuditServerFilter },
): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const server = q.server ?? 'all';
  const where: string[] = [];
  const args: unknown[] = [q.limit + 1];
  if (q.before !== null) {
    args.push(q.before);
    where.push(`id < ?${args.length}`);
  }
  if (server !== 'all') {
    args.push(Number(server));
    where.push(`server_id = ?${args.length}`);
  }
  const sql = `SELECT id, created_at, event, operator, session_tag, server_id, server_name, params_json
                 FROM settings_audit_log${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?1`;
  const { results } = await db
    .prepare(sql)
    .bind(...args)
    .all<SettingsRow>();
  const rows = results ?? [];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    entries: page.map(toSettingsEntry).filter((e): e is AuditEntry => e !== null),
    // 未知の event を飛ばしても、次のページの位置は行の id で決める
    nextBefore: rows.length > q.limit && last ? Number(last.id) : null,
  };
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
    db.prepare('DELETE FROM settings_audit_log WHERE created_at < ?1').bind(now - AUDIT_RETENTION_MS),
    db.prepare('DELETE FROM status_snapshots WHERE taken_at < ?1').bind(now - SNAPSHOT_RETENTION_MS),
    db.prepare('DELETE FROM server_snapshots WHERE taken_at < ?1').bind(now - SNAPSHOT_RETENTION_MS),
    db.prepare('DELETE FROM login_throttle WHERE window_start < ?1').bind(now - THROTTLE_RETENTION_MS),
  ]);
}
