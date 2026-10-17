// キルフィード 第 1 段階(観測モード): 受信用トークン・受信・生データ。docs/ARCHITECTURE.md 5.8・17.6・17.7、docs/API.md 7.3・9・10 章。
// D1・時刻は引数で受け取る(cloudflare:workers に依存させない)。
// - トークン: `wof1.<ServerId>.<32 バイトの乱数の base64url>`。D1 には SHA-256 のハッシュ(`sha256$<base64url>`)と末尾 4 文字だけ。
//   平文は発行の応答で 1 回だけ返す。検証は ServerId で 1 行を引き、ハッシュ同士を定数時間で比較する(isolate 内に 60 秒キャッシュ)
// - 受信: 処理の順序は 17.6 の表のとおり。上限・無効で捨てるときも 204(ゲームの再送を増やさない)
// - トークン(平文・ハッシュ)・Authorization・本文・接続元 IP をログ・エラー応答・settings_audit_log の params に出さない
// - このファイルは servers.ts を import しない(servers.ts が削除時に invalidateFeedToken を呼ぶため。循環を避ける)
import {
  FEED_DAILY_MAX_BATCHES,
  FEED_DAILY_MAX_BYTES,
  FEED_DROP_REASONS,
  FEED_GLOBAL_DAILY_MAX_BATCHES,
  FEED_GLOBAL_DAILY_MAX_BYTES,
  FEED_INGEST_PATH,
  FEED_MAX_BODY_BYTES,
  FEED_RATE_PER_MIN,
  FEED_RAW_PAGE_DEFAULT,
  FEED_RAW_PAGE_MAX,
  FEED_REJECT_REASONS,
  FEED_RETENTION_DAYS,
  FEED_TOKEN_CACHE_SEC,
  FEED_TOKEN_PATTERN,
  FEED_TOKEN_PREFIX,
  MAX_SERVERS,
  SERVER_ID_PATTERN,
} from '../types/api';
import type {
  ApiErrorCode,
  FeedDropReason,
  FeedRawEntry,
  FeedRawResponse,
  FeedRejectReason,
  FeedTokenResponse,
  ServerFeedStatus,
  ServerId,
  ValidationIssue,
} from '../types/api';
import type { AuditActor } from './audit';
import { discardBody, isPlainObject, jsonError, readLimited } from './http';
import type { ErrorOptions } from './http';
import { b64urlToBytes, bytesToB64url, randomB64url, timingSafeEqualBytes } from './keys';

export type FeedOutcome<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; opts?: ErrorOptions };

const fail = (code: ApiErrorCode, opts?: ErrorOptions): FeedOutcome<never> => (opts ? { ok: false, code, opts } : { ok: false, code });

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_RANDOM_BYTES = 32;
const TOKEN_HINT_LENGTH = 4;
const HASH_PREFIX = 'sha256$';
const enc = new TextEncoder();

/** UTC の日(feed_daily.day) */
export function utcDay(now: number): number {
  return Math.floor(now / DAY_MS);
}

// ============================================================
// トークン
// ============================================================

/** 新しいトークン(平文)。呼び出し側は D1 にハッシュだけを保存し、平文は応答で 1 回だけ返す */
export function generateFeedToken(server: ServerId): string {
  return `${FEED_TOKEN_PREFIX}.${server}.${randomB64url(TOKEN_RANDOM_BYTES)}`;
}

async function digest(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(token)));
}

/** D1 に保存する形 `sha256$<SHA-256(トークン全体) の base64url>` */
export async function hashFeedToken(token: string): Promise<string> {
  return `${HASH_PREFIX}${bytesToB64url(await digest(token))}`;
}

/** 保存したハッシュを 32 バイトに戻す。形式不正なら null */
function storedHashBytes(stored: string): Uint8Array | null {
  if (!stored.startsWith(HASH_PREFIX)) return null;
  const b = b64urlToBytes(stored.slice(HASH_PREFIX.length));
  return b && b.byteLength === 32 ? b : null;
}

/** `Authorization: Bearer <token>` から形式の合うトークンと ServerId を取り出す(D1 は読まない) */
export function parseBearerFeedToken(header: string | null): { token: string; server: ServerId } | null {
  if (!header) return null;
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  const token = m?.[1];
  if (!token) return null;
  const t = FEED_TOKEN_PATTERN.exec(token);
  return t?.[1] ? { token, server: t[1] } : null;
}

// ---- 検証用のキャッシュ(isolate 内、サーバーごと 60 秒。行が無いことも覚える) ----

interface FeedAuthRow {
  /** null = server_feeds に行が無い */
  hash: Uint8Array | null;
  enabled: boolean;
  /** servers に行があり enabled = 1 */
  serverUsable: boolean;
  at: number;
}

const MAX_CACHE = MAX_SERVERS * 3;
const authCache = new Map<ServerId, FeedAuthRow>();

/** 再発行・取り消し・設定変更・サーバー削除のときに、この isolate のキャッシュを捨てる(他の isolate は最大 60 秒遅れる) */
export function invalidateFeedToken(server?: ServerId): void {
  if (server === undefined) authCache.clear();
  else authCache.delete(server);
}

async function loadAuthRow(db: D1Database, server: ServerId, now: number): Promise<FeedAuthRow> {
  const cached = authCache.get(server);
  if (cached && now - cached.at < FEED_TOKEN_CACHE_SEC * 1000) return cached;
  const row = await db
    .prepare(
      `SELECT f.token_hash AS token_hash, f.enabled AS enabled, s.enabled AS server_enabled
         FROM server_feeds f LEFT JOIN servers s ON s.id = f.server_id
        WHERE f.server_id = ?1`,
    )
    .bind(Number(server))
    .first<{ token_hash: string; enabled: number; server_enabled: number | null }>();
  const entry: FeedAuthRow = row
    ? {
        hash: storedHashBytes(row.token_hash),
        enabled: Number(row.enabled) === 1,
        serverUsable: row.server_enabled !== null && Number(row.server_enabled) === 1,
        at: now,
      }
    : { hash: null, enabled: false, serverUsable: false, at: now };
  authCache.delete(server);
  authCache.set(server, entry);
  while (authCache.size > MAX_CACHE) {
    const first = authCache.keys().next();
    if (first.done) break;
    authCache.delete(first.value);
  }
  return entry;
}

export type FeedTokenCheck =
  | { ok: true; server: ServerId; row: FeedAuthRow }
  /** rowExists: そのサーバーに行がある(= 不一致。受信の状況に token_invalid を残す) */
  | { ok: false; server: ServerId | null; rowExists: boolean };

/** 形式 → D1 の 1 行(キャッシュ)→ SHA-256 同士の定数時間比較 */
export async function verifyFeedToken(db: D1Database, header: string | null, now: number): Promise<FeedTokenCheck> {
  const parsed = parseBearerFeedToken(header);
  if (!parsed) return { ok: false, server: null, rowExists: false };
  const row = await loadAuthRow(db, parsed.server, now);
  // 行が無い場合も同じだけハッシュを計算する(応答時間で行の有無を区別しにくくする)
  const got = await digest(parsed.token);
  if (!row.hash) return { ok: false, server: parsed.server, rowExists: false };
  if (!timingSafeEqualBytes(got, row.hash)) return { ok: false, server: parsed.server, rowExists: true };
  return { ok: true, server: parsed.server, row };
}

// ============================================================
// レート制限(isolate 内、サーバーごとの固定窓 1 分)
// ============================================================

const rateWindows = new Map<ServerId, { start: number; count: number }>();

/** 枠内なら null、超えたら Retry-After の秒数 */
export function takeFeedRate(server: ServerId, now: number): number | null {
  const minute = 60_000;
  const w = rateWindows.get(server);
  if (!w || now - w.start >= minute) {
    rateWindows.delete(server);
    rateWindows.set(server, { start: now, count: 1 });
    while (rateWindows.size > MAX_CACHE) {
      const first = rateWindows.keys().next();
      if (first.done) break;
      rateWindows.delete(first.value);
    }
    return null;
  }
  if (w.count >= FEED_RATE_PER_MIN) return Math.max(1, Math.ceil((w.start + minute - now) / 1000));
  w.count += 1;
  return null;
}

// ============================================================
// 受信の状況(server_feeds.last_*)の間引き更新(isolate ごとにサーバーあたり 1 分に 1 回まで)
// ============================================================

interface PendingStatus {
  received?: number;
  stored?: number;
  rejected?: { at: number; reason: FeedRejectReason };
  dropped?: { at: number; reason: FeedDropReason };
}

const STATUS_FLUSH_MS = 60_000;
const pendingStatus = new Map<ServerId, PendingStatus>();
const lastFlush = new Map<ServerId, number>();

export function resetFeedForTest(): void {
  authCache.clear();
  rateWindows.clear();
  pendingStatus.clear();
  lastFlush.clear();
}

function noteStatus(server: ServerId, patch: PendingStatus): void {
  const cur = pendingStatus.get(server) ?? {};
  pendingStatus.set(server, { ...cur, ...patch });
}

/**
 * 溜めた受信の状況を D1 に書く(前回から 1 分未満なら書かずに次に回す)。書く場合は Promise を返す。
 * 失敗しても受信の結果は変えない
 */
function flushStatus(db: D1Database, server: ServerId, now: number): Promise<void> | null {
  const last = lastFlush.get(server);
  if (last !== undefined && now - last < STATUS_FLUSH_MS) return null;
  const p = pendingStatus.get(server);
  if (!p) return null;
  pendingStatus.delete(server);
  lastFlush.delete(server);
  lastFlush.set(server, now);
  while (lastFlush.size > MAX_CACHE) {
    const first = lastFlush.keys().next();
    if (first.done) break;
    lastFlush.delete(first.value);
  }
  return db
    .prepare(
      `UPDATE server_feeds SET
         last_received_at     = COALESCE(?2, last_received_at),
         last_stored_at       = COALESCE(?3, last_stored_at),
         last_rejected_at     = COALESCE(?4, last_rejected_at),
         last_rejected_reason = CASE WHEN ?4 IS NULL THEN last_rejected_reason ELSE ?5 END,
         last_dropped_at      = COALESCE(?6, last_dropped_at),
         last_dropped_reason  = CASE WHEN ?6 IS NULL THEN last_dropped_reason ELSE ?7 END
       WHERE server_id = ?1`,
    )
    .bind(
      Number(server),
      p.received ?? null,
      p.stored ?? null,
      p.rejected?.at ?? null,
      p.rejected?.reason ?? null,
      p.dropped?.at ?? null,
      p.dropped?.reason ?? null,
    )
    .run()
    .then(() => undefined)
    .catch(() => undefined);
}

// ============================================================
// 受信(POST /api/ingest/events)
// ============================================================

/** 受信の結果の種類(ログ・テスト用。204 のもの) */
export type IngestResult = 'stored' | 'empty' | FeedDropReason;

/** 本文の event_count と「空のバッチか」。配列ならその長さ、events 配列を持つオブジェクトならその長さ、それ以外は null */
export function countEvents(value: unknown): { count: number | null; empty: boolean } {
  if (Array.isArray(value)) return { count: value.length, empty: value.length === 0 };
  if (isPlainObject(value) && Array.isArray(value.events)) return { count: value.events.length, empty: value.events.length === 0 };
  return { count: null, empty: false };
}

export interface IngestDeps {
  now?: number;
  /** 受信の状況の書き込み(応答の後で行う)。無ければ待たずに捨てる */
  waitUntil?: (p: Promise<unknown>) => void;
  /** ログ(テストで差し替える)。本文・トークンは渡さない */
  log?: (entry: { kind: 'ingest'; server: ServerId | null; result: string; bytes: number | null }) => void;
}

const defaultLog: NonNullable<IngestDeps['log']> = (e) => console.log(JSON.stringify(e));

function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/** 1 日の上限の判定と加算(1 文の UPSERT。行が返らなければ上限) */
async function takeDaily(db: D1Database, server: number, day: number, bytes: number, maxBatches: number, maxBytes: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO feed_daily (server_id, day, batches, bytes) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (server_id, day) DO UPDATE SET batches = batches + 1, bytes = bytes + excluded.bytes
        WHERE batches < ?4 AND bytes + excluded.bytes <= ?5
       RETURNING batches`,
    )
    .bind(server, day, bytes, maxBatches, maxBytes)
    .first<{ batches: number }>();
  return row !== null;
}

/**
 * POST /api/ingest/events の本体(middleware の D1 の判定の後。メソッドの判定はページ側)。
 * 応答は 204 か ApiFailure の JSON。docs/ARCHITECTURE.md 17.6 の 3〜12
 */
export async function handleIngest(db: D1Database, request: Request, deps: IngestDeps = {}): Promise<Response> {
  const now = deps.now ?? Date.now();
  const log = deps.log ?? defaultLog;
  const waitUntil = deps.waitUntil ?? ((p: Promise<unknown>) => void p.catch(() => undefined));
  let server: ServerId | null = null;
  let bytes: number | null = null;

  const finish = (result: string, response: Response): Response => {
    if (server !== null) {
      const flushing = flushStatus(db, server, now);
      if (flushing) waitUntil(flushing);
    }
    // 保存・空のバッチは毎回出さない(約 2 秒ごとに来るため)。拒否・捨てたものだけ出す
    if (result !== 'stored' && result !== 'empty') log({ kind: 'ingest', server, result, bytes });
    return response;
  };
  const reject = async (reason: FeedRejectReason, code: ApiErrorCode, opts: ErrorOptions = {}): Promise<Response> => {
    await discardBody(request, FEED_MAX_BODY_BYTES);
    if (server !== null) noteStatus(server, { rejected: { at: now, reason } });
    return finish(code, jsonError(code, opts));
  };

  // 3〜4. トークン(形式不正は D1 を読まない)
  const check = await verifyFeedToken(db, request.headers.get('Authorization'), now);
  if (!check.ok) {
    await discardBody(request, FEED_MAX_BODY_BYTES);
    const headers = { 'WWW-Authenticate': 'Bearer' };
    // 行があるのに一致しないときだけ受信の状況に残す(形式不正・行が無いものはどのサーバーのものか確定できない)
    if (check.rowExists && check.server !== null) {
      server = check.server;
      noteStatus(server, { rejected: { at: now, reason: 'token_invalid' } });
    }
    return finish('FEED_TOKEN_INVALID', jsonError('FEED_TOKEN_INVALID', { headers }));
  }
  server = check.server;

  // 5. レート制限(トークンの検証の後で数える)
  const wait = takeFeedRate(server, now);
  if (wait !== null) return reject('rate_limited', 'RATE_LIMITED', { retryAfterSec: wait });

  // 6. Content-Type
  const ct = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(ct)) return reject('content_type', 'UNSUPPORTED_MEDIA_TYPE');

  // 7. サイズ(Content-Length と実際に読んだ量の両方)
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > FEED_MAX_BODY_BYTES) return reject('too_large', 'PAYLOAD_TOO_LARGE');
  const read = await readLimited(request.body, FEED_MAX_BODY_BYTES);
  if (read === 'too_large') return reject('too_large', 'PAYLOAD_TOO_LARGE');
  if (read === 'error') return reject('bad_json', 'BAD_REQUEST');
  bytes = read.byteLength;

  // 8. UTF-8 の JSON
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read);
  } catch {
    return reject('bad_json', 'BAD_REQUEST');
  }
  noteStatus(server, { received: now });
  // 9. 空のバッチ(本文が空、[]、events が空配列)は D1 に書かない
  if (text.trim() === '') return finish('empty', noContent());
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return reject('bad_json', 'BAD_REQUEST');
  }
  const events = countEvents(value);
  if (events.empty) return finish('empty', noContent());

  // 10. 保存してよいか
  const drop = (reason: FeedDropReason): Response => {
    noteStatus(server as ServerId, { dropped: { at: now, reason } });
    return finish(reason, noContent());
  };
  if (!check.row.enabled) return drop('disabled');
  if (!check.row.serverUsable) return drop('server_unusable');

  // 11. 1 日の上限(サーバーごと → 全体。全体で断られた場合、サーバーの分は 1 件多く数えたまま残る)
  const day = utcDay(now);
  const sid = Number(server);
  try {
    if (!(await takeDaily(db, sid, day, bytes, FEED_DAILY_MAX_BATCHES, FEED_DAILY_MAX_BYTES))) return drop('daily_limit');
    if (!(await takeDaily(db, 0, day, bytes, FEED_GLOBAL_DAILY_MAX_BATCHES, FEED_GLOBAL_DAILY_MAX_BYTES))) return drop('global_limit');
    // 12. 保存(本文は受けた文字列のまま。受信時に記録中の試合を添える)
    await db
      .prepare(
        `INSERT INTO feed_raw_events (server_id, received_at, bytes, event_count, recording_id, body)
         VALUES (?1, ?2, ?3, ?4, (SELECT id FROM match_recordings WHERE server_id = ?1 AND status = 'recording'), ?5)`,
      )
      .bind(sid, now, bytes, events.count, text)
      .run();
  } catch {
    return finish('INTERNAL_ERROR', jsonError('INTERNAL_ERROR'));
  }
  noteStatus(server, { stored: now });
  return finish('stored', noContent());
}

// ============================================================
// 受信設定(GET / PUT /api/servers/:id/feed、POST / DELETE /api/servers/:id/feed-token)
// ============================================================

interface FeedRow {
  server_id: number;
  token_hint: string;
  token_created_at: number;
  enabled: number;
  last_received_at: number | null;
  last_stored_at: number | null;
  last_rejected_at: number | null;
  last_rejected_reason: string | null;
  last_dropped_at: number | null;
  last_dropped_reason: string | null;
}

const REJECT_SET: ReadonlySet<string> = new Set(FEED_REJECT_REASONS);
const DROP_SET: ReadonlySet<string> = new Set(FEED_DROP_REASONS);

function parseId(v: string | undefined): FeedOutcome<ServerId> {
  return typeof v === 'string' && SERVER_ID_PATTERN.test(v)
    ? { ok: true, data: v }
    : fail('VALIDATION_FAILED', { fields: { server: 'invalid_format' } });
}

async function serverRow(db: D1Database, id: ServerId): Promise<{ id: number; name: string } | null> {
  return db.prepare('SELECT id, name FROM servers WHERE id = ?1').bind(Number(id)).first<{ id: number; name: string }>();
}

async function feedRow(db: D1Database, id: ServerId): Promise<FeedRow | null> {
  return db
    .prepare(
      `SELECT server_id, token_hint, token_created_at, enabled, last_received_at, last_stored_at,
              last_rejected_at, last_rejected_reason, last_dropped_at, last_dropped_reason
         FROM server_feeds WHERE server_id = ?1`,
    )
    .bind(Number(id))
    .first<FeedRow>();
}

const nOrNull = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** ServerFeedStatus を組み立てる(トークンの値・ハッシュは含めない) */
export async function buildFeedStatus(db: D1Database, id: ServerId, now: number, row?: FeedRow | null): Promise<ServerFeedStatus> {
  const r = row === undefined ? await feedRow(db, id) : row;
  const today = await db
    .prepare('SELECT batches, bytes FROM feed_daily WHERE server_id = ?1 AND day = ?2')
    .bind(Number(id), utcDay(now))
    .first<{ batches: number; bytes: number }>();
  return {
    server: id,
    configured: r !== null,
    enabled: r !== null && Number(r.enabled) === 1,
    tokenHint: r?.token_hint ?? null,
    tokenCreatedAt: nOrNull(r?.token_created_at),
    lastReceivedAt: nOrNull(r?.last_received_at),
    lastStoredAt: nOrNull(r?.last_stored_at),
    lastRejectedAt: nOrNull(r?.last_rejected_at),
    lastRejectedReason: r?.last_rejected_reason && REJECT_SET.has(r.last_rejected_reason) ? (r.last_rejected_reason as FeedRejectReason) : null,
    lastDroppedAt: nOrNull(r?.last_dropped_at),
    lastDroppedReason: r?.last_dropped_reason && DROP_SET.has(r.last_dropped_reason) ? (r.last_dropped_reason as FeedDropReason) : null,
    // 受信が来ていない日(行が無い)は 0。トークン未発行でも今日の行は残り得るが、未発行なら 0 を返す(契約: today は 0)
    today: r !== null && today ? { batches: Number(today.batches), bytes: Number(today.bytes) } : { batches: 0, bytes: 0 },
    limits: {
      dailyBatches: FEED_DAILY_MAX_BATCHES,
      dailyBytes: FEED_DAILY_MAX_BYTES,
      globalDailyBatches: FEED_GLOBAL_DAILY_MAX_BATCHES,
      globalDailyBytes: FEED_GLOBAL_DAILY_MAX_BYTES,
      retentionDays: FEED_RETENTION_DAYS,
      maxBodyBytes: FEED_MAX_BODY_BYTES,
      ratePerMin: FEED_RATE_PER_MIN,
    },
    ingestPath: FEED_INGEST_PATH,
  };
}

export interface FeedMutationContext {
  db: D1Database;
  actor: AuditActor;
  now?: number;
}

function settingsLog(
  db: D1Database,
  a: AuditActor & { now: number; event: 'feed_token_issue' | 'feed_token_revoke' | 'feed_settings_update'; serverId: number; serverName: string; params: Record<string, unknown> },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings_audit_log (created_at, event, operator, session_tag, ip_hash, server_id, server_name, params_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(a.now, a.event, a.operator, a.sessionTag, a.ipHash, a.serverId, a.serverName, JSON.stringify(a.params));
}

/** GET /api/servers/:id/feed */
export async function getFeedStatus(db: D1Database, idParam: string | undefined, now = Date.now()): Promise<FeedOutcome<ServerFeedStatus>> {
  const id = parseId(idParam);
  if (!id.ok) return id;
  if (!(await serverRow(db, id.data))) return fail('SERVER_NOT_FOUND');
  return { ok: true, data: await buildFeedStatus(db, id.data, now) };
}

/** PUT /api/servers/:id/feed(本文 { enabled }) */
export async function updateFeedSettings(
  m: FeedMutationContext,
  idParam: string | undefined,
  body: unknown,
): Promise<FeedOutcome<ServerFeedStatus>> {
  const id = parseId(idParam);
  if (!id.ok) return id;
  const now = m.now ?? Date.now();
  const srv = await serverRow(m.db, id.data);
  if (!srv) return fail('SERVER_NOT_FOUND');
  if (!isPlainObject(body)) return fail('BAD_REQUEST');
  if (typeof body.enabled !== 'boolean') {
    const issue: ValidationIssue = body.enabled === undefined ? 'required' : 'invalid_format';
    return fail('VALIDATION_FAILED', { fields: { enabled: issue } });
  }
  const row = await feedRow(m.db, id.data);
  if (!row) return fail('NOT_FOUND');
  const enabled = body.enabled;
  if ((Number(row.enabled) === 1) !== enabled) {
    await m.db.batch([
      m.db.prepare('UPDATE server_feeds SET enabled = ?2, updated_at = ?3 WHERE server_id = ?1').bind(Number(id.data), enabled ? 1 : 0, now),
      settingsLog(m.db, { ...m.actor, now, event: 'feed_settings_update', serverId: srv.id, serverName: srv.name, params: { enabled } }),
    ]);
    invalidateFeedToken(id.data);
  }
  return { ok: true, data: await buildFeedStatus(m.db, id.data, now) };
}

/** POST /api/servers/:id/feed-token(発行・再発行。**token はこの応答でだけ返す**) */
export async function issueFeedToken(m: FeedMutationContext, idParam: string | undefined): Promise<FeedOutcome<FeedTokenResponse>> {
  const id = parseId(idParam);
  if (!id.ok) return id;
  const now = m.now ?? Date.now();
  const srv = await serverRow(m.db, id.data);
  if (!srv) return fail('SERVER_NOT_FOUND');
  const existing = await feedRow(m.db, id.data);
  const reissued = existing !== null;
  const token = generateFeedToken(id.data);
  const hash = await hashFeedToken(token);
  const hint = token.slice(-TOKEN_HINT_LENGTH);
  await m.db.batch([
    m.db
      .prepare(
        `INSERT INTO server_feeds (server_id, token_hash, token_hint, token_created_at, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?4, ?4)
         ON CONFLICT (server_id) DO UPDATE SET token_hash = excluded.token_hash, token_hint = excluded.token_hint,
           token_created_at = excluded.token_created_at, updated_at = excluded.updated_at`,
      )
      .bind(Number(id.data), hash, hint, now),
    // 値・ハッシュは params に入れない
    settingsLog(m.db, { ...m.actor, now, event: 'feed_token_issue', serverId: srv.id, serverName: srv.name, params: { reissued } }),
  ]);
  invalidateFeedToken(id.data);
  const status = await buildFeedStatus(m.db, id.data, now);
  return { ok: true, data: { token, tokenHint: hint, createdAt: now, reissued, status } };
}

/** DELETE /api/servers/:id/feed-token(本文 {}。未発行でも 200。行があったときだけ記録) */
export async function revokeFeedToken(m: FeedMutationContext, idParam: string | undefined): Promise<FeedOutcome<ServerFeedStatus>> {
  const id = parseId(idParam);
  if (!id.ok) return id;
  const now = m.now ?? Date.now();
  const srv = await serverRow(m.db, id.data);
  if (!srv) return fail('SERVER_NOT_FOUND');
  await m.db.batch([
    m.db
      .prepare(
        `INSERT INTO settings_audit_log (created_at, event, operator, session_tag, ip_hash, server_id, server_name, params_json)
         SELECT ?1, 'feed_token_revoke', ?2, ?3, ?4, ?5, ?6, '{}'
          WHERE EXISTS (SELECT 1 FROM server_feeds WHERE server_id = ?5)`,
      )
      .bind(now, m.actor.operator, m.actor.sessionTag, m.actor.ipHash, srv.id, srv.name),
    m.db.prepare('DELETE FROM server_feeds WHERE server_id = ?1').bind(srv.id),
  ]);
  invalidateFeedToken(id.data);
  return { ok: true, data: await buildFeedStatus(m.db, id.data, now, null) };
}

// ============================================================
// 生データの一覧(GET /api/feed/raw)
// ============================================================

export type FeedRawQuery = { ok: true; server: ServerId; limit: number; before: number | null } | { ok: false; fields: Record<string, ValidationIssue> };

export function parseFeedRawQuery(url: URL): FeedRawQuery {
  const fields: Record<string, ValidationIssue> = {};
  const ss = url.searchParams.get('server');
  const ls = url.searchParams.get('limit');
  const bs = url.searchParams.get('before');
  let limit = FEED_RAW_PAGE_DEFAULT;
  let before: number | null = null;
  if (ss === null || ss === '') fields.server = 'required';
  else if (!SERVER_ID_PATTERN.test(ss)) fields.server = 'invalid_format';
  if (ls !== null && ls !== '') {
    if (!/^\d{1,3}$/.test(ls) || Number(ls) < 1 || Number(ls) > FEED_RAW_PAGE_MAX) fields.limit = 'invalid_format';
    else limit = Number(ls);
  }
  if (bs !== null && bs !== '') {
    if (!/^\d{1,15}$/.test(bs)) fields.before = 'invalid_format';
    else before = Number(bs);
  }
  if (Object.keys(fields).length > 0 || ss === null) return { ok: false, fields };
  return { ok: true, server: ss, limit, before };
}

/** 新しい順。削除済みのサーバーの id でも 0 件で返す */
export async function listFeedRaw(db: D1Database, q: { server: ServerId; limit: number; before: number | null }): Promise<FeedRawResponse> {
  const sid = Number(q.server);
  const configured = (await db.prepare('SELECT 1 AS x FROM server_feeds WHERE server_id = ?1').bind(sid).first()) !== null;
  const args: unknown[] = [sid, q.limit + 1];
  let where = 'server_id = ?1';
  if (q.before !== null) {
    args.push(q.before);
    where += ' AND id < ?3';
  }
  const { results } = await db
    .prepare(`SELECT id, received_at, bytes, event_count, recording_id, body FROM feed_raw_events WHERE ${where} ORDER BY id DESC LIMIT ?2`)
    .bind(...args)
    .all<{ id: number; received_at: number; bytes: number; event_count: number | null; recording_id: number | null; body: string }>();
  const rows = results ?? [];
  const page = rows.slice(0, q.limit);
  const entries: FeedRawEntry[] = page.map((r) => ({
    id: Number(r.id),
    receivedAt: Number(r.received_at),
    bytes: Number(r.bytes),
    eventCount: nOrNull(r.event_count),
    matchId: r.recording_id === null ? null : String(r.recording_id),
    body: r.body,
  }));
  const last = entries[entries.length - 1];
  return { server: q.server, configured, entries, nextBefore: rows.length > q.limit && last ? last.id : null };
}
