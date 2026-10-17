// 複数サーバー(src/lib/servers.ts)の単体テスト。D1 は node:sqlite で 0001 + 0002 を適用したもの。
// ホスト名・パスワードはダミー(example.com / localhost と固定文字列)だけを使う。
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SERVERS } from '../types/api';
import { PASSWORD_HASH_ITERATIONS_MIN } from '../types/env';
import { registerAdmin } from './admins';
import { listSettingsAudit } from './audit';
import type { FetchFn } from './rcon/client';
import { resetCapabilitiesForTest } from './rcon/capabilities';
import {
  createServer,
  decryptPassword,
  deleteServer,
  encryptPassword,
  listServers,
  resetServersForTest,
  resolveServer,
  resolveServerForRead,
  selectServer,
  testServer,
  updateServer,
  validateServerHost,
  validateServerPort,
} from './servers';
import type { MutationContext, ServerContext } from './servers';
import { testKeys } from './testing/keys';
import { makeD1 } from './testing/sqlite-d1';

const ADMIN = 'admin-password-for-tests-01';
const PW = 'rcon-password-for-tests-0123456789';
const EP = { scheme: 'http', host: 'rcon-a.example.com', port: 7777 };

const okFetch: FetchFn = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/v1/status') return Response.json({ serverName: `Mock ${u.port}`, players: { current: 3, max: 16 } });
  return new Response('{}', { status: 404 });
};
const deps = { fetchFn: okFetch, log: () => undefined };

/** D1 に管理者を 1 人登録した状態の ServerContext(seed は instance_key の代わり) */
async function sctxOf(o: { db?: D1Database; seed?: number } = {}): Promise<ServerContext> {
  const db = o.db ?? (await makeD1());
  if (!o.db) await registerAdmin(db, { password: ADMIN, iterations: PASSWORD_HASH_ITERATIONS_MIN });
  return { db, key: (await testKeys(o.seed ?? 1)).serverPassword };
}

function mctxOf(sctx: ServerContext, now?: number): MutationContext {
  return { sctx, actor: { operator: 'tester', sessionTag: 'AAAAAAAA', ipHash: null }, deps, ...(now === undefined ? {} : { now }) };
}

const body = (o: Record<string, unknown> = {}) => ({ name: 'Server A', host: 'rcon-a.example.com', port: 7777, password: PW, ...o });

const settingsRows = async (db: D1Database) =>
  (await db.prepare('SELECT event, server_id, params_json FROM settings_audit_log ORDER BY id').all()).results as {
    event: string;
    server_id: number | null;
    params_json: string;
  }[];

beforeEach(() => {
  resetServersForTest();
  resetCapabilitiesForTest();
});

describe('暗号化(AES-256-GCM、v2)', () => {
  it('往復でき、暗号文に平文を含まない。形式は v2.<iv>.<ct>', async () => {
    const key = (await testKeys()).serverPassword;
    const enc = await encryptPassword(key, EP, PW);
    expect(enc).toMatch(/^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(enc).not.toContain(PW);
    expect(await decryptPassword(key, enc, EP)).toEqual({ ok: true, plaintext: PW });
    // IV は毎回変わる
    expect(await encryptPassword(key, EP, PW)).not.toBe(enc);
  });

  it('AAD(宛先)が違えば復号できない(暗号文を別の行にコピーしても使えない)。鍵が違っても復号できない', async () => {
    const key = (await testKeys()).serverPassword;
    const enc = await encryptPassword(key, EP, PW);
    expect(await decryptPassword(key, enc, { ...EP, port: 7778 })).toEqual({ ok: false });
    expect(await decryptPassword(key, enc, { ...EP, host: 'rcon-b.example.com' })).toEqual({ ok: false });
    expect(await decryptPassword(key, enc, { ...EP, scheme: 'https' })).toEqual({ ok: false });
    expect(await decryptPassword((await testKeys(2)).serverPassword, enc, EP)).toEqual({ ok: false });
    // 旧形式(v1.<k>.<iv>.<ct>)・形式不正は読まない
    expect(await decryptPassword(key, enc.replace(/^v2\./, 'v1.s.'), EP)).toEqual({ ok: false });
    expect(await decryptPassword(key, 'v2.x.y', EP)).toEqual({ ok: false });
    expect(await decryptPassword(key, '', EP)).toEqual({ ok: false });
  });
});

describe('入力の検証', () => {
  it('ホスト名: 小文字化・末尾の . を除く・IP 不可・URL やポートの貼り付け不可', () => {
    expect(validateServerHost(' RCON-A.Example.com. ')).toEqual({ ok: true, value: 'rcon-a.example.com' });
    expect(validateServerHost('localhost')).toEqual({ ok: true, value: 'localhost' });
    expect(validateServerHost('192.0.2.10')).toEqual({ ok: false, issue: 'ip_address' });
    expect(validateServerHost('3221225994')).toEqual({ ok: false, issue: 'ip_address' });
    expect(validateServerHost('::1')).toEqual({ ok: false, issue: 'invalid_format' });
    expect(validateServerHost('http://rcon-a.example.com')).toEqual({ ok: false, issue: 'invalid_format' });
    expect(validateServerHost('rcon-a.example.com:7777')).toEqual({ ok: false, issue: 'invalid_format' });
    expect(validateServerHost('u@rcon-a.example.com')).toEqual({ ok: false, issue: 'invalid_format' });
    expect(validateServerHost('a b.example.com')).toEqual({ ok: false, issue: 'invalid_format' });
    expect(validateServerHost('')).toEqual({ ok: false, issue: 'required' });
    expect(validateServerHost(`${'a'.repeat(250)}.com`)).toEqual({ ok: false, issue: 'too_long' });
    // 国際化ドメイン名は punycode で保存する
    expect(validateServerHost('例え.example')).toMatchObject({ ok: true, value: expect.stringMatching(/^xn--/) });
  });

  it('ポート: 1〜65535 の整数', () => {
    expect(validateServerPort(7777)).toEqual({ ok: true, value: 7777 });
    expect(validateServerPort(0)).toEqual({ ok: false, issue: 'out_of_range' });
    expect(validateServerPort(65536)).toEqual({ ok: false, issue: 'out_of_range' });
    expect(validateServerPort(1.5)).toEqual({ ok: false, issue: 'out_of_range' });
    expect(validateServerPort('7777')).toEqual({ ok: false, issue: 'invalid_format' });
    expect(validateServerPort(undefined)).toEqual({ ok: false, issue: 'required' });
  });

  it('追加: 項目ごとの検証、管理パスワード(D1 admins のハッシュ)と同じパスワード、重複。検証エラーは記録しない', async () => {
    const sctx = await sctxOf();
    const m = mctxOf(sctx);
    expect(await createServer(m, { name: ' ', host: '192.0.2.1', port: 0, password: '' })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      opts: { fields: { name: 'required', host: 'ip_address', port: 'out_of_range', password: 'required' } },
    });
    expect(await createServer(m, body({ password: ADMIN }))).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      opts: { fields: { password: 'same_as_admin_password' } },
    });
    expect(await createServer(m, body({ name: 'a\nb' }))).toMatchObject({ opts: { fields: { name: 'invalid_characters' } } });
    expect(await createServer(m, body({ name: 'x'.repeat(33) }))).toMatchObject({ opts: { fields: { name: 'too_long' } } });
    expect((await createServer(m, body())).ok).toBe(true);
    expect(await createServer(m, body({ host: 'rcon-b.example.com' }))).toMatchObject({ opts: { fields: { name: 'duplicate' } } });
    expect(await createServer(m, body({ name: 'Server B', host: 'RCON-A.example.com' }))).toMatchObject({ opts: { fields: { host: 'duplicate' } } });
    // 同じホスト名でもポートが違えば別サーバー
    expect((await createServer(m, body({ name: 'Server B', port: 7778 }))).ok).toBe(true);
    expect((await settingsRows(sctx.db)).map((r) => r.event)).toEqual(['server_add', 'server_add']);
  });
});

describe('追加・一覧・解決', () => {
  it('追加すると暗号化して保存し、接続テストの結果を返す。応答・一覧にパスワード・暗号文を含めない', async () => {
    const sctx = await sctxOf();
    const r = await createServer(mctxOf(sctx), body());
    if (!r.ok) throw new Error('create failed');
    expect(r.data.test).toMatchObject({ ok: true, code: null, serverName: 'Mock 7777', players: { current: 3, max: 16 } });
    expect(r.data.server).toMatchObject({
      id: '1',
      name: 'Server A',
      host: 'rcon-a.example.com',
      port: 7777,
      enabled: true,
      needsPassword: false,
      passwordShort: false,
      usable: true,
      lastTest: { result: 'ok' },
    });
    expect(r.data.server).not.toHaveProperty('source');
    expect(r.data.server).not.toHaveProperty('secretsIssue');
    expect(JSON.stringify(r.data)).not.toContain(PW);
    expect(JSON.stringify(r.data)).not.toContain('v2.');
    const stored = await sctx.db.prepare('SELECT rcon_password_enc AS e FROM servers').first<{ e: string }>();
    expect(stored?.e.startsWith('v2.')).toBe(true);
    expect(stored?.e).not.toContain(PW);
    const log = await listSettingsAudit(sctx.db, { limit: 10, before: null });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ event: 'server_add', serverId: '1', serverName: 'Server A', status: 'succeeded', operator: 'tester' });
    expect(log.entries[0]?.params).toEqual({ name: 'Server A', host: 'rcon-a.example.com', port: 7777, enabled: true, passwordChanged: true });
    expect(JSON.stringify(log)).not.toContain(PW);

    expect(await resolveServer(sctx, '1')).toEqual({
      ok: true,
      data: { id: '1', auditServerId: 1, name: 'Server A', rcon: { baseUrl: 'http://rcon-a.example.com:7777', password: PW }, scoreCap: null },
    });
  });

  it('接続テストに失敗しても保存する(test.ok: false、一覧の lastTest に残る)', async () => {
    const sctx = await sctxOf();
    const authFail: FetchFn = async () => new Response('{}', { status: 401 });
    const r = await createServer({ ...mctxOf(sctx), deps: { fetchFn: authFail, log: () => undefined } }, body());
    expect(r).toMatchObject({ ok: true, data: { test: { ok: false, code: 'RCON_AUTH_FAILED' }, server: { lastTest: { result: 'RCON_AUTH_FAILED' } } } });
    expect((await listServers(sctx)).servers).toHaveLength(1);
  });

  it(`上限は ${MAX_SERVERS} 台`, async () => {
    const sctx = await sctxOf();
    const m = mctxOf(sctx);
    for (let i = 0; i < MAX_SERVERS; i++) {
      const r = await createServer(m, body({ name: `S${i}`, port: 7000 + i }));
      expect(r.ok).toBe(true);
    }
    expect(await createServer(m, body({ name: 'over', port: 9999 }))).toEqual({ ok: false, code: 'SERVER_LIMIT_REACHED' });
    expect((await listServers(sctx)).servers).toHaveLength(MAX_SERVERS);
  });

  it('既定サーバー(default)は無い: 形式不正。0 台で server 省略は NO_SERVERS', async () => {
    const sctx = await sctxOf();
    expect(await resolveServer(sctx, 'default')).toEqual({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { server: 'invalid_format' } } });
    expect(await resolveServer(sctx, '1')).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    expect(await listServers(sctx)).toEqual({ servers: [], unreadable: false });
    expect(await resolveServerForRead(sctx, null, null)).toEqual({ ok: false, code: 'NO_SERVERS' });
    expect(await resolveServerForRead(sctx, 'default', null)).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      opts: { fields: { server: 'invalid_format' } },
    });
  });

  it('needsPassword: 鍵(instance_key)が変わると復号できず 409 SERVER_NEEDS_PASSWORD。パスワードの入れ直しで解消', async () => {
    const before = await sctxOf();
    await createServer(mctxOf(before), body());
    const after = await sctxOf({ db: before.db, seed: 2 });
    const list = await listServers(after);
    expect(list.unreadable).toBe(true);
    expect(list.servers[0]).toMatchObject({ needsPassword: true, usable: false, passwordShort: false });
    expect(await resolveServer(after, '1')).toEqual({ ok: false, code: 'SERVER_NEEDS_PASSWORD' });
    expect(await testServer(mctxOf(after), '1')).toEqual({ ok: false, code: 'SERVER_NEEDS_PASSWORD' });
    const fixed = await updateServer(mctxOf(after), '1', { password: PW });
    expect(fixed).toMatchObject({ ok: true, data: { server: { needsPassword: false, usable: true }, test: { ok: true } } });
    expect((await listServers(after)).unreadable).toBe(false);
  });
});

describe('変更・削除・接続テスト', () => {
  it('宛先を変えるときはパスワードの再入力が必須(reenter_required)。拒否は settings_audit_log に残す。変更なしは何もしない', async () => {
    const sctx = await sctxOf();
    const m = mctxOf(sctx);
    await createServer(m, body());
    expect(await updateServer(m, '1', { port: 7778 })).toEqual({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { password: 'reenter_required' } } });
    expect(await updateServer(m, '1', { host: 'rcon-b.example.com', password: '' })).toMatchObject({ opts: { fields: { password: 'reenter_required' } } });
    // 他の項目にも誤りがある場合は検証エラーとして扱い、記録しない
    expect(await updateServer(m, '1', { port: 7778, name: '' })).toMatchObject({ opts: { fields: { password: 'reenter_required', name: 'required' } } });
    // 同じ値は変更とみなさない
    expect(await updateServer(m, '1', { name: 'Server A', port: 7777 })).toMatchObject({ ok: true, data: { test: null } });
    // 管理パスワードと同じ値は保存しない(記録もしない)
    expect(await updateServer(m, '1', { password: ADMIN })).toMatchObject({ opts: { fields: { password: 'same_as_admin_password' } } });
    const rows = await settingsRows(sctx.db);
    expect(rows.map((r) => [r.event, r.server_id])).toEqual([
      ['server_add', 1],
      ['server_update_rejected', 1],
      ['server_update_rejected', 1],
    ]);
    expect(JSON.parse(rows[1]!.params_json)).toEqual({ reason: 'reenter_required', host: 'rcon-a.example.com', port: 7778 });
    expect(JSON.parse(rows[2]!.params_json)).toEqual({ reason: 'reenter_required', host: 'rcon-b.example.com', port: 7777 });
    // API(/api/audit?kind=settings)では event をそのまま、status=failed・errorCode=VALIDATION_FAILED で返す
    const api = await listSettingsAudit(sctx.db, { limit: 10, before: null });
    expect(api.entries.map((e) => [e.event, e.status, e.errorCode])).toEqual([
      ['server_update_rejected', 'failed', 'VALIDATION_FAILED'],
      ['server_update_rejected', 'failed', 'VALIDATION_FAILED'],
      ['server_add', 'succeeded', null],
    ]);
    const moved = await updateServer(m, '1', { port: 7778, password: PW });
    expect(moved).toMatchObject({ ok: true, data: { server: { port: 7778 }, test: { ok: true, serverName: 'Mock 7778' } } });
    expect(await resolveServer(sctx, '1')).toMatchObject({ ok: true, data: { rcon: { baseUrl: 'http://rcon-a.example.com:7778' } } });
    const log = await listSettingsAudit(sctx.db, { limit: 10, before: null, server: '1' });
    expect(log.entries[0]).toMatchObject({ event: 'server_update', status: 'succeeded', params: { port: 7778, passwordChanged: true } });
    expect(JSON.stringify(await settingsRows(sctx.db))).not.toContain(PW);
  });

  it('無効化・並び順。無効なら SERVER_DISABLED、範囲外の並び順は out_of_range', async () => {
    const sctx = await sctxOf();
    const m = mctxOf(sctx);
    await createServer(m, body());
    expect(await updateServer(m, '1', { sortOrder: 1001 })).toMatchObject({ opts: { fields: { sortOrder: 'out_of_range' } } });
    expect(await updateServer(m, '1', { enabled: 'no' })).toMatchObject({ opts: { fields: { enabled: 'invalid_format' } } });
    expect(await updateServer(m, '1', { enabled: false, sortOrder: -5 })).toMatchObject({
      ok: true,
      data: { server: { enabled: false, usable: false, sortOrder: -5 }, test: null },
    });
    expect(await resolveServer(sctx, '1')).toEqual({ ok: false, code: 'SERVER_DISABLED' });
    // 無効でも接続テストはできる
    expect(await testServer(mctxOf(sctx), '1')).toMatchObject({ ok: true, data: { test: { ok: true } } });
    // 有効に戻すと接続テストをする
    expect(await updateServer(m, '1', { enabled: true })).toMatchObject({ ok: true, data: { test: { ok: true } } });
  });

  it('id の形式不正(default を含む)は 400、無い id は 404', async () => {
    const m = mctxOf(await sctxOf());
    const bad = { ok: false, code: 'VALIDATION_FAILED', opts: { fields: { server: 'invalid_format' } } };
    expect(await updateServer(m, 'default', { name: 'x' })).toEqual(bad);
    expect(await deleteServer(m, 'default', { confirmName: 'x' })).toEqual(bad);
    expect(await testServer(m, 'default')).toEqual(bad);
    expect(await updateServer(m, '0', {})).toEqual(bad);
    expect(await updateServer(m, '5', {})).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    expect(await testServer(m, '5')).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
  });

  it('削除は表示名の一致が必要。不一致は記録する(入力した名前は残さない)。変更ログは残り、id は再利用しない', async () => {
    const sctx = await sctxOf();
    const m = mctxOf(sctx);
    await createServer(m, body());
    expect(await deleteServer(m, '1', {})).toMatchObject({ opts: { fields: { confirmName: 'required' } } });
    expect(await deleteServer(m, '1', { confirmName: 'server a' })).toMatchObject({ opts: { fields: { confirmName: 'mismatch' } } });
    expect(await deleteServer(m, '1', { confirmName: 'Server A' })).toEqual({ ok: true, data: { deletedId: '1' } });
    expect(await resolveServer(sctx, '1')).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    const again = await createServer(m, body());
    expect(again).toMatchObject({ ok: true, data: { server: { id: '2' } } });
    const rows = await settingsRows(sctx.db);
    expect(rows.map((r) => r.event)).toEqual(['server_add', 'server_delete_rejected', 'server_delete', 'server_add']);
    expect(JSON.parse(rows[1]!.params_json)).toEqual({ reason: 'mismatch' });
    expect(rows[1]!.params_json).not.toContain('server a');
    const log = await listSettingsAudit(sctx.db, { limit: 10, before: null });
    expect(log.entries.map((e) => [e.event, e.serverId, e.status])).toEqual([
      ['server_add', '2', 'succeeded'],
      ['server_delete', '1', 'succeeded'],
      ['server_delete_rejected', '1', 'failed'],
      ['server_add', '1', 'succeeded'],
    ]);
    expect(log.entries[1]?.params).toEqual({ name: 'Server A', host: 'rcon-a.example.com', port: 7777 });
  });

  it('接続テストは同じサーバーに 5 秒に 1 回まで。結果は servers と settings_audit_log(server_test)に残る', async () => {
    const sctx = await sctxOf();
    await createServer(mctxOf(sctx), body({ host: 'localhost', port: 7776 }));
    const t0 = 10_000_000;
    expect(await testServer(mctxOf(sctx, t0), '1')).toMatchObject({
      ok: true,
      data: { server: { id: '1', lastTest: { result: 'ok' } }, test: { ok: true, serverName: 'Mock 7776' } },
    });
    expect(await testServer(mctxOf(sctx, t0 + 1_000), '1')).toEqual({ ok: false, code: 'RATE_LIMITED', opts: { retryAfterSec: 4 } });
    const fails: MutationContext = { ...mctxOf(sctx, t0 + 5_000), deps: { fetchFn: async () => new Response('{}', { status: 401 }), log: () => undefined } };
    expect(await testServer(fails, '1')).toMatchObject({ ok: true, data: { test: { ok: false, code: 'RCON_AUTH_FAILED' } } });
    expect((await listServers(sctx)).servers[0]?.lastTest?.result).toBe('RCON_AUTH_FAILED');
    const rows = (await settingsRows(sctx.db)).filter((r) => r.event === 'server_test');
    expect(rows.map((r) => JSON.parse(r.params_json))).toEqual([{ result: 'ok' }, { result: 'RCON_AUTH_FAILED' }]);
    // /api/audit では server_test の結果で status / errorCode が決まる
    expect((await listSettingsAudit(sctx.db, { limit: 10, before: null })).entries.map((e) => [e.event, e.status, e.errorCode])).toEqual([
      ['server_test', 'failed', 'RCON_AUTH_FAILED'],
      ['server_test', 'succeeded', null],
      ['server_add', 'succeeded', null],
    ]);
  });
});

describe('選択(ページ・API の server 省略時)', () => {
  const s = (id: string, usable: boolean) => ({ id, usable }) as unknown as Parameters<typeof selectServer>[0][number];
  const list = [s('3', false), s('1', true), s('2', true)];

  it('クエリ → Cookie → 最初の usable → 先頭', () => {
    expect(selectServer(list, '2', '1')).toMatchObject({ selected: { id: '2' }, fromQuery: true, notFound: false });
    expect(selectServer(list, null, '2')).toMatchObject({ selected: { id: '2' }, fromQuery: false, staleCookie: false });
    expect(selectServer(list, null, null)).toMatchObject({ selected: { id: '1' } });
    expect(selectServer([s('3', false)], null, null)).toMatchObject({ selected: { id: '3' } });
    expect(selectServer([], null, null)).toMatchObject({ selected: null, notFound: false });
  });

  it('指定されたのに無い・形式不正なら切り替えない(notFound)。Cookie の指す先が無ければ無視して消す', () => {
    expect(selectServer(list, '9', '1')).toMatchObject({ selected: null, notFound: true });
    expect(selectServer(list, 'default', null)).toMatchObject({ selected: null, notFound: true });
    expect(selectServer(list, '<x>', null)).toMatchObject({ selected: null, notFound: true });
    expect(selectServer(list, null, '9')).toMatchObject({ selected: { id: '1' }, staleCookie: true });
    expect(selectServer(list, null, 'default')).toMatchObject({ selected: { id: '1' }, staleCookie: true });
  });
});
