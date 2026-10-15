// 初期設定(handleSetup)・管理者の登録(admins.ts)・ログイン(handleLogin)の単体テスト。D1 は node:sqlite で 0001 + 0002 を適用したもの。
// パスワードはテスト用の固定文字列だけを使う。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PASSWORD_HASH_ITERATIONS, PASSWORD_HASH_ITERATIONS_MIN } from '../types/env';
import { getPrimaryAdmin, hasAdmin, isSameAsAdminPassword, registerAdmin } from './admins';
import { listSettingsAudit } from './audit';
import { handleLogin, handleSetup } from './auth';
import { getKeys, resetKeysCacheForTest } from './keys';
import { parsePasswordHash } from './password';
import { createServer, resetServersForTest } from './servers';
import { verifySession } from './session';
import { MemoryThrottleStore, LoginThrottle } from './throttle';
import { makeD1 } from './testing/sqlite-d1';

const ADMIN_PW = 'admin-password-for-tests-0123';
const RCON_PW = 'rcon-password-for-tests-0123456789';
const form = (o: Record<string, string>) => new URLSearchParams(o);
const setupForm = (pw = ADMIN_PW, confirm = pw) => form({ password: pw, passwordConfirm: confirm });

beforeEach(() => {
  resetKeysCacheForTest();
  resetServersForTest();
});

async function setup(db: D1Database, f: URLSearchParams | null, now = 1_000) {
  return handleSetup({ db, getKeys: () => getKeys(db), form: f, ip: '203.0.113.5', now, iterations: PASSWORD_HASH_ITERATIONS_MIN });
}

describe('初期設定(/setup の POST)', () => {
  it('登録: admins に PBKDF2 のハッシュ、settings に instance_key、settings_audit_log に admin_register', async () => {
    const db = await makeD1();
    expect(await hasAdmin(db)).toBe(false);
    expect(await setup(db, setupForm())).toEqual({ kind: 'registered' });
    expect(await hasAdmin(db)).toBe(true);
    const admin = (await getPrimaryAdmin(db))!;
    expect(admin.password_hash.startsWith('pbkdf2-sha256$')).toBe(true);
    expect(admin.password_hash).not.toContain(ADMIN_PW);
    expect(admin.session_stamp).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'instance_key'`).first()).toEqual({ n: 1 });
    const log = await listSettingsAudit(db, { limit: 10, before: null });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ event: 'admin_register', operator: null, sessionTag: null, serverId: null, params: {}, status: 'succeeded' });
    const raw = await db.prepare('SELECT ip_hash FROM settings_audit_log').first<{ ip_hash: string }>();
    expect(raw?.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(await db.prepare('SELECT * FROM settings_audit_log').all())).not.toContain(ADMIN_PW);
  });

  it('入力検証: 短い・長い・確認不一致・フォーム不正(前後の空白は除かない)', async () => {
    const db = await makeD1();
    expect(await setup(db, setupForm('x'.repeat(15)))).toEqual({ kind: 'error', code: 'PASSWORD_TOO_SHORT' });
    expect(await setup(db, setupForm(''))).toEqual({ kind: 'error', code: 'PASSWORD_TOO_SHORT' });
    expect(await setup(db, setupForm('x'.repeat(257)))).toEqual({ kind: 'error', code: 'PASSWORD_TOO_LONG' });
    expect(await setup(db, setupForm(ADMIN_PW, `${ADMIN_PW} `))).toEqual({ kind: 'error', code: 'PASSWORD_MISMATCH' });
    expect(await setup(db, null)).toEqual({ kind: 'error', code: 'BAD_REQUEST' });
    // 16 文字ちょうど・コードポイント単位
    expect(await setup(db, setupForm('あ'.repeat(16)))).toEqual({ kind: 'registered' });
    expect(await hasAdmin(db)).toBe(true);
  });

  it('登録済みなら SETUP_ALREADY_DONE(2 回目の送信)', async () => {
    const db = await makeD1();
    expect(await setup(db, setupForm())).toEqual({ kind: 'registered' });
    expect(await setup(db, setupForm('another-password-0123'))).toEqual({ kind: 'error', code: 'SETUP_ALREADY_DONE' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM admins').first()).toEqual({ n: 1 });
  });

  it('並行した登録は 1 本だけ成功し、2 本目は SETUP_ALREADY_DONE(条件付き INSERT の変更行数 0)', async () => {
    const db = await makeD1();
    const [a, b] = await Promise.all([
      registerAdmin(db, { password: ADMIN_PW, iterations: PASSWORD_HASH_ITERATIONS_MIN }),
      registerAdmin(db, { password: 'other-password-0123456', iterations: PASSWORD_HASH_ITERATIONS_MIN }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['already_done', 'registered']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM admins').first()).toEqual({ n: 1 });
    // handleSetup 経由でも同じ(先に hasAdmin で止まらないよう、2 本を同時に走らせる)
    const db2 = await makeD1();
    const results = await Promise.all([setup(db2, setupForm()), setup(db2, setupForm('other-password-0123456'))]);
    expect(results.filter((r) => r.kind === 'registered')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'error' && r.code === 'SETUP_ALREADY_DONE')).toHaveLength(1);
    expect(await db2.prepare('SELECT COUNT(*) AS n FROM admins').first()).toEqual({ n: 1 });
  });

  it('登録し直し(admins を消した後)では登録サーバーの RCON パスワードと同じ値を拒否する。instance_key は変わらない', async () => {
    const db = await makeD1();
    await setup(db, setupForm());
    const keys = await getKeys(db);
    const actor = { operator: null, sessionTag: null, ipHash: null };
    const okFetch = async () => Response.json({ serverName: 'x', players: { current: 0, max: 1 } });
    const r = await createServer({ sctx: { db, key: keys.serverPassword }, actor, deps: { fetchFn: okFetch, log: () => undefined } }, {
      name: 'A',
      host: 'rcon-a.example.com',
      port: 7777,
      password: RCON_PW,
    });
    expect(r.ok).toBe(true);
    const ik = await db.prepare(`SELECT value FROM settings`).first();
    await db.prepare('DELETE FROM admins').run();
    expect(await setup(db, setupForm(RCON_PW))).toEqual({ kind: 'error', code: 'PASSWORD_SAME_AS_RCON' });
    expect(await setup(db, setupForm('new-admin-password-0123'))).toEqual({ kind: 'registered' });
    expect(await db.prepare(`SELECT value FROM settings`).first()).toEqual(ik);
  });
});

describe('管理パスワードとの同一判定(サーバー保存時)', () => {
  it('管理者のハッシュで検証する', async () => {
    const db = await makeD1();
    expect(await isSameAsAdminPassword(db, ADMIN_PW)).toBe(false);
    await registerAdmin(db, { password: ADMIN_PW, iterations: PASSWORD_HASH_ITERATIONS_MIN });
    expect(await isSameAsAdminPassword(db, ADMIN_PW)).toBe(true);
    expect(await isSameAsAdminPassword(db, `${ADMIN_PW}x`)).toBe(false);
  });
});

describe('ログイン', () => {
  const noSleep = async () => undefined;

  async function login(db: D1Database, pw: string, extra: { now?: number; throttle?: LoginThrottle } = {}) {
    const tasks: Promise<unknown>[] = [];
    const r = await handleLogin({
      db,
      keys: await getKeys(db),
      form: form({ password: pw, operator: ' 運営A ' }),
      ip: '203.0.113.5',
      dev: true,
      waitUntil: (p) => tasks.push(p),
      sleep: noSleep,
      throttle: extra.throttle ?? new LoginThrottle({ db, memory: new MemoryThrottleStore() }),
      ...(extra.now === undefined ? {} : { now: extra.now }),
    });
    await Promise.all(tasks);
    return r;
  }

  it('管理者が未登録なら setup_required', async () => {
    const db = await makeD1();
    expect(await login(db, ADMIN_PW)).toEqual({ kind: 'setup_required' });
  });

  it('成功: Cookie(aid と session_stamp に結び付く)を発行し、audit_log に login', async () => {
    const db = await makeD1();
    await registerAdmin(db, { password: ADMIN_PW });
    const now = Date.now();
    const r = await login(db, ADMIN_PW, { now });
    if (r.kind !== 'success') throw new Error(`login failed: ${r.kind}`);
    expect(r.setCookie.startsWith('wo_session=v2.1.')).toBe(true);
    const value = r.setCookie.split(';')[0]!.split('=')[1]!;
    const keys = await getKeys(db);
    const lookup = async (aid: number) => db.prepare('SELECT id, session_stamp FROM admins WHERE id = ?1').bind(aid).first<{ id: number; session_stamp: string }>();
    expect(await verifySession(keys.session, value, lookup, now)).toMatchObject({ aid: 1, operator: '運営A' });
    expect(await db.prepare('SELECT event, status FROM audit_log').all().then((x) => x.results)).toEqual([{ event: 'login', status: 'succeeded' }]);
  });

  it('失敗・ロック(5 回まで評価、6 回目は評価しない)。失敗は audit_log に書かない', async () => {
    const db = await makeD1();
    await registerAdmin(db, { password: ADMIN_PW, iterations: PASSWORD_HASH_ITERATIONS_MIN });
    const throttle = new LoginThrottle({ db, memory: new MemoryThrottleStore() });
    for (let i = 0; i < 5; i++) expect(await login(db, 'wrong-password-xxxxxxx', { throttle })).toEqual({ kind: 'failed' });
    expect(await login(db, ADMIN_PW, { throttle })).toMatchObject({ kind: 'locked' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first()).toEqual({ n: 0 });
  });

  it('保存値の反復回数が古ければ成功時に保存し直す(session_stamp は変えない)', async () => {
    const db = await makeD1();
    await registerAdmin(db, { password: ADMIN_PW, iterations: PASSWORD_HASH_ITERATIONS_MIN });
    const before = (await getPrimaryAdmin(db))!;
    expect((await login(db, ADMIN_PW)).kind).toBe('success');
    const after = (await getPrimaryAdmin(db))!;
    expect(parsePasswordHash(after.password_hash)?.iterations).toBe(PASSWORD_HASH_ITERATIONS);
    expect(after.session_stamp).toBe(before.session_stamp);
    expect((await login(db, ADMIN_PW)).kind).toBe('success');
  });

  it('保存値が壊れていればログインできず、コードだけをログに出す', async () => {
    const db = await makeD1();
    await db.prepare(`INSERT INTO admins (password_hash, session_stamp, created_at, updated_at) VALUES ('broken', 's', 0, 0)`).run();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await login(db, ADMIN_PW)).toEqual({ kind: 'failed' });
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('PASSWORD_HASH_INVALID');
    expect(logged).not.toContain(ADMIN_PW);
    err.mockRestore();
  });
});
