// 複数サーバー(src/lib/servers.ts)の単体テスト。D1 は node:sqlite で 0001 + 0002 を適用したもの。
// ホスト名・パスワードはダミー(example.com / localhost と固定文字列)だけを使う。
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SERVERS } from '../types/api';
import type { OpsEnv } from '../types/env';
import { listSettingsAudit } from './audit';
import { deriveServerPasswordKeysFrom } from './keys';
import type { FetchFn } from './rcon/client';
import { resetCapabilitiesForTest } from './rcon/capabilities';
import {
  createServer,
  decryptPassword,
  deleteServer,
  encryptPassword,
  listServers,
  migratePasswords,
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
import { makeD1 } from './testing/sqlite-d1';

const ADMIN = 'admin-password-for-tests-01';
const SECRET = 's'.repeat(40);
const PW = 'rcon-password-for-tests-0123456789';
const EP = { scheme: 'http', host: 'rcon-a.example.com', port: 7777 };

const okFetch: FetchFn = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/v1/status') return Response.json({ serverName: `Mock ${u.port}`, players: { current: 3, max: 16 } });
  return new Response('{}', { status: 404 });
};
const deps = { fetchFn: okFetch, log: () => undefined };

function envOf(o: Partial<OpsEnv> = {}): OpsEnv {
  return { ASSETS: {} as Fetcher, ADMIN_PASSWORD: ADMIN, ...o };
}

async function sctxOf(o: { env?: OpsEnv; db?: D1Database | null } = {}): Promise<ServerContext> {
  const env = o.env ?? envOf();
  return { env, db: o.db === undefined ? await makeD1() : o.db, keys: await deriveServerPasswordKeysFrom(env.SESSION_SECRET ?? '', env.ADMIN_PASSWORD ?? '') };
}

function mctxOf(sctx: ServerContext, now?: number): MutationContext {
  return { sctx, actor: { operator: 'tester', sessionTag: 'AAAAAAAA', ipHash: null }, deps, ...(now === undefined ? {} : { now }) };
}

const body = (o: Record<string, unknown> = {}) => ({ name: 'Server A', host: 'rcon-a.example.com', port: 7777, password: PW, ...o });

beforeEach(() => {
  resetServersForTest();
  resetCapabilitiesForTest();
});

describe('暗号化(AES-256-GCM)', () => {
  it('往復でき、暗号文に平文を含まない。形式は v1.<k>.<iv>.<ct>', async () => {
    const keys = await deriveServerPasswordKeysFrom('', ADMIN);
    const enc = await encryptPassword(keys, EP, PW);
    expect(enc).toMatch(/^v1\.a\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(enc).not.toContain(PW);
    expect(await decryptPassword(keys, enc!, EP)).toEqual({ ok: true, plaintext: PW, k: 'a' });
    // IV は毎回変わる
    expect(await encryptPassword(keys, EP, PW)).not.toBe(enc);
  });

  it('AAD(宛先)が違えば復号できない(暗号文を別の行にコピーしても使えない)', async () => {
    const keys = await deriveServerPasswordKeysFrom('', ADMIN);
    const enc = (await encryptPassword(keys, EP, PW))!;
    expect(await decryptPassword(keys, enc, { ...EP, port: 7778 })).toEqual({ ok: false });
    expect(await decryptPassword(keys, enc, { ...EP, host: 'rcon-b.example.com' })).toEqual({ ok: false });
    expect(await decryptPassword(keys, enc, { ...EP, scheme: 'https' })).toEqual({ ok: false });
    // k を書き換えても(AAD に k を含む)復号できない
    const withS = await deriveServerPasswordKeysFrom(SECRET, ADMIN);
    expect(await decryptPassword(withS, enc.replace('v1.a.', 'v1.s.'), EP)).toEqual({ ok: false });
  });

  it('鍵の切り替え: s は SESSION_SECRET だけ、a は ADMIN_PASSWORD だけに依存する', async () => {
    const withS = await deriveServerPasswordKeysFrom(SECRET, ADMIN);
    expect(withS.preferred).toBe('s');
    const encS = (await encryptPassword(withS, EP, PW))!;
    expect(encS.startsWith('v1.s.')).toBe(true);
    // ADMIN_PASSWORD を変えても s の行は読める
    const adminChanged = await deriveServerPasswordKeysFrom(SECRET, 'another-admin-password-xx');
    expect(await decryptPassword(adminChanged, encS, EP)).toMatchObject({ ok: true, plaintext: PW });
    // SESSION_SECRET を消すと s の行は読めない
    const noSecret = await deriveServerPasswordKeysFrom('', ADMIN);
    expect(await decryptPassword(noSecret, encS, EP)).toEqual({ ok: false });
    // a の行は SESSION_SECRET を足しても読める
    const encA = (await encryptPassword(noSecret, EP, PW))!;
    expect(await decryptPassword(withS, encA, EP)).toMatchObject({ ok: true, k: 'a' });
    // a の行は ADMIN_PASSWORD を変えると読めない
    expect(await decryptPassword(await deriveServerPasswordKeysFrom('', 'another-admin-password-xx'), encA, EP)).toEqual({ ok: false });
    // 形式不正
    expect(await decryptPassword(withS, 'v1.s.x.y', EP)).toEqual({ ok: false });
    expect(await decryptPassword(withS, '', EP)).toEqual({ ok: false });
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

  it('追加: 項目ごとの検証、ADMIN_PASSWORD と同じパスワード、重複', async () => {
    const m = mctxOf(await sctxOf());
    expect(await createServer(m, { name: ' ', host: '192.0.2.1', port: 0, password: ADMIN })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      opts: { fields: { name: 'required', host: 'ip_address', port: 'out_of_range', password: 'same_as_admin_password' } },
    });
    expect(await createServer(m, body({ name: 'a\nb' }))).toMatchObject({ opts: { fields: { name: 'invalid_characters' } } });
    expect(await createServer(m, body({ name: 'x'.repeat(33) }))).toMatchObject({ opts: { fields: { name: 'too_long' } } });
    expect((await createServer(m, body())).ok).toBe(true);
    expect(await createServer(m, body({ host: 'rcon-b.example.com' }))).toMatchObject({ opts: { fields: { name: 'duplicate' } } });
    expect(await createServer(m, body({ name: 'Server B', host: 'RCON-A.example.com' }))).toMatchObject({ opts: { fields: { host: 'duplicate' } } });
    // 同じホスト名でもポートが違えば別サーバー
    expect((await createServer(m, body({ name: 'Server B', port: 7778 }))).ok).toBe(true);
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
      source: 'db',
      name: 'Server A',
      host: 'rcon-a.example.com',
      port: 7777,
      enabled: true,
      needsPassword: false,
      passwordShort: false,
      usable: true,
      lastTest: { result: 'ok' },
    });
    expect(JSON.stringify(r.data)).not.toContain(PW);
    expect(JSON.stringify(r.data)).not.toContain('v1.a.');
    const stored = await sctx.db!.prepare('SELECT rcon_password_enc AS e FROM servers').first<{ e: string }>();
    expect(stored?.e.startsWith('v1.a.')).toBe(true);
    expect(stored?.e).not.toContain(PW);
    const log = await listSettingsAudit(sctx.db!, { limit: 10, before: null });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ event: 'server_add', serverId: '1', serverName: 'Server A', status: 'succeeded', operator: 'tester' });
    expect(log.entries[0]?.params).toEqual({ name: 'Server A', host: 'rcon-a.example.com', port: 7777, enabled: true, passwordChanged: true });
    expect(JSON.stringify(log)).not.toContain(PW);

    const resolved = await resolveServer(sctx, '1');
    expect(resolved).toEqual({
      ok: true,
      data: { id: '1', auditServerId: 1, name: 'Server A', rcon: { baseUrl: 'http://rcon-a.example.com:7777', password: PW } },
    });
  });

  it('接続テストに失敗しても保存する(test.ok: false、一覧の lastTest に残る)', async () => {
    const sctx = await sctxOf();
    const authFail: FetchFn = async () => new Response('{}', { status: 401 });
    const r = await createServer({ ...mctxOf(sctx), deps: { fetchFn: authFail, log: () => undefined } }, body());
    expect(r).toMatchObject({ ok: true, data: { test: { ok: false, code: 'RCON_AUTH_FAILED' }, server: { lastTest: { result: 'RCON_AUTH_FAILED' } } } });
    expect((await listServers(sctx)).servers).toHaveLength(1);
  });

  it(`上限は ${MAX_SERVERS} 台(既定サーバーは数えない)`, async () => {
    const sctx = await sctxOf({ env: envOf({ RCON_URL: 'http://rcon.example.com:7776', RCON_PASSWORD: 'p'.repeat(24) }) });
    const m = mctxOf(sctx);
    for (let i = 0; i < MAX_SERVERS; i++) {
      const r = await createServer(m, body({ name: `S${i}`, port: 7000 + i }));
      expect(r.ok).toBe(true);
    }
    expect(await createServer(m, body({ name: 'over', port: 9999 }))).toEqual({ ok: false, code: 'SERVER_LIMIT_REACHED' });
    const list = await listServers(sctx);
    expect(list.servers).toHaveLength(MAX_SERVERS + 1);
    expect(list.servers[0]).toMatchObject({ id: 'default', source: 'secrets', name: null, host: null, port: null, usable: true });
  });

  it('既定サーバー: 両方なら使える、片方だけなら NOT_CONFIGURED(一覧には secretsIssue 付き)、無ければ SERVER_NOT_FOUND', async () => {
    const both = await sctxOf({ env: envOf({ RCON_URL: 'http://rcon.example.com:7776/', RCON_PASSWORD: 'p' }), db: null });
    expect(await resolveServer(both, 'default')).toMatchObject({ ok: true, data: { id: 'default', auditServerId: null, name: null } });
    expect((await listServers(both)).servers[0]).toMatchObject({ passwordShort: true, secretsIssue: null });
    const half = await sctxOf({ env: envOf({ RCON_URL: 'http://rcon.example.com:7776' }), db: null });
    expect(await resolveServer(half, 'default')).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
    expect((await listServers(half)).servers[0]).toMatchObject({ usable: false, secretsIssue: 'RCON_PASSWORD_MISSING' });
    const none = await sctxOf({ db: null });
    expect(await resolveServer(none, 'default')).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    expect((await listServers(none)).servers).toEqual([]);
    // D1 が無いと登録サーバーは SERVERS_UNAVAILABLE
    expect(await resolveServer(none, '1')).toEqual({ ok: false, code: 'SERVERS_UNAVAILABLE' });
    expect(await createServer(mctxOf(none), body())).toEqual({ ok: false, code: 'SERVERS_UNAVAILABLE' });
    // 0 台で server 省略は NO_SERVERS
    expect(await resolveServerForRead(none, null, null)).toEqual({ ok: false, code: 'NO_SERVERS' });
    expect(await resolveServerForRead(none, 'x', null)).toEqual({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { server: 'invalid_format' } } });
  });

  it('needsPassword: 鍵が変わると復号できず 409 SERVER_NEEDS_PASSWORD。パスワードの入れ直しで解消', async () => {
    const db = await makeD1();
    const before = await sctxOf({ db });
    await createServer(mctxOf(before), body());
    const after = await sctxOf({ db, env: envOf({ ADMIN_PASSWORD: 'changed-admin-password-xyz' }) });
    const list = await listServers(after);
    expect(list.unreadable).toBe(true);
    expect(list.servers[0]).toMatchObject({ needsPassword: true, usable: false, passwordShort: false });
    expect(await resolveServer(after, '1')).toEqual({ ok: false, code: 'SERVER_NEEDS_PASSWORD' });
    expect(await testServer(mctxOf(after), '1')).toEqual({ ok: false, code: 'SERVER_NEEDS_PASSWORD' });
    const fixed = await updateServer(mctxOf(after), '1', { password: PW });
    expect(fixed).toMatchObject({ ok: true, data: { server: { needsPassword: false, usable: true }, test: { ok: true } } });
    expect((await listServers(after)).unreadable).toBe(false);
  });

  it('SESSION_SECRET を設定すると a の行を s に再暗号化する(1 回きり。updated_at・変更ログは触らない)', async () => {
    const db = await makeD1();
    await createServer(mctxOf(await sctxOf({ db }), 1_000), body());
    const withS = await sctxOf({ db, env: envOf({ SESSION_SECRET: SECRET }) });
    const list = await listServers(withS);
    expect(list.migrations).toHaveLength(1);
    await migratePasswords(withS, list.migrations);
    const row = await db.prepare('SELECT rcon_password_enc AS e, updated_at AS u FROM servers').first<{ e: string; u: number }>();
    expect(row?.e.startsWith('v1.s.')).toBe(true);
    expect(row?.u).toBe(1_000);
    expect((await listServers(withS)).migrations).toHaveLength(0);
    expect((await listSettingsAudit(db, { limit: 10, before: null })).entries).toHaveLength(1);
    // ADMIN_PASSWORD を変えても読める
    const changed = await sctxOf({ db, env: envOf({ SESSION_SECRET: SECRET, ADMIN_PASSWORD: 'changed-admin-password-xyz' }) });
    expect(await resolveServer(changed, '1')).toMatchObject({ ok: true, data: { rcon: { password: PW } } });
  });
});

describe('変更・削除・接続テスト', () => {
  it('宛先を変えるときはパスワードの再入力が必須(reenter_required)。変更なしは何もしない', async () => {
    const sctx = await sctxOf();
    const m = mctxOf(sctx);
    await createServer(m, body());
    expect(await updateServer(m, '1', { port: 7778 })).toEqual({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { password: 'reenter_required' } } });
    expect(await updateServer(m, '1', { host: 'rcon-b.example.com', password: '' })).toMatchObject({ opts: { fields: { password: 'reenter_required' } } });
    // 同じ値は変更とみなさない
    expect(await updateServer(m, '1', { name: 'Server A', port: 7777 })).toMatchObject({ ok: true, data: { test: null } });
    expect((await listSettingsAudit(sctx.db!, { limit: 10, before: null })).entries).toHaveLength(1);
    const moved = await updateServer(m, '1', { port: 7778, password: PW });
    expect(moved).toMatchObject({ ok: true, data: { server: { port: 7778 }, test: { ok: true, serverName: 'Mock 7778' } } });
    expect(await resolveServer(sctx, '1')).toMatchObject({ ok: true, data: { rcon: { baseUrl: 'http://rcon-a.example.com:7778' } } });
    const log = await listSettingsAudit(sctx.db!, { limit: 10, before: null, server: '1' });
    expect(log.entries[0]).toMatchObject({ event: 'server_update', params: { port: 7778, passwordChanged: true } });
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

  it('既定サーバーは変更・削除できない(SERVER_READ_ONLY)。id の形式不正は 400、無い id は 404', async () => {
    const m = mctxOf(await sctxOf());
    expect(await updateServer(m, 'default', { name: 'x' })).toEqual({ ok: false, code: 'SERVER_READ_ONLY' });
    expect(await deleteServer(m, 'default', { confirmName: 'x' })).toEqual({ ok: false, code: 'SERVER_READ_ONLY' });
    expect(await updateServer(m, '0', {})).toEqual({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { server: 'invalid_format' } } });
    expect(await updateServer(m, '5', {})).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    expect(await testServer(m, '5')).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    expect(await testServer(m, 'default')).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
  });

  it('削除は表示名の一致が必要。変更ログは残り、id は再利用しない', async () => {
    const sctx = await sctxOf();
    const m = mctxOf(sctx);
    await createServer(m, body());
    expect(await deleteServer(m, '1', {})).toMatchObject({ opts: { fields: { confirmName: 'required' } } });
    expect(await deleteServer(m, '1', { confirmName: 'server a' })).toMatchObject({ opts: { fields: { confirmName: 'mismatch' } } });
    expect(await deleteServer(m, '1', { confirmName: 'Server A' })).toEqual({ ok: true, data: { deletedId: '1' } });
    expect(await resolveServer(sctx, '1')).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    const again = await createServer(m, body());
    expect(again).toMatchObject({ ok: true, data: { server: { id: '2' } } });
    const log = await listSettingsAudit(sctx.db!, { limit: 10, before: null });
    expect(log.entries.map((e) => [e.event, e.serverId])).toEqual([
      ['server_add', '2'],
      ['server_delete', '1'],
      ['server_add', '1'],
    ]);
    expect(log.entries[1]?.params).toEqual({ name: 'Server A', host: 'rcon-a.example.com', port: 7777 });
  });

  it('接続テストは同じサーバーに 5 秒に 1 回まで(既定サーバーの結果はメモリに残る)', async () => {
    const sctx = await sctxOf({ env: envOf({ RCON_URL: 'http://localhost:7776', RCON_PASSWORD: 'p'.repeat(24) }) });
    const t0 = 10_000_000;
    expect(await testServer(mctxOf(sctx, t0), 'default')).toMatchObject({
      ok: true,
      data: { server: { id: 'default', lastTest: { result: 'ok' } }, test: { ok: true, serverName: 'Mock 7776' } },
    });
    expect(await testServer(mctxOf(sctx, t0 + 1_000), 'default')).toEqual({ ok: false, code: 'RATE_LIMITED', opts: { retryAfterSec: 4 } });
    expect((await testServer(mctxOf(sctx, t0 + 5_000), 'default')).ok).toBe(true);
    expect((await listServers(sctx)).servers[0]?.lastTest?.result).toBe('ok');
  });
});

describe('選択(ページ・API の server 省略時)', () => {
  const s = (id: string, usable: boolean) =>
    ({ id, usable }) as unknown as Parameters<typeof selectServer>[0][number];
  const list = [s('default', false), s('1', true), s('2', true)];

  it('クエリ → Cookie → 最初の usable → 先頭', () => {
    expect(selectServer(list, '2', '1')).toMatchObject({ selected: { id: '2' }, fromQuery: true, notFound: false });
    expect(selectServer(list, null, '2')).toMatchObject({ selected: { id: '2' }, fromQuery: false, staleCookie: false });
    expect(selectServer(list, null, null)).toMatchObject({ selected: { id: '1' } });
    expect(selectServer([s('default', false)], null, null)).toMatchObject({ selected: { id: 'default' } });
    expect(selectServer([], null, null)).toMatchObject({ selected: null, notFound: false });
  });

  it('指定されたのに無い・形式不正なら切り替えない(notFound)。Cookie の指す先が無ければ無視して消す', () => {
    expect(selectServer(list, '9', '1')).toMatchObject({ selected: null, notFound: true });
    expect(selectServer(list, '<x>', null)).toMatchObject({ selected: null, notFound: true });
    expect(selectServer(list, null, '9')).toMatchObject({ selected: { id: '1' }, staleCookie: true });
  });
});
