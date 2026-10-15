// ログイン・ログアウトの処理本体。docs/ARCHITECTURE.md 4.1・5 章、docs/API.md 2 章。
// Origin 検査・設定チェックは middleware が先に行う。env・D1 は引数で受け取る。
// パスワード・Cookie の値・生の IP をログや戻り値に出さない。
import type { OpsEnv } from '../types/env';
import { cleanupOldRows, recordSessionEvent } from './audit';
import { checkConfig } from './config';
import { hashClientIp } from './keys';
import type { DerivedKeys } from './keys';
import { verifyPassword } from './password';
import { issueSession, sanitizeOperator, serializeSessionCookie, toSessionInfo } from './session';
import type { SessionData } from './session';
import { LoginThrottle, throttleKeyForIp } from './throttle';

/** 失敗時に応答を遅らせる時間(CPU 時間には数えられない) */
export const LOGIN_FAILURE_DELAY_MS = 300;

export type LoginResult =
  | { kind: 'success'; setCookie: string; session: SessionData }
  | { kind: 'failed' }
  | { kind: 'locked'; minutes: number }
  | { kind: 'bad_request' }
  | { kind: 'not_configured' };

export interface LoginInput {
  env: OpsEnv;
  keys: DerivedKeys;
  /** フォームの内容(読めなければ null) */
  form: URLSearchParams | null;
  ip: string;
  /** D1 が使えるときだけ非 null */
  db: D1Database | null;
  dev: boolean;
  waitUntil: (p: Promise<unknown>) => void;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
  throttle?: LoginThrottle;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function handleLogin(input: LoginInput): Promise<LoginResult> {
  const { env, keys, form, db } = input;
  if (!checkConfig(env).ok) return { kind: 'not_configured' };
  if (!form) return { kind: 'bad_request' };
  const now = input.now ?? Date.now();
  const sleep = input.sleep ?? defaultSleep;

  const ipHash = await hashClientIp(keys, input.ip);
  const ipKey = throttleKeyForIp(ipHash);
  const throttle = input.throttle ?? new LoginThrottle({ db });

  // 評価の前に試行を加算する(並行リクエストでも上限を超えて評価しない。docs/ARCHITECTURE.md 5.6)
  const lock = await throttle.acquire(ipKey, now);
  if (lock.locked) return { kind: 'locked', minutes: Math.max(1, Math.ceil(lock.retryAfterMs / 60_000)) };

  const password = form.get('password') ?? '';
  const ok = password !== '' && (await verifyPassword(keys.passwordCompare, password, env.ADMIN_PASSWORD ?? ''));
  if (!ok) {
    // ログイン失敗は audit_log に書かない(throttle と LOGIN_FAILURES_HIGH の警告に任せる。D1 の書き込み枠の節約)
    await throttle.recordFailure(now);
    await sleep(LOGIN_FAILURE_DELAY_MS);
    return { kind: 'failed' };
  }

  await throttle.recordSuccess(ipKey);
  const { value, data } = await issueSession(keys.session, { operator: sanitizeOperator(form.get('operator')), now });
  if (db) {
    const info = toSessionInfo(data);
    input.waitUntil(
      (async () => {
        await recordSessionEvent(db, { event: 'login', now, operator: info.operator, sessionTag: info.sessionTag, ipHash });
        await cleanupOldRows(db, now);
      })(),
    );
  }
  return { kind: 'success', setCookie: serializeSessionCookie(value, input.dev), session: data };
}

export async function recordLogout(input: {
  keys: DerivedKeys;
  db: D1Database | null;
  session: SessionData | null;
  ip: string;
  now?: number;
}): Promise<void> {
  if (!input.db || !input.session) return;
  const info = toSessionInfo(input.session);
  await recordSessionEvent(input.db, {
    event: 'logout',
    now: input.now ?? Date.now(),
    operator: info.operator,
    sessionTag: info.sessionTag,
    ipHash: await hashClientIp(input.keys, input.ip),
  });
}
