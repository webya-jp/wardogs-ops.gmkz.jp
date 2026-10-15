// 複数サーバー: 登録サーバー(D1 servers)の一覧・解決・追加・変更・削除・接続テスト。
// docs/ARCHITECTURE.md 第 15 章、docs/API.md 1.2・7 章。D1・鍵・fetch は引数で受け取る(cloudflare:workers に依存させない)。
// - RCON パスワードは AES-256-GCM で暗号化して保存する(`v2.<iv>.<ct>`、鍵は instance_key から派生、AAD = 宛先)。平文・暗号文を応答・ログに出さない
// - サーバー設定は isolate 内にキャッシュしない(削除・無効化・パスワード変更を即時に効かせる)
// - 追加・変更・削除は D1 の変更と settings_audit_log の INSERT を 1 つの db.batch() で行う
// - 拒否(宛先変更時の再入力なし reenter_required、削除の表示名の不一致)と接続テストも settings_audit_log に 1 行残す
//   (QA 2026-10-16 M-2。形式不正・重複などの検証エラーは記録しない)
import {
  API_ERROR_CODES,
  MAX_SERVERS,
  SERVER_HOST_MAX_LENGTH,
  SERVER_ID_PATTERN,
  SERVER_NAME_MAX_LENGTH,
  SERVER_PASSWORD_MAX_LENGTH,
  SERVER_TEST_MIN_INTERVAL_SEC,
} from '../types/api';
import type {
  ApiErrorCode,
  DeleteServerResponse,
  ServerId,
  ServerLastTest,
  ServerMutationResponse,
  ServerSummary,
  ServerTestResult,
  SettingsEvent,
  ValidationIssue,
} from '../types/api';
import { RCON_PASSWORD_WARN_LENGTH } from '../types/env';
import { isSameAsAdminPassword } from './admins';
import type { AuditActor } from './audit';
import { codePointLength, parseRconUrl } from './config';
import type { RconConfig } from './config';
import { isPlainObject } from './http';
import type { ErrorOptions } from './http';
import { b64urlToBytes, bytesToB64url } from './keys';
import { invalidateCapabilities } from './rcon/capabilities';
import { rconRequest, READ_TIMEOUT_MS } from './rcon/client';
import type { ClientDeps } from './rcon/client';
import { normalizeStatus } from './rcon/normalize';
import { READ_ROUTES } from './rcon/routes';

// ============================================================
// 共通の型
// ============================================================

export interface ServerContext {
  /** D1(必須。D1 が使えないときはログインできないので、ここに来ない) */
  db: D1Database;
  /** RCON パスワードの暗号鍵(AES-256-GCM。instance_key から派生。keys.ts の serverPassword) */
  key: CryptoKey;
}

/** RCON を呼ぶために解決したサーバー(平文のパスワードを含む。外に出さない) */
export interface ResolvedServer {
  id: ServerId;
  /** audit_log.server_id の値(servers.id) */
  auditServerId: number;
  /** 操作時点の表示名 */
  name: string;
  rcon: RconConfig;
}

export type ServerOutcome<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; opts?: ErrorOptions };

const fail = (code: ApiErrorCode, opts?: ErrorOptions): ServerOutcome<never> => (opts ? { ok: false, code, opts } : { ok: false, code });
const invalid = (fields: Record<string, ValidationIssue>): ServerOutcome<never> => fail('VALIDATION_FAILED', { fields });

export function isServerId(v: unknown): v is ServerId {
  return typeof v === 'string' && SERVER_ID_PATTERN.test(v);
}

/** 本文・クエリの server の検証。未指定は required、形式不正は invalid_format */
export function parseServerParam(v: unknown): { ok: true; id: ServerId } | { ok: false; issue: ValidationIssue } {
  if (v === undefined || v === null || v === '') return { ok: false, issue: 'required' };
  return isServerId(v) ? { ok: true, id: v } : { ok: false, issue: 'invalid_format' };
}

// ============================================================
// 暗号化(AES-256-GCM)。ARCHITECTURE 15.3
// ============================================================

const enc = new TextEncoder();
const IV_BYTES = 12;
const ENC_RE = /^v2\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;

export interface Endpoint {
  scheme: string;
  host: string;
  port: number;
}

function aad(ep: Endpoint): Uint8Array<ArrayBuffer> {
  return enc.encode(`wardogs-ops/server-password/v2|${ep.scheme}://${ep.host}:${ep.port}`);
}

/** 平文を暗号化して `v2.<iv>.<ct>` を返す */
export async function encryptPassword(key: CryptoKey, ep: Endpoint, plaintext: string): Promise<string> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ep) }, key, enc.encode(plaintext)));
  return `v2.${bytesToB64url(iv)}.${bytesToB64url(ct)}`;
}

export type DecryptResult = { ok: true; plaintext: string } | { ok: false };

/**
 * 復号する。形式不正・認証失敗(鍵や宛先が違う。instance_key を手で消した・行を手で編集した場合)はすべて { ok: false }。
 * 失敗の理由は区別しない(画面は needsPassword として扱い、入れ直しで復旧する)
 */
export async function decryptPassword(key: CryptoKey, stored: string, ep: Endpoint): Promise<DecryptResult> {
  const m = ENC_RE.exec(stored);
  if (!m) return { ok: false };
  const iv = b64urlToBytes(m[1] ?? '');
  const ct = b64urlToBytes(m[2] ?? '');
  if (!iv || iv.byteLength !== IV_BYTES || !ct || ct.byteLength < 16) return { ok: false };
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: aad(ep) }, key, new Uint8Array(ct));
    return { ok: true, plaintext: new TextDecoder('utf-8', { fatal: true }).decode(pt) };
  } catch {
    return { ok: false };
  }
}

// ============================================================
// D1 の行と一覧
// ============================================================

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  scheme: string;
  rcon_password_enc: string;
  enabled: number;
  sort_order: number;
  last_test_at: number | null;
  last_test_result: string | null;
  created_at: number;
  updated_at: number;
}

const ROW_COLS = `id, name, host, port, scheme, rcon_password_enc, enabled, sort_order, last_test_at, last_test_result, created_at, updated_at`;

function endpointOf(row: Pick<ServerRow, 'scheme' | 'host' | 'port'>): Endpoint {
  return { scheme: row.scheme, host: row.host, port: Number(row.port) };
}

/** 宛先から baseUrl を作る(parseRconUrl と同じ正規化)。不正なら null */
export function baseUrlOf(ep: Endpoint): string | null {
  const r = parseRconUrl(`${ep.scheme}://${ep.host}:${ep.port}`);
  return r.ok ? r.baseUrl : null;
}

async function getRow(db: D1Database, id: number): Promise<ServerRow | null> {
  return db.prepare(`SELECT ${ROW_COLS} FROM servers WHERE id = ?1`).bind(id).first<ServerRow>();
}

const ERROR_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

function lastTestOf(at: number | null, result: string | null): ServerLastTest | null {
  if (at === null || result === null) return null;
  if (result === 'ok') return { at: Number(at), result: 'ok' };
  return ERROR_CODES.has(result) ? { at: Number(at), result: result as ApiErrorCode } : null;
}

/** テスト用 */
export function resetServersForTest(): void {
  testTimes.clear();
}

interface RowView {
  summary: ServerSummary;
  decrypted: DecryptResult;
}

async function viewRow(key: CryptoKey, row: ServerRow): Promise<RowView> {
  const decrypted = await decryptPassword(key, row.rcon_password_enc, endpointOf(row));
  const enabled = Number(row.enabled) === 1;
  const needsPassword = !decrypted.ok;
  return {
    decrypted,
    summary: {
      id: String(row.id),
      name: row.name,
      host: row.host,
      port: Number(row.port),
      enabled,
      sortOrder: Number(row.sort_order),
      needsPassword,
      passwordShort: decrypted.ok && codePointLength(decrypted.plaintext) < RCON_PASSWORD_WARN_LENGTH,
      usable: enabled && !needsPassword,
      lastTest: lastTestOf(row.last_test_at, row.last_test_result),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    },
  };
}

export interface ServerList {
  servers: ServerSummary[];
  /** 復号できない登録サーバーがある(SERVER_PASSWORDS_UNREADABLE) */
  unreadable: boolean;
}

/** 一覧: sort_order, id の順 */
export async function listServers(sctx: ServerContext): Promise<ServerList> {
  const out: ServerSummary[] = [];
  let unreadable = false;
  const { results } = await sctx.db.prepare(`SELECT ${ROW_COLS} FROM servers ORDER BY sort_order, id`).all<ServerRow>();
  for (const row of results ?? []) {
    const v = await viewRow(sctx.key, row);
    out.push(v.summary);
    if (!v.decrypted.ok) unreadable = true;
  }
  return { servers: out, unreadable };
}

/**
 * 登録サーバーの RCON パスワードを順に復号して返す(初期設定の登録し直しで、管理パスワードとの同一判定に使う。5.1.1)。
 * 復号できない行は飛ばす。平文はメモリ上だけで扱う
 */
export async function decryptAllPasswords(sctx: ServerContext): Promise<string[]> {
  const { results } = await sctx.db.prepare('SELECT scheme, host, port, rcon_password_enc FROM servers').all<ServerRow>();
  const out: string[] = [];
  for (const row of results ?? []) {
    const d = await decryptPassword(sctx.key, row.rcon_password_enc, endpointOf(row));
    if (d.ok) out.push(d.plaintext);
  }
  return out;
}

// ============================================================
// 解決(RCON を呼ぶ API の対象サーバー)。ARCHITECTURE 15.5・15.6
// ============================================================

/** 指定された id のサーバーを解決する(毎回 D1 から 1 行読み、復号する) */
export async function resolveServer(sctx: ServerContext, id: ServerId): Promise<ServerOutcome<ResolvedServer>> {
  if (!isServerId(id)) return invalid({ server: 'invalid_format' });
  const row = await getRow(sctx.db, Number(id));
  if (!row) return fail('SERVER_NOT_FOUND');
  if (Number(row.enabled) !== 1) return fail('SERVER_DISABLED');
  const ep = endpointOf(row);
  const baseUrl = baseUrlOf(ep);
  const d = await decryptPassword(sctx.key, row.rcon_password_enc, ep);
  if (!d.ok || !baseUrl) return fail('SERVER_NEEDS_PASSWORD');
  return { ok: true, data: { id, auditServerId: Number(row.id), name: row.name, rcon: { baseUrl, password: d.plaintext } } };
}

export interface Selection {
  /** 選ばれたサーバー(0 台、または指定されたものが無いときは null) */
  selected: ServerSummary | null;
  /** 指定(クエリ)されたのに無い・形式不正(ほかのサーバーに切り替えない) */
  notFound: boolean;
  /** クエリで決まった(ページは選択 Cookie を発行する) */
  fromQuery: boolean;
  /** Cookie が指す先が無い(ページは Cookie を消す) */
  staleCookie: boolean;
}

/**
 * ページ・API(server 省略時)でのサーバーの選び方(15.5):
 * 1. クエリ(指定されたのに無い・形式不正なら notFound。切り替えない)
 * 2. Cookie(指す先が無ければ無視)
 * 3. 表示順で最初の usable  4. 表示順の先頭
 */
export function selectServer(servers: ServerSummary[], query: string | null, cookie: string | null): Selection {
  if (query !== null) {
    const found = isServerId(query) ? servers.find((s) => s.id === query) : undefined;
    return { selected: found ?? null, notFound: !found, fromQuery: true, staleCookie: false };
  }
  let staleCookie = false;
  if (cookie !== null && cookie !== '') {
    const found = isServerId(cookie) ? servers.find((s) => s.id === cookie) : undefined;
    if (found) return { selected: found, notFound: false, fromQuery: false, staleCookie: false };
    staleCookie = true;
  }
  const selected = servers.find((s) => s.usable) ?? servers[0] ?? null;
  return { selected, notFound: false, fromQuery: false, staleCookie };
}

/**
 * 読み取り API の対象サーバー: クエリ `server` があればそれ(形式不正は 400、無ければ SERVER_* )。
 * 省略時は Cookie → 最初に使えるサーバー。0 台は NO_SERVERS
 */
export async function resolveServerForRead(
  sctx: ServerContext,
  query: string | null,
  cookie: string | null,
): Promise<ServerOutcome<ResolvedServer>> {
  if (query !== null && query !== '') {
    if (!isServerId(query)) return invalid({ server: 'invalid_format' });
    return resolveServer(sctx, query);
  }
  const { servers } = await listServers(sctx);
  const sel = selectServer(servers, null, cookie);
  if (!sel.selected) return fail('NO_SERVERS');
  return resolveServer(sctx, sel.selected.id);
}

// ============================================================
// 選択 Cookie(署名しない。値はサーバーの id だけ。15.5)
// ============================================================

export const SERVER_COOKIE_PROD = '__Host-wo_server';
export const SERVER_COOKIE_DEV = 'wo_server';
export const SERVER_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export function serverCookieName(dev: boolean): string {
  return dev ? SERVER_COOKIE_DEV : SERVER_COOKIE_PROD;
}

export function serializeServerCookie(id: ServerId, dev: boolean, maxAgeSec = SERVER_COOKIE_MAX_AGE_SEC): string {
  const attrs = [`${serverCookieName(dev)}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (!dev) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearServerCookie(dev: boolean): string {
  return serializeServerCookie('', dev, 0);
}

// ============================================================
// 入力の検証(15.2)
// ============================================================

type FieldResult<T> = { ok: true; value: T } | { ok: false; issue: ValidationIssue };

const CONTROL_RE = /[\p{Cc}\u2028\u2029]/u;
const HOST_FORBIDDEN_RE = /[\s/?#@:[\]\\]/u;
/** RCON パスワードは Authorization ヘッダに入れるため、表示可能な ASCII に限る(それ以外は fetch が失敗する) */
const PASSWORD_ALLOWED_RE = /^[\x20-\x7e]+$/;

export function validateServerName(v: unknown): FieldResult<string> {
  if (v === undefined || v === null) return { ok: false, issue: 'required' };
  if (typeof v !== 'string') return { ok: false, issue: 'invalid_format' };
  if (CONTROL_RE.test(v)) return { ok: false, issue: 'invalid_characters' };
  const s = v.trim();
  if (s === '') return { ok: false, issue: 'required' };
  if (codePointLength(s) > SERVER_NAME_MAX_LENGTH) return { ok: false, issue: 'too_long' };
  return { ok: true, value: s };
}

/** ホスト名だけを受け付ける(スキーム・ポート・パス・認証情報・IP アドレス不可)。正規化した hostname(punycode)を返す */
export function validateServerHost(v: unknown): FieldResult<string> {
  if (v === undefined || v === null) return { ok: false, issue: 'required' };
  if (typeof v !== 'string') return { ok: false, issue: 'invalid_format' };
  const h = v.trim().toLowerCase().replace(/\.$/, '');
  if (h === '') return { ok: false, issue: 'required' };
  if (codePointLength(h) > SERVER_HOST_MAX_LENGTH) return { ok: false, issue: 'too_long' };
  if (HOST_FORBIDDEN_RE.test(h) || CONTROL_RE.test(h)) return { ok: false, issue: 'invalid_format' };
  // parseRconUrl と同じ規則(ポートは結果に影響しないので固定値で組み立てる)
  const r = parseRconUrl(`http://${h}:1`);
  if (!r.ok) return { ok: false, issue: r.issue === 'RCON_URL_IS_IP_ADDRESS' ? 'ip_address' : 'invalid_format' };
  let hostname: string;
  try {
    hostname = new URL(`http://${h}`).hostname;
  } catch {
    return { ok: false, issue: 'invalid_format' };
  }
  if (hostname.length > SERVER_HOST_MAX_LENGTH) return { ok: false, issue: 'too_long' };
  return { ok: true, value: hostname };
}

export function validateServerPort(v: unknown): FieldResult<number> {
  if (v === undefined || v === null || v === '') return { ok: false, issue: 'required' };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, issue: 'invalid_format' };
  if (!Number.isInteger(v) || v < 1 || v > 65535) return { ok: false, issue: 'out_of_range' };
  return { ok: true, value: v };
}

/** RCON パスワードの形式(管理パスワードとの同一判定は D1 が要るので checkNotAdminPassword で別に行う) */
export function validateServerPassword(v: unknown): FieldResult<string> {
  if (v === undefined || v === null || v === '') return { ok: false, issue: 'required' };
  if (typeof v !== 'string') return { ok: false, issue: 'invalid_format' };
  if (codePointLength(v) > SERVER_PASSWORD_MAX_LENGTH) return { ok: false, issue: 'too_long' };
  if (!PASSWORD_ALLOWED_RE.test(v)) return { ok: false, issue: 'invalid_characters' };
  return { ok: true, value: v };
}

/**
 * 管理パスワードと同じなら same_as_admin_password(5.2。管理者のハッシュで検証。PBKDF2 1 回分 × 管理者の行数)。
 * ほかの項目の検証が通ってから呼ぶ(無駄な PBKDF2 を避ける)
 */
async function checkNotAdminPassword(db: D1Database, password: string): Promise<Record<string, ValidationIssue>> {
  return (await isSameAsAdminPassword(db, password)) ? { password: 'same_as_admin_password' } : {};
}

const SORT_ORDER_MIN = -1000;
const SORT_ORDER_MAX = 1000;

function validateSortOrder(v: unknown): FieldResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, issue: 'invalid_format' };
  if (!Number.isInteger(v) || v < SORT_ORDER_MIN || v > SORT_ORDER_MAX) return { ok: false, issue: 'out_of_range' };
  return { ok: true, value: v };
}

/** 表示名・宛先の重複(excludeId の行は除く) */
async function findDuplicates(
  db: D1Database,
  q: { name?: string; host?: string; port?: number; excludeId?: number },
): Promise<Record<string, ValidationIssue>> {
  const fields: Record<string, ValidationIssue> = {};
  const ex = q.excludeId ?? -1;
  if (q.name !== undefined) {
    const r = await db.prepare('SELECT id FROM servers WHERE name = ?1 AND id <> ?2 LIMIT 1').bind(q.name, ex).first();
    if (r) fields.name = 'duplicate';
  }
  if (q.host !== undefined && q.port !== undefined) {
    const r = await db
      .prepare(`SELECT id FROM servers WHERE scheme = 'http' AND host = ?1 AND port = ?2 AND id <> ?3 LIMIT 1`)
      .bind(q.host, q.port, ex)
      .first();
    if (r) fields.host = 'duplicate';
  }
  return fields;
}

function isUniqueError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message);
}

// ============================================================
// 変更ログ(settings_audit_log)
// ============================================================

/** settings_audit_log に 1 行書く文(event は契約の SettingsEvent。拒否・接続テストを含む。docs/API.md 3 章) */
function settingsLog(
  db: D1Database,
  e: AuditActor & { now: number; event: SettingsEvent; serverId: number; serverName: string; params: Record<string, unknown> },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings_audit_log (created_at, event, operator, session_tag, ip_hash, server_id, server_name, params_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(e.now, e.event, e.operator, e.sessionTag, e.ipHash, e.serverId, e.serverName, JSON.stringify(e.params));
}

// ============================================================
// 接続テスト(RCON GET /v1/status、5 秒)
// ============================================================

export async function runConnectionTest(rcon: RconConfig, deps: ClientDeps = {}, now = Date.now()): Promise<ServerTestResult> {
  const route = READ_ROUTES.status;
  const r = await rconRequest(rcon, { route, path: route.template, timeoutMs: READ_TIMEOUT_MS }, deps);
  const testedAt = now;
  const failed = (code: ApiErrorCode): ServerTestResult => ({
    ok: false,
    code,
    testedAt,
    serverName: null,
    players: { current: null, max: null },
  });
  if (!r.ok) {
    const out = failed(r.code);
    if (r.rconMessage !== undefined) out.rconMessage = r.rconMessage;
    if (r.retryAfterSec !== undefined) out.retryAfterSec = r.retryAfterSec;
    return out;
  }
  const status = normalizeStatus(r.data, testedAt);
  if (!status) return failed('RCON_BAD_RESPONSE');
  return { ok: true, code: null, testedAt, serverName: status.serverName, players: status.players };
}

function lastTestOfResult(t: ServerTestResult): ServerLastTest {
  return { at: t.testedAt, result: t.ok ? 'ok' : (t.code ?? 'INTERNAL_ERROR') };
}

function saveTestStmt(db: D1Database, id: ServerId, last: ServerLastTest): D1PreparedStatement {
  return db.prepare('UPDATE servers SET last_test_at = ?1, last_test_result = ?2 WHERE id = ?3').bind(last.at, last.result, Number(id));
}

async function saveTestResult(sctx: ServerContext, id: ServerId, t: ServerTestResult): Promise<ServerLastTest> {
  const last = lastTestOfResult(t);
  await saveTestStmt(sctx.db, id, last).run();
  return last;
}

/** 同じサーバーへの接続テストの最終時刻(isolate 内) */
const testTimes = new Map<ServerId, number>();

function takeTestSlot(id: ServerId, now: number): number | null {
  const last = testTimes.get(id);
  const minMs = SERVER_TEST_MIN_INTERVAL_SEC * 1000;
  if (last !== undefined && now - last < minMs) return Math.max(1, Math.ceil((minMs - (now - last)) / 1000));
  testTimes.delete(id);
  testTimes.set(id, now);
  while (testTimes.size > MAX_SERVERS * 4) {
    const first = testTimes.keys().next();
    if (first.done) break;
    testTimes.delete(first.value);
  }
  return null;
}

// ============================================================
// 追加・変更・削除・接続テスト(docs/API.md 7 章)
// ============================================================

export interface MutationContext {
  sctx: ServerContext;
  actor: AuditActor;
  deps?: ClientDeps;
  now?: number;
}

/** POST /api/servers */
export async function createServer(mctx: MutationContext, body: unknown): Promise<ServerOutcome<ServerMutationResponse>> {
  const { sctx } = mctx;
  const db = sctx.db;
  if (!isPlainObject(body)) return fail('BAD_REQUEST');
  const fields: Record<string, ValidationIssue> = {};
  const take = <T>(name: string, r: FieldResult<T>): T | undefined => {
    if (r.ok) return r.value;
    fields[name] = r.issue;
    return undefined;
  };
  const name = take('name', validateServerName(body.name));
  const host = take('host', validateServerHost(body.host));
  const port = take('port', validateServerPort(body.port));
  const password = take('password', validateServerPassword(body.password));
  if (name === undefined || host === undefined || port === undefined || password === undefined) return invalid(fields);
  const same = await checkNotAdminPassword(db, password);
  if (Object.keys(same).length > 0) return invalid(same);

  const dup = await findDuplicates(db, { name, host, port });
  if (Object.keys(dup).length > 0) return invalid(dup);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM servers').first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_SERVERS) return fail('SERVER_LIMIT_REACHED');

  const ep: Endpoint = { scheme: 'http', host, port };
  const encrypted = await encryptPassword(sctx.key, ep, password);
  const now = mctx.now ?? Date.now();
  const params = { name, host, port, enabled: true, passwordChanged: true };
  try {
    await db.batch([
      // 上限は INSERT の条件でも確かめる(同時に追加された場合)
      db
        .prepare(
          `INSERT INTO servers (name, host, port, scheme, rcon_password_enc, enabled, sort_order, created_at, updated_at)
           SELECT ?1, ?2, ?3, 'http', ?4, 1, 0, ?5, ?5
            WHERE (SELECT COUNT(*) FROM servers) < ?6`,
        )
        .bind(name, host, port, encrypted, now, MAX_SERVERS),
      db
        .prepare(
          `INSERT INTO settings_audit_log (created_at, event, operator, session_tag, ip_hash, server_id, server_name, params_json)
           SELECT ?1, 'server_add', ?2, ?3, ?4, id, name, ?5 FROM servers
            WHERE name = ?6 AND host = ?7 AND port = ?8 AND created_at = ?1`,
        )
        .bind(now, mctx.actor.operator, mctx.actor.sessionTag, mctx.actor.ipHash, JSON.stringify(params), name, host, port),
    ]);
  } catch (err) {
    if (isUniqueError(err)) {
      const again = await findDuplicates(db, { name, host, port });
      if (Object.keys(again).length > 0) return invalid(again);
    }
    throw err;
  }
  const row = await db
    .prepare(`SELECT ${ROW_COLS} FROM servers WHERE name = ?1 AND host = ?2 AND port = ?3 AND created_at = ?4`)
    .bind(name, host, port, now)
    .first<ServerRow>();
  if (!row) return fail('SERVER_LIMIT_REACHED');

  const id = String(row.id);
  const baseUrl = baseUrlOf(ep);
  if (!baseUrl) return fail('INTERNAL_ERROR');
  const test = await runConnectionTest({ baseUrl, password }, mctx.deps);
  await saveTestResult(sctx, id, test);
  const fresh = (await getRow(db, Number(row.id))) ?? row;
  return { ok: true, data: { server: (await viewRow(sctx.key, fresh)).summary, test } };
}

/** :id の解釈。形式不正は 400 */
function parseIdParam(v: string | undefined): ServerOutcome<ServerId> {
  return isServerId(v) ? { ok: true, data: v } : invalid({ server: 'invalid_format' });
}

/** PUT /api/servers/:id */
export async function updateServer(
  mctx: MutationContext,
  idParam: string | undefined,
  body: unknown,
): Promise<ServerOutcome<ServerMutationResponse>> {
  const idr = parseIdParam(idParam);
  if (!idr.ok) return idr;
  const { sctx } = mctx;
  const db = sctx.db;
  const row = await getRow(db, Number(idr.data));
  if (!row) return fail('SERVER_NOT_FOUND');
  if (!isPlainObject(body)) return fail('BAD_REQUEST');

  const fields: Record<string, ValidationIssue> = {};
  const take = <T>(name: string, r: FieldResult<T>): T | undefined => {
    if (r.ok) return r.value;
    fields[name] = r.issue;
    return undefined;
  };
  const name = body.name === undefined ? row.name : take('name', validateServerName(body.name));
  const host = body.host === undefined ? row.host : take('host', validateServerHost(body.host));
  const port = body.port === undefined ? Number(row.port) : take('port', validateServerPort(body.port));
  const pwGiven = body.password !== undefined && body.password !== null && body.password !== '';
  const password = pwGiven ? take('password', validateServerPassword(body.password)) : undefined;
  let enabled = Number(row.enabled) === 1;
  if (body.enabled !== undefined) {
    if (typeof body.enabled === 'boolean') enabled = body.enabled;
    else fields.enabled = 'invalid_format';
  }
  const sortOrder = body.sortOrder === undefined ? Number(row.sort_order) : take('sortOrder', validateSortOrder(body.sortOrder));

  const endpointChanged = (host !== undefined && host !== row.host) || (port !== undefined && port !== Number(row.port));
  // 宛先を変えるときは保存済みのパスワードを新しい宛先へ送らない(15.6)
  if (endpointChanged && !pwGiven && fields.host === undefined && fields.port === undefined) fields.password = 'reenter_required';
  if (Object.keys(fields).length > 0 || name === undefined || host === undefined || port === undefined || sortOrder === undefined) {
    // 宛先の書き換えによるパスワードの持ち出しの試行を残す(他の項目が正しく、reenter_required だけで拒否した場合。M-2)
    if (fields.password === 'reenter_required' && Object.keys(fields).length === 1 && host !== undefined && port !== undefined) {
      await recordRejection(mctx, row, 'server_update_rejected', { reason: 'reenter_required', host, port });
    }
    return invalid(fields);
  }
  if (password !== undefined) {
    const same = await checkNotAdminPassword(db, password);
    if (Object.keys(same).length > 0) return invalid(same);
  }

  const nameChanged = name !== row.name;
  const dup = await findDuplicates(db, {
    ...(nameChanged ? { name } : {}),
    ...(endpointChanged ? { host, port } : {}),
    excludeId: Number(row.id),
  });
  if (Object.keys(dup).length > 0) return invalid(dup);

  const wasEnabled = Number(row.enabled) === 1;
  const params: Record<string, unknown> = {};
  if (nameChanged) params.name = name;
  if (host !== row.host) params.host = host;
  if (port !== Number(row.port)) params.port = port;
  if (enabled !== wasEnabled) params.enabled = enabled;
  if (sortOrder !== Number(row.sort_order)) params.sortOrder = sortOrder;
  const passwordChanged = password !== undefined;

  if (Object.keys(params).length === 0 && !passwordChanged) {
    return { ok: true, data: { server: (await viewRow(sctx.key, row)).summary, test: null } };
  }
  params.passwordChanged = passwordChanged;

  const ep: Endpoint = { scheme: row.scheme, host, port };
  let encrypted = row.rcon_password_enc;
  if (password !== undefined) encrypted = await encryptPassword(sctx.key, ep, password);
  const now = mctx.now ?? Date.now();
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE servers SET name = ?1, host = ?2, port = ?3, rcon_password_enc = ?4, enabled = ?5, sort_order = ?6, updated_at = ?7
            WHERE id = ?8`,
        )
        .bind(name, host, port, encrypted, enabled ? 1 : 0, sortOrder, now, Number(row.id)),
      settingsLog(db, { ...mctx.actor, now, event: 'server_update', serverId: Number(row.id), serverName: name, params }),
    ]);
  } catch (err) {
    if (isUniqueError(err)) {
      const again = await findDuplicates(db, { name, host, port, excludeId: Number(row.id) });
      if (Object.keys(again).length > 0) return invalid(again);
    }
    throw err;
  }
  invalidateCapabilities(idr.data);

  let test: ServerTestResult | null = null;
  const connectionChanged = endpointChanged || passwordChanged || (enabled && !wasEnabled);
  if (connectionChanged) {
    const baseUrl = baseUrlOf(ep);
    const plain = password ?? (await decryptPassword(sctx.key, encrypted, ep));
    const pw = typeof plain === 'string' ? plain : plain.ok ? plain.plaintext : null;
    // 復号できない(needsPassword のまま有効にした)場合はテストしない
    if (baseUrl && pw !== null) {
      test = await runConnectionTest({ baseUrl, password: pw }, mctx.deps);
      await saveTestResult(sctx, idr.data, test);
    }
  }
  const fresh = (await getRow(db, Number(row.id))) ?? row;
  return { ok: true, data: { server: (await viewRow(sctx.key, fresh)).summary, test } };
}

/** 拒否を settings_audit_log に 1 行残す(記録の失敗で応答は変えない) */
async function recordRejection(
  mctx: MutationContext,
  row: ServerRow,
  event: 'server_update_rejected' | 'server_delete_rejected',
  params: Record<string, unknown>,
): Promise<void> {
  await settingsLog(mctx.sctx.db, {
    ...mctx.actor,
    now: mctx.now ?? Date.now(),
    event,
    serverId: Number(row.id),
    serverName: row.name,
    params,
  })
    .run()
    .catch(() => undefined);
}

/** DELETE /api/servers/:id */
export async function deleteServer(
  mctx: MutationContext,
  idParam: string | undefined,
  body: unknown,
): Promise<ServerOutcome<DeleteServerResponse>> {
  const idr = parseIdParam(idParam);
  if (!idr.ok) return idr;
  const db = mctx.sctx.db;
  const row = await getRow(db, Number(idr.data));
  if (!row) return fail('SERVER_NOT_FOUND');
  if (!isPlainObject(body)) return fail('BAD_REQUEST');
  const cn = body.confirmName;
  if (cn === undefined || cn === null || cn === '') return invalid({ confirmName: 'required' });
  if (typeof cn !== 'string' || cn !== row.name) {
    // 他のサーバーの削除の試行を残す(M-2)。入力された名前は残さない
    await recordRejection(mctx, row, 'server_delete_rejected', { reason: 'mismatch' });
    return invalid({ confirmName: 'mismatch' });
  }
  const now = mctx.now ?? Date.now();
  await db.batch([
    db.prepare('DELETE FROM servers WHERE id = ?1').bind(Number(row.id)),
    settingsLog(db, {
      ...mctx.actor,
      now,
      event: 'server_delete',
      serverId: Number(row.id),
      serverName: row.name,
      params: { name: row.name, host: row.host, port: Number(row.port) },
    }),
  ]);
  invalidateCapabilities(idr.data);
  testTimes.delete(idr.data);
  return { ok: true, data: { deletedId: idr.data } };
}

/**
 * POST /api/servers/:id/test(無効のサーバーもテストできる。同じサーバーは 5 秒に 1 回まで)。
 * 保存済みのパスワードを Bearer で外に送る操作なので、結果を settings_audit_log に server_test として残す(M-2)
 */
export async function testServer(mctx: MutationContext, idParam: string | undefined): Promise<ServerOutcome<ServerMutationResponse>> {
  const idr = parseIdParam(idParam);
  if (!idr.ok) return idr;
  const id = idr.data;
  const { sctx } = mctx;
  const row = await getRow(sctx.db, Number(id));
  if (!row) return fail('SERVER_NOT_FOUND');
  const ep = endpointOf(row);
  const d = await decryptPassword(sctx.key, row.rcon_password_enc, ep);
  const baseUrl = baseUrlOf(ep);
  if (!d.ok || !baseUrl) return fail('SERVER_NEEDS_PASSWORD');
  const now = mctx.now ?? Date.now();
  const wait = takeTestSlot(id, now);
  if (wait !== null) return fail('RATE_LIMITED', { retryAfterSec: wait });
  invalidateCapabilities(id);
  const test = await runConnectionTest({ baseUrl, password: d.plaintext }, mctx.deps);
  const last = lastTestOfResult(test);
  await sctx.db.batch([
    saveTestStmt(sctx.db, id, last),
    settingsLog(sctx.db, {
      ...mctx.actor,
      now: test.testedAt,
      event: 'server_test',
      serverId: Number(row.id),
      serverName: row.name,
      params: { result: last.result },
    }),
  ]);
  const fresh = (await getRow(sctx.db, Number(id))) ?? row;
  return { ok: true, data: { server: (await viewRow(sctx.key, fresh)).summary, test } };
}
