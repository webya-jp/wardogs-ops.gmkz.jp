// 書き込みの二段階と段階的有効化(D1 なし)の確認。D1 ありの経路は docs/API_TEST.md の wrangler dev 確認で見ている
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAction, prepareAction } from './actions';
import { listAudit, toApiStatus } from './audit';
import type { ActionContext } from './actions';
import { getFeatures, resetD1Cache } from './config';
import { deriveKeysFrom, deriveServerPasswordKeysFrom } from './keys';
import type { FetchFn } from './rcon/client';
import { resetCapabilitiesForTest } from './rcon/capabilities';

const PLAYER = { name: 'Alice', steamId: '00000000000000001' };
const calls: string[] = [];
const fetchFn: FetchFn = async (url, init) => {
  const path = new URL(url).pathname;
  calls.push(`${init.method} ${path}`);
  if (path === '/v1/capabilities') return Response.json({ routes: ['GET /v1/players', 'POST /v1/players/{steamId}/kick', 'GET /v1/status'] });
  if (path === '/v1/players') return Response.json({ players: [PLAYER], count: 1 });
  if (path.endsWith('/kick')) return Response.json({ ok: true });
  return new Response('{}', { status: 404 });
};

const ENV = {
  ASSETS: {} as Fetcher,
  ADMIN_PASSWORD: 'admin-password-1234567890',
  RCON_URL: 'http://rcon.example.invalid:7776',
  RCON_PASSWORD: 'p',
};

async function ctx(over: Partial<ActionContext> = {}): Promise<ActionContext> {
  return {
    keys: await deriveKeysFrom('', ENV.ADMIN_PASSWORD),
    servers: { env: ENV, db: over.db ?? null, keys: await deriveServerPasswordKeysFrom('', ENV.ADMIN_PASSWORD) },
    session: { sid: 'AAAAAAAAAAAAAAAAAAAAAA', iat: 0, exp: 0, operator: null },
    db: null,
    writesEnabled: true,
    ipHash: null,
    deps: { fetchFn, log: () => undefined },
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  resetCapabilitiesForTest();
  resetD1Cache();
});

describe('actions (D1 なし)', () => {
  it('writes が無効なら WRITES_DISABLED', async () => {
    const c = await ctx({ writesEnabled: false });
    expect(await prepareAction(c, { server: 'default', action: 'broadcast', params: { message: 'x' } })).toEqual({ ok: false, code: 'WRITES_DISABLED' });
    expect(await executeAction(c, {})).toEqual({ ok: false, code: 'WRITES_DISABLED' });
  });

  it('capability が missing なら CAPABILITY_MISSING(RCON の書き込みは呼ばない)', async () => {
    const r = await prepareAction(await ctx(), { server: 'default', action: 'broadcast', params: { message: 'x' } });
    expect(r).toEqual({ ok: false, code: 'CAPABILITY_MISSING' });
  });

  it('prepare → execute で kick を 1 回だけ実行し、再送は ALREADY_EXECUTED(メモリ近似)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const c = await ctx();
    const p = await prepareAction(c, { server: 'default', action: 'kick', params: { steamId: PLAYER.steamId, reason: ' r ' } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.data).toMatchObject({ action: 'kick', params: { steamId: PLAYER.steamId, reason: 'r' }, targetName: 'Alice', capability: 'available' });
    const body = { server: 'default', action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken };
    const e = await executeAction(c, body);
    expect(e).toMatchObject({ ok: true, data: { auditId: null, action: 'kick' } });
    expect(await executeAction(c, body)).toEqual({ ok: false, code: 'ALREADY_EXECUTED' });
    expect(calls.filter((x) => x.endsWith('/kick'))).toHaveLength(1);
    // ログ無しモードの記録に Steam ID・名前を出さない
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('write-without-audit');
    expect(logged).not.toContain(PLAYER.steamId);
    expect(logged).not.toContain('Alice');
    log.mockRestore();
  });

  it('接続していない Steam ID は not_online', async () => {
    const r = await prepareAction(await ctx(), { server: 'default', action: 'kick', params: { steamId: '00000000000000002' } });
    expect(r).toEqual({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { steamId: 'not_online' } } });
  });

  it('別セッションのトークンは CONFIRM_INVALID', async () => {
    const c = await ctx();
    const p = await prepareAction(c, { server: 'default', action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    const other = await ctx({ session: { sid: 'BBBBBBBBBBBBBBBBBBBBBB', iat: 0, exp: 0, operator: null } });
    expect(await executeAction(other, { server: 'default', action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken })).toEqual({
      ok: false,
      code: 'CONFIRM_INVALID',
    });
  });
});

describe('features(段階的有効化)', () => {
  const base = { ASSETS: {} as Fetcher };
  it('D1 が無い: 既定は書き込み不可、AUDIT_REQUIRED="false" なら可', async () => {
    expect((await getFeatures(base)).features).toEqual({ audit: false, snapshots: false, writes: false, servers: false });
    expect((await getFeatures({ ...base, AUDIT_REQUIRED: 'false' })).features).toEqual({ audit: false, snapshots: false, writes: true, servers: false });
    expect((await getFeatures(base)).d1).toBe('missing');
  });
  it('テーブルが無い D1 は not_migrated', async () => {
    const db = { prepare: () => ({ first: async () => { throw new Error('no such table'); } }) } as unknown as D1Database;
    const s = await getFeatures({ ...base, DB: db });
    expect(s.d1).toBe('not_migrated');
    expect(s.db).toBeNull();
    expect(s.features.writes).toBe(false);
  });
});

describe('actions (D1 あり。拒否も監査ログに残す)', () => {
  const rows = async (db: D1Database) =>
    (await db.prepare('SELECT event, status, error_code, confirm_nonce, target_steam_id, finished_at FROM audit_log ORDER BY id').all()).results as Record<string, unknown>[];

  it('CONFIRM_INVALID / CONFIRM_EXPIRED / CAPABILITY_MISSING は failed で 1 行、入力検証失敗は記録しない', async () => {
    const { makeD1 } = await import('./testing/sqlite-d1');
    const db = await makeD1();
    const c = await ctx({ db });
    // 入力検証失敗(400)は記録しない
    expect((await prepareAction(c, { server: 'default', action: 'kick', params: { steamId: '1' } })).ok).toBe(false);
    expect(await rows(db)).toHaveLength(0);
    // capability が missing
    expect(await prepareAction(c, { server: 'default', action: 'broadcast', params: { message: 'x' } })).toEqual({ ok: false, code: 'CAPABILITY_MISSING' });
    // 偽トークン
    expect(await executeAction(c, { server: 'default', action: 'kick', params: { steamId: PLAYER.steamId }, confirmToken: 'v1.x.y' })).toEqual({
      ok: false,
      code: 'CONFIRM_INVALID',
    });
    // 期限切れ
    const p = await prepareAction({ ...c, now: 1_000 }, { server: 'default', action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    expect(await executeAction({ ...c, now: 1_000 + 121_000 }, { server: 'default', action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken })).toEqual({
      ok: false,
      code: 'CONFIRM_EXPIRED',
    });
    // action が分からないものは記録しない
    await executeAction(c, { server: 'default', action: 'nope', confirmToken: 'x' });
    const r = await rows(db);
    expect(r.map((x) => [x.event, x.status, x.error_code, x.confirm_nonce])).toEqual([
      ['broadcast', 'failed', 'CAPABILITY_MISSING', null],
      ['kick', 'failed', 'CONFIRM_INVALID', null],
      ['kick', 'failed', 'CONFIRM_EXPIRED', null],
    ]);
    expect(r[1]?.target_steam_id).toBe(PLAYER.steamId);
    expect(r.every((x) => typeof x.finished_at === 'number')).toBe(true);
  });

  it('正常な execute は pending → succeeded の 1 行', async () => {
    const { makeD1 } = await import('./testing/sqlite-d1');
    const db = await makeD1();
    const c = await ctx({ db });
    const p = await prepareAction(c, { server: 'default', action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    const e = await executeAction(c, { server: 'default', action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken });
    expect(e.ok).toBe(true);
    expect(await executeAction(c, { server: 'default', action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken })).toEqual({
      ok: false,
      code: 'ALREADY_EXECUTED',
    });
    const r = await rows(db);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ event: 'kick', status: 'succeeded', error_code: null });
  });
});

describe('監査ログの status(RCON タイムアウトは API で unknown)', () => {
  it('toApiStatus: failed + RCON_TIMEOUT だけ unknown、それ以外は保存値のまま', () => {
    expect(toApiStatus('failed', 'RCON_TIMEOUT')).toBe('unknown');
    expect(toApiStatus('failed', 'RCON_UNREACHABLE')).toBe('failed');
    expect(toApiStatus('failed', null)).toBe('failed');
    expect(toApiStatus('succeeded', null)).toBe('succeeded');
    expect(toApiStatus('pending', null)).toBe('pending');
  });

  it('RCON がタイムアウトした execute は D1 上 failed のまま、listAudit では unknown', async () => {
    const { makeD1 } = await import('./testing/sqlite-d1');
    const db = await makeD1();
    const timeoutFetch: FetchFn = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/capabilities') return Response.json({ routes: ['GET /v1/players', 'POST /v1/players/{steamId}/kick'] });
      if (path === '/v1/players') return Response.json({ players: [PLAYER], count: 1 });
      // 書き込みは応答せず、タイムアウトの abort を待つ
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const c = await ctx({ db, deps: { fetchFn: timeoutFetch, log: () => undefined } });
    const p = await prepareAction(c, { server: 'default', action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let e: Awaited<ReturnType<typeof executeAction>>;
    try {
      let done = false;
      const pending = executeAction(c, { server: 'default', action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken }).then((r) => {
        done = true;
        return r;
      });
      // D1 の処理(実時間)が終わって fetch のタイマーが張られるまで、時間を進め続ける
      for (let i = 0; i < 200 && !done; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise<void>((r) => setImmediate(r));
      }
      e = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(e).toMatchObject({ ok: false, code: 'RCON_TIMEOUT' });
    const raw = (await db.prepare('SELECT status, error_code FROM audit_log').all()).results as Record<string, unknown>[];
    const { entries } = await listAudit(db, { limit: 10, before: null });
    expect(raw).toEqual([{ status: 'failed', error_code: 'RCON_TIMEOUT' }]);
    expect(entries[0]?.status).toBe('unknown');
  });
});

describe('actions(複数サーバー)', () => {
  const hostCalls: string[] = [];
  const multiFetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    hostCalls.push(`${u.hostname} ${init.method} ${u.pathname}`);
    if (u.pathname === '/v1/capabilities') return Response.json({ routes: ['GET /v1/players', 'POST /v1/players/{steamId}/kick', 'GET /v1/status'] });
    if (u.pathname === '/v1/players') return Response.json({ players: [PLAYER], count: 1 });
    if (u.pathname === '/v1/status') return Response.json({ serverName: u.hostname, players: { current: 1, max: 8 } });
    if (u.pathname.endsWith('/kick')) return Response.json({ ok: true });
    return new Response('{}', { status: 404 });
  };
  const deps = { fetchFn: multiFetch, log: () => undefined };

  async function setup() {
    const { makeD1 } = await import('./testing/sqlite-d1');
    const { createServer, resetServersForTest } = await import('./servers');
    resetServersForTest();
    hostCalls.length = 0;
    const db = await makeD1();
    const c = await ctx({ db, deps });
    const m = { sctx: c.servers, actor: { operator: 'op', sessionTag: 'AAAAAAAA', ipHash: null }, deps };
    const a = await createServer(m, { name: 'Server A', host: 'rcon-a.example.com', port: 7777, password: 'x'.repeat(24) });
    const b = await createServer(m, { name: 'Server B', host: 'rcon-b.example.com', port: 7777, password: 'y'.repeat(24) });
    if (!a.ok || !b.ok) throw new Error('create failed');
    hostCalls.length = 0;
    return { db, c, m, a: a.data.server.id, b: b.data.server.id };
  }

  it('server が無い・形式不正の prepare / execute は VALIDATION_FAILED(記録しない)', async () => {
    const { db, c } = await setup();
    expect(await prepareAction(c, { action: 'kick', params: { steamId: PLAYER.steamId } })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      opts: { fields: { server: 'required' } },
    });
    expect(await prepareAction(c, { server: '01', action: 'kick', params: { steamId: PLAYER.steamId } })).toMatchObject({
      opts: { fields: { server: 'invalid_format' } },
    });
    expect(await executeAction(c, { action: 'kick', params: { steamId: PLAYER.steamId }, confirmToken: 'x' })).toMatchObject({
      code: 'VALIDATION_FAILED',
      opts: { fields: { server: 'required' } },
    });
    expect(await prepareAction(c, { server: '99', action: 'kick', params: { steamId: PLAYER.steamId } })).toEqual({ ok: false, code: 'SERVER_NOT_FOUND' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>())?.n).toBe(0);
  });

  it('prepare → execute は指定したサーバーにだけ送り、audit_log に server_id / server_name を残す', async () => {
    const { db, c, a } = await setup();
    const p = await prepareAction(c, { server: a, action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    expect(p.data.server).toBe(a);
    const e = await executeAction(c, { server: a, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken });
    expect(e).toMatchObject({ ok: true, data: { server: a } });
    expect(hostCalls.filter((x) => x.endsWith('/kick'))).toEqual(['rcon-a.example.com POST /v1/players/00000000000000001/kick']);
    const row = await db.prepare('SELECT server_id, server_name, status FROM audit_log').first();
    expect(row).toEqual({ server_id: Number(a), server_name: 'Server A', status: 'succeeded' });
    const { entries } = await listAudit(db, { limit: 10, before: null, server: a });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ serverId: a, serverName: 'Server A' });
    expect((await listAudit(db, { limit: 10, before: null, server: 'default' })).entries).toHaveLength(0);
  });

  it('別サーバーの id を指定した execute は CONFIRM_INVALID(RCON は呼ばない、記録は指定先の server_id)', async () => {
    const { db, c, a, b } = await setup();
    const p = await prepareAction(c, { server: a, action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    const e = await executeAction(c, { server: b, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken });
    expect(e).toEqual({ ok: false, code: 'CONFIRM_INVALID' });
    expect(hostCalls.filter((x) => x.endsWith('/kick'))).toHaveLength(0);
    const row = await db.prepare('SELECT server_id, server_name, status, error_code FROM audit_log').first();
    expect(row).toEqual({ server_id: Number(b), server_name: 'Server B', status: 'failed', error_code: 'CONFIRM_INVALID' });
  });

  it('prepare 後に宛先が変わったら CONFIRM_INVALID、無効にしたら SERVER_DISABLED(どちらも記録)', async () => {
    const { db, c, m, a } = await setup();
    const { updateServer } = await import('./servers');
    const p = await prepareAction(c, { server: a, action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    const moved = await updateServer(m, a, { port: 7778, password: 'z'.repeat(24) });
    expect(moved.ok).toBe(true);
    const body = { server: a, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken };
    expect(await executeAction(c, body)).toEqual({ ok: false, code: 'CONFIRM_INVALID' });
    await updateServer(m, a, { enabled: false });
    expect(await executeAction(c, body)).toEqual({ ok: false, code: 'SERVER_DISABLED' });
    // 署名が不正なら、サーバーの状態より CONFIRM_INVALID を優先する
    expect(await executeAction(c, { ...body, confirmToken: 'v1.x.y' })).toEqual({ ok: false, code: 'CONFIRM_INVALID' });
    expect(hostCalls.filter((x) => x.endsWith('/kick'))).toHaveLength(0);
    const rows = (await db.prepare('SELECT server_id, error_code FROM audit_log ORDER BY id').all()).results;
    expect(rows).toEqual([
      { server_id: Number(a), error_code: 'CONFIRM_INVALID' },
      { server_id: Number(a), error_code: 'SERVER_DISABLED' },
      { server_id: Number(a), error_code: 'CONFIRM_INVALID' },
    ]);
  });
});
