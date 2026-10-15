// D1 の判定、SetupWarning、Features(段階的有効化)、RCON の接続先の検証。docs/ARCHITECTURE.md 5.1.1・6.1・7.4・15.8。
// Worker Secrets は使わない(2026-10-16)。D1 は必須で、D1 が無い・マイグレーション未適用ならログインできない。
// vars AUDIT_REQUIRED は読まない(@deprecated)。env は引数で受け取る(cloudflare:workers に依存させない)。値そのものはログに出さない。
import type { OpsEnv } from '../types/env';
import type { Features, SetupWarning } from '../types/api';

/** parseRconUrl の失敗理由(内部の判定値。SetupWarning からは 2026-10-16 に外した) */
export type RconUrlIssue = 'RCON_URL_MISSING' | 'RCON_URL_INVALID' | 'RCON_URL_IS_IP_ADDRESS' | 'RCON_URL_HAS_CREDENTIALS';

export type RconUrlResult = { ok: true; baseUrl: string } | { ok: false; issue: RconUrlIssue };

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * RCON の接続先(http://<ホスト名>:<ポート>)を検証し、`/v1/...` を後ろに付けられる基点(末尾の / なし)を返す。
 * 画面から登録するサーバーの「ホスト名 + ポート」の検証に使う(15.2)。失敗しても値は返さない
 */
export function parseRconUrl(value: string | undefined): RconUrlResult {
  const raw = (value ?? '').trim();
  if (raw === '') return { ok: false, issue: 'RCON_URL_MISSING' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, issue: 'RCON_URL_INVALID' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, issue: 'RCON_URL_INVALID' };
  if (url.username !== '' || url.password !== '') return { ok: false, issue: 'RCON_URL_HAS_CREDENTIALS' };
  if (url.search !== '' || url.hash !== '' || url.hostname === '') return { ok: false, issue: 'RCON_URL_INVALID' };
  // WHATWG URL は 16 進・8 進・10 進 1 語の IPv4 表記もドット区切りに正規化するので、正規化後に判定する
  const host = url.hostname;
  if (host.startsWith('[') || IPV4_RE.test(host)) return { ok: false, issue: 'RCON_URL_IS_IP_ADDRESS' };
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${path}` };
}

export function codePointLength(s: string): number {
  return Array.from(s).length;
}

export interface RconConfig {
  baseUrl: string;
  password: string;
}

// ------------------------------------------------------------
// D1 の可否(isolate 内で 5 分キャッシュ)
// ------------------------------------------------------------

export type D1State = 'ok' | 'missing' | 'not_migrated';

const D1_CACHE_MS = 5 * 60 * 1000;
let d1Cache: { db: D1Database; state: D1State; at: number } | null = null;

/** テスト用 */
export function resetD1Cache(): void {
  d1Cache = null;
}

/** 失敗(D1 の例外)を受けたときに次回は再判定させる */
export function invalidateD1Cache(): void {
  d1Cache = null;
}

/**
 * 最新のマイグレーション(0002)で作った表・列をすべて参照する 1 文。どれかが無ければ失敗する(15.8)。
 * 0001 の login_throttle も参照する
 */
const PROBE_SQL = `SELECT
  (SELECT server_id FROM audit_log LIMIT 1) AS a,
  (SELECT server_name FROM audit_log LIMIT 1) AS b,
  (SELECT 1 FROM servers LIMIT 1) AS c,
  (SELECT 1 FROM server_snapshots LIMIT 1) AS d,
  (SELECT 1 FROM settings_audit_log LIMIT 1) AS e,
  (SELECT 1 FROM login_throttle LIMIT 1) AS f,
  (SELECT session_stamp FROM admins LIMIT 1) AS g,
  (SELECT value FROM settings LIMIT 1) AS h`;

export async function probeD1(db: D1Database | undefined, now = Date.now()): Promise<D1State> {
  if (!db) return 'missing';
  if (d1Cache && d1Cache.db === db && now - d1Cache.at < D1_CACHE_MS) return d1Cache.state;
  let state: D1State;
  try {
    await db.prepare(PROBE_SQL).first();
    state = 'ok';
  } catch {
    state = 'not_migrated';
  }
  d1Cache = { db, state, at: now };
  return state;
}

export interface FeatureState {
  features: Features;
  d1: D1State;
  /** D1 が使える(最新のマイグレーションまで適用済み)ときだけ非 null */
  db: D1Database | null;
}

/** D1 が使えればすべて true(D1 必須化。7.4)。AUDIT_REQUIRED は読まない */
export async function getFeatures(env: OpsEnv, now = Date.now()): Promise<FeatureState> {
  const d1 = await probeD1(env.DB, now);
  const ok = d1 === 'ok';
  return {
    features: { audit: ok, snapshots: ok, writes: ok },
    d1,
    db: ok && env.DB ? env.DB : null,
  };
}

/** /setup に出す D1 の不備(使えるなら null) */
export function d1Warning(d1: D1State): SetupWarning | null {
  if (d1 === 'missing') return 'D1_MISSING';
  if (d1 === 'not_migrated') return 'D1_NOT_MIGRATED';
  return null;
}

/**
 * 画面上部・/api/session に出す警告の初期値。ログイン後に入り得るのは SERVER_PASSWORDS_UNREADABLE と
 * LOGIN_FAILURES_HIGH(throttle.ts の withLoginAlert が足す)だけ
 */
export function collectWarnings(serverPasswordsUnreadable = false): SetupWarning[] {
  return serverPasswordsUnreadable ? ['SERVER_PASSWORDS_UNREADABLE'] : [];
}
