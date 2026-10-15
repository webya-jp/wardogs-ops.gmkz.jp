// 初期設定(管理パスワードの登録)・ログイン・ログアウトの処理本体。docs/ARCHITECTURE.md 4.1・5.1.1・5.2・5.6、docs/API.md 2 章。
// D1 の判定・Origin 検査・管理者の有無による誘導は middleware が先に行う。D1・鍵は引数で受け取る。
// パスワード・ハッシュ・Cookie の値・生の IP をログや戻り値に出さない。
import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH } from '../types/api';
import type { SetupFormError } from '../types/api';
import { getPrimaryAdmin, hasAdmin, recordAdminRegister, registerAdmin, rehashAdminPassword } from './admins';
import { cleanupOldRows, recordSessionEvent } from './audit';
import { codePointLength } from './config';
import { hashClientIp } from './keys';
import type { DerivedKeys } from './keys';
import { verifyPasswordHash } from './password';
import { issueSession, sanitizeOperator, serializeSessionCookie, toSessionInfo } from './session';
import type { SessionData } from './session';
import { LoginThrottle, throttleKeyForIp } from './throttle';

/** 失敗時に応答を遅らせる時間(CPU 時間には数えられない) */
export const LOGIN_FAILURE_DELAY_MS = 300;

// ============================================================
// 初期設定(POST /setup)
// ============================================================

export type SetupResult = { kind: 'registered' } | { kind: 'error'; code: SetupFormError };

export interface SetupInput {
  db: D1Database;
  /** 鍵を用意する関数(instance_key が無ければ作る。keys.ts の getKeys) */
  getKeys: () => Promise<DerivedKeys>;
  /** フォームの内容(読めなければ null) */
  form: URLSearchParams | null;
  ip: string;
  now?: number;
  /** テスト用(PBKDF2 の反復回数) */
  iterations?: number;
  /** 記録(admin_register)を応答後に回す。無ければその場で待つ */
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * 判定の順序(docs/API.md 2 章): 管理者の有無 → 入力検証 → instance_key → 条件付き INSERT。
 * 登録サーバーの RCON パスワードとの同一判定は行わない(QA 2026-10-16 setup M-3: 管理者 0 件・サーバー登録ありの間、
 * 未認証者に「入力値が保存済みの RCON パスワードと同じか」を教えてしまうため。同一値の拒否はログイン後のサーバー保存時
 * 〔same_as_admin_password〕だけで行う)。PASSWORD_SAME_AS_RCON は契約に残るが、ここでは返さない。
 * 成功時は settings_audit_log に admin_register を記録する(記録の失敗で登録は取り消さない)。自動ログインはしない
 */
export async function handleSetup(input: SetupInput): Promise<SetupResult> {
  const { db, form } = input;
  const err = (code: SetupFormError): SetupResult => ({ kind: 'error', code });
  if (await hasAdmin(db)) return err('SETUP_ALREADY_DONE');
  if (!form) return err('BAD_REQUEST');
  const password = form.get('password') ?? '';
  const confirm = form.get('passwordConfirm') ?? '';
  const len = codePointLength(password);
  if (len < ADMIN_PASSWORD_MIN_LENGTH) return err('PASSWORD_TOO_SHORT');
  if (len > ADMIN_PASSWORD_MAX_LENGTH) return err('PASSWORD_TOO_LONG');
  if (password !== confirm) return err('PASSWORD_MISMATCH');

  // instance_key を用意する(無ければここで作られる。登録の記録の ip_hash に使う)
  const keys = await input.getKeys();

  const now = input.now ?? Date.now();
  const r = await registerAdmin(db, { password, now, ...(input.iterations === undefined ? {} : { iterations: input.iterations }) });
  if (r.kind === 'already_done') return err('SETUP_ALREADY_DONE');

  const record = (async () => {
    try {
      await recordAdminRegister(db, { now, ipHash: await hashClientIp(keys, input.ip) });
    } catch {
      console.error(JSON.stringify({ kind: 'setup-audit-failed', code: 'ADMIN_REGISTER_LOG_FAILED' }));
    }
  })();
  if (input.waitUntil) input.waitUntil(record);
  else await record;
  return { kind: 'registered' };
}

// ============================================================
// ログイン(POST /login)
// ============================================================

export type LoginResult =
  | { kind: 'success'; setCookie: string; session: SessionData }
  | { kind: 'failed' }
  | { kind: 'locked'; minutes: number }
  | { kind: 'bad_request' }
  /** 管理者が未登録(/setup へ誘導する) */
  | { kind: 'setup_required' };

export interface LoginInput {
  db: D1Database;
  keys: DerivedKeys;
  /** フォームの内容(読めなければ null) */
  form: URLSearchParams | null;
  ip: string;
  dev: boolean;
  waitUntil: (p: Promise<unknown>) => void;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
  throttle?: LoginThrottle;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function handleLogin(input: LoginInput): Promise<LoginResult> {
  const { keys, form, db } = input;
  if (!form) return { kind: 'bad_request' };
  const admin = await getPrimaryAdmin(db);
  if (!admin) return { kind: 'setup_required' };
  const now = input.now ?? Date.now();
  const sleep = input.sleep ?? defaultSleep;

  const ipHash = await hashClientIp(keys, input.ip);
  const ipKey = throttleKeyForIp(ipHash);
  const throttle = input.throttle ?? new LoginThrottle({ db });

  // 評価の前に試行を加算する(並行リクエストでも上限を超えて評価しない。ロック中は PBKDF2 も使わない。5.6)
  const lock = await throttle.acquire(ipKey, now);
  if (lock.locked) return { kind: 'locked', minutes: Math.max(1, Math.ceil(lock.retryAfterMs / 60_000)) };

  const password = form.get('password') ?? '';
  const v = await verifyPasswordHash(password, admin.password_hash);
  if (!v.ok) {
    // 保存値の破損はコードだけを出す(値は出さない。復旧は README の登録し直し)
    if (v.invalidHash) console.error(JSON.stringify({ kind: 'login-error', code: 'PASSWORD_HASH_INVALID' }));
    // ログイン失敗は audit_log に書かない(throttle と LOGIN_FAILURES_HIGH の警告に任せる。D1 の書き込み枠の節約)
    await throttle.recordFailure(now);
    await sleep(LOGIN_FAILURE_DELAY_MS);
    return { kind: 'failed' };
  }

  await throttle.recordSuccess(ipKey);
  const { value, data } = await issueSession(keys.session, admin, { operator: sanitizeOperator(form.get('operator')), now });
  const info = toSessionInfo(data);
  input.waitUntil(
    (async () => {
      // 反復回数が古ければ保存し直す(session_stamp は変えない)
      if (v.needsRehash) await rehashAdminPassword(db, admin, password, now).catch(() => undefined);
      await recordSessionEvent(db, { event: 'login', now, operator: info.operator, sessionTag: info.sessionTag, ipHash });
      await cleanupOldRows(db, now);
    })(),
  );
  return { kind: 'success', setCookie: serializeSessionCookie(value, input.dev), session: data };
}

export async function recordLogout(input: {
  keys: DerivedKeys;
  db: D1Database;
  session: SessionData | null;
  ip: string;
  now?: number;
}): Promise<void> {
  if (!input.session) return;
  const info = toSessionInfo(input.session);
  await recordSessionEvent(input.db, {
    event: 'logout',
    now: input.now ?? Date.now(),
    operator: info.operator,
    sessionTag: info.sessionTag,
    ipHash: await hashClientIp(input.keys, input.ip),
  });
}
