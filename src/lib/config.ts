// Secrets の検証、SetupWarning、Features(段階的有効化)の判定。docs/ARCHITECTURE.md 5.1・5.2・5.7・6.1・7.4。
// env は引数で受け取る(cloudflare:workers に依存させない)。値そのものは返さない・ログに出さない。
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  RCON_PASSWORD_WARN_LENGTH,
  REQUIRED_SECRETS,
  SESSION_SECRET_MIN_LENGTH,
} from '../types/env';
import type { OpsEnv, RequiredSecretName } from '../types/env';
import type { Features, SetupWarning } from '../types/api';

/** ログインを止める(/setup に誘導する)警告 */
const BLOCKING: ReadonlySet<SetupWarning> = new Set<SetupWarning>([
  'ADMIN_PASSWORD_MISSING',
  'ADMIN_PASSWORD_TOO_SHORT',
  'ADMIN_PASSWORD_EQUALS_RCON_PASSWORD',
  'RCON_URL_MISSING',
  'RCON_URL_INVALID',
  'RCON_URL_IS_IP_ADDRESS',
  'RCON_URL_HAS_CREDENTIALS',
  'RCON_PASSWORD_MISSING',
  'SESSION_SECRET_TOO_SHORT',
]);

export function isBlockingWarning(w: SetupWarning): boolean {
  return BLOCKING.has(w);
}

export type RconUrlResult = { ok: true; baseUrl: string } | { ok: false; warning: SetupWarning };

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * RCON_URL を検証し、`/v1/...` を後ろに付けられる基点(末尾の / なし)を返す。
 * 失敗しても値は返さない。
 */
export function parseRconUrl(value: string | undefined): RconUrlResult {
  const raw = (value ?? '').trim();
  if (raw === '') return { ok: false, warning: 'RCON_URL_MISSING' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, warning: 'RCON_URL_INVALID' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, warning: 'RCON_URL_INVALID' };
  if (url.username !== '' || url.password !== '') return { ok: false, warning: 'RCON_URL_HAS_CREDENTIALS' };
  if (url.search !== '' || url.hash !== '' || url.hostname === '') return { ok: false, warning: 'RCON_URL_INVALID' };
  // WHATWG URL は 16 進・8 進・10 進 1 語の IPv4 表記もドット区切りに正規化するので、正規化後に判定する
  const host = url.hostname;
  if (host.startsWith('[') || IPV4_RE.test(host)) return { ok: false, warning: 'RCON_URL_IS_IP_ADDRESS' };
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.protocol}//${url.host}${path}` };
}

export interface ConfigCheck {
  /** 必須 Secrets が揃い、ログインを受け付けられる */
  ok: boolean;
  /** 未設定の必須 Secrets の名前 */
  missing: RequiredSecretName[];
  /** 設定に関する警告(D1 の警告は含まない。features と合わせて getWarnings で作る) */
  warnings: SetupWarning[];
}

function codePointLength(s: string): number {
  return Array.from(s).length;
}

export function checkConfig(env: OpsEnv): ConfigCheck {
  const missing: RequiredSecretName[] = [];
  const warnings: SetupWarning[] = [];
  for (const name of REQUIRED_SECRETS) {
    if ((env[name] ?? '') === '') missing.push(name);
  }

  const admin = env.ADMIN_PASSWORD ?? '';
  const rconPw = env.RCON_PASSWORD ?? '';
  if (admin === '') warnings.push('ADMIN_PASSWORD_MISSING');
  else if (codePointLength(admin) < ADMIN_PASSWORD_MIN_LENGTH) warnings.push('ADMIN_PASSWORD_TOO_SHORT');

  const url = parseRconUrl(env.RCON_URL);
  if (!url.ok) warnings.push(url.warning);

  if (rconPw === '') warnings.push('RCON_PASSWORD_MISSING');
  else if (codePointLength(rconPw) < RCON_PASSWORD_WARN_LENGTH) warnings.push('RCON_PASSWORD_SHORT');

  if (admin !== '' && rconPw !== '' && admin === rconPw) warnings.push('ADMIN_PASSWORD_EQUALS_RCON_PASSWORD');

  const ss = env.SESSION_SECRET ?? '';
  if (ss !== '' && codePointLength(ss) < SESSION_SECRET_MIN_LENGTH) warnings.push('SESSION_SECRET_TOO_SHORT');

  return { ok: !warnings.some(isBlockingWarning), missing, warnings };
}

export interface RconConfig {
  baseUrl: string;
  password: string;
}

/** checkConfig が ok のときだけ使う。不正なら null */
export function getRconConfig(env: OpsEnv): RconConfig | null {
  const url = parseRconUrl(env.RCON_URL);
  const password = env.RCON_PASSWORD ?? '';
  if (!url.ok || password === '') return null;
  return { baseUrl: url.baseUrl, password };
}

/** AUDIT_REQUIRED は "false" のときだけ偽(未設定・その他は真) */
export function auditRequired(env: OpsEnv): boolean {
  return (env.AUDIT_REQUIRED ?? '').trim().toLowerCase() !== 'false';
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

export async function probeD1(db: D1Database | undefined, now = Date.now()): Promise<D1State> {
  if (!db) return 'missing';
  if (d1Cache && d1Cache.db === db && now - d1Cache.at < D1_CACHE_MS) return d1Cache.state;
  let state: D1State;
  try {
    await db.prepare('SELECT 1 FROM audit_log LIMIT 1').first();
    // login_throttle / status_snapshots も同じマイグレーションで作られる(0001_init.sql)
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
  /** D1 が使えるときだけ非 null */
  db: D1Database | null;
}

export async function getFeatures(env: OpsEnv, now = Date.now()): Promise<FeatureState> {
  const d1 = await probeD1(env.DB, now);
  const audit = d1 === 'ok';
  return {
    features: { audit, snapshots: audit, writes: audit || !auditRequired(env) },
    d1,
    db: audit && env.DB ? env.DB : null,
  };
}

/** 画面上部・/api/session に出す警告(設定の警告 + D1 の状態) */
export function collectWarnings(config: ConfigCheck, state: FeatureState): SetupWarning[] {
  const out = [...config.warnings];
  if (state.d1 === 'missing') out.push('D1_MISSING');
  if (state.d1 === 'not_migrated') out.push('D1_NOT_MIGRATED');
  if (!state.features.audit && state.features.writes) out.push('AUDIT_DISABLED_WRITES_ALLOWED');
  return out;
}
