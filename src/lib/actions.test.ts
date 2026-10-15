// 書き込みの二段階(prepare → execute)と監査ログ。D1 は必須(node:sqlite で 0001 + 0002 を適用したもの)。
// ホスト名・パスワード・Steam ID はダミーだけを使う。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAction, prepareAction } from './actions';
import type { ActionContext } from './actions';
import { listAudit, toApiStatus } from './audit';
import type { FetchFn } from './rcon/client';
import { resetCapabilitiesForTest } from './rcon/capabilities';
import { createServer, resetServersForTest, updateServer } from './servers';
import type { MutationContext } from './servers';
import { testKeys } from './testing/keys';
import { makeD1 } from './testing/sqlite-d1';

const PLAYER = { name: 'Alice', steamId: '00000000000000001' };
const SID = 'AAAAAAAAAAAAAAAAAAAAAA';
const hostCalls: string[] = [];

/** capabilities の routes を差し替えられるモック(既定は players・kick・status だけ = broadcast は missing) */
function fetchWith(routes: string[] = ['GET /v1/players', 'POST /v1/players/{steamId}/kick', 'GET /v1/status']): FetchFn {
  return async (url, init) => {
    const u = new URL(url);
    hostCalls.push(`${u.hostname} ${init.method} ${u.pathname}`);
    if (u.pathname === '/v1/capabilities') return Response.json({ routes });
    if (u.pathname === '/v1/players') return Response.json({ players: [PLAYER], count: 1 });
    if (u.pathname === '/v1/status') return Response.json({ serverName: u.hostname, players: { current: 1, max: 8 } });
    if (u.pathname.endsWith('/kick')) return Response.json({ ok: true });
    return new Response('{}', { status: 404 });
  };
}

interface Setup {
  db: D1Database;
  c: ActionContext;
  m: MutationContext;
  a: string;
  b: string;
}

async function setup(over: Partial<ActionContext> = {}): Promise<Setup> {
  const db = await makeD1();
  const keys = await testKeys();
  const deps = { fetchFn: fetchWith(), log: () => undefined };
  const c: ActionContext = {
    keys,
    servers: { db, key: keys.serverPassword },
    session: { aid: 1, sid: SID, iat: 0, exp: 0, operator: null },
    db,
    ipHash: null,
    deps,
    ...over,
  };
  const m: MutationContext = { sctx: c.servers, actor: { operator: 'op', sessionTag: 'AAAAAAAA', ipHash: null }, deps };
  const a = await createServer(m, { name: 'Server A', host: 'rcon-a.example.com', port: 7777, password: 'x'.repeat(24) });
  const b = await createServer(m, { name: 'Server B', host: 'rcon-b.example.com', port: 7777, password: 'y'.repeat(24) });
  if (!a.ok || !b.ok) throw new Error('create failed');
  hostCalls.length = 0;
  return { db, c, m, a: a.data.server.id, b: b.data.server.id };
}

const rows = async (db: D1Database) =>
  (await db.prepare('SELECT event, status, error_code, confirm_nonce, target_steam_id, finished_at, server_id FROM audit_log ORDER BY id').all())
    .results as Record<string, unknown>[];

beforeEach(() => {
  hostCalls.length = 0;
  resetCapabilitiesForTest();
  resetServersForTest();
});

describe('actions(prepare → execute)', () => {
  it('kick を 1 回だけ実行し、再送は ALREADY_EXECUTED(nonce の UNIQUE)。auditId は常に number', async () => {
    const { db, c, a } = await setup();
    const p = await prepareAction(c, { server: a, action: 'kick', params: { steamId: PLAYER.steamId, reason: ' r ' } });
    if (!p.ok) throw new Error('prepare failed');
    expect(p.data).toMatchObject({ action: 'kick', params: { steamId: PLAYER.steamId, reason: 'r' }, targetName: 'Alice', capability: 'available', server: a });
    const body = { server: a, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken };
    const e = await executeAction(c, body);
    expect(e).toMatchObject({ ok: true, data: { action: 'kick', server: a } });
    if (e.ok) expect(typeof e.data.auditId).toBe('number');
    expect(await executeAction(c, body)).toEqual({ ok: false, code: 'ALREADY_EXECUTED' });
    expect(hostCalls.filter((x) => x.endsWith('/kick'))).toHaveLength(1);
    const r = await rows(db);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ event: 'kick', status: 'succeeded', error_code: null, server_id: Number(a) });
  });

  it('接続していない Steam ID は not_online(記録しない)', async () => {
    const { db, c, a } = await setup();
    const r = await prepareAction(c, { server: a, action: 'kick', params: { steamId: '00000000000000002' } });
    expect(r).toEqual({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { steamId: 'not_online' } } });
    expect(await rows(db)).toHaveLength(0);
  });

  it('別セッションのトークンは CONFIRM_INVALID', async () => {
    const { c, a } = await setup();
    const p = await prepareAction(c, { server: a, action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    const other = { ...c, session: { aid: 1, sid: 'BBBBBBBBBBBBBBBBBBBBBB', iat: 0, exp: 0, operator: null } };
    expect(await executeAction(other, { server: a, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken })).toEqual({
      ok: false,
      code: 'CONFIRM_INVALID',
    });
  });

  it('CONFIRM_INVALID / CONFIRM_EXPIRED / CAPABILITY_MISSING は failed で 1 行、入力検証失敗は記録しない', async () => {
    const { db, c, a } = await setup();
    // 入力検証失敗(400)は記録しない
    expect((await prepareAction(c, { server: a, action: 'kick', params: { steamId: '1' } })).ok).toBe(false);
    expect(await rows(db)).toHaveLength(0);
    // capability が missing(RCON の書き込みは呼ばない)
    expect(await prepareAction(c, { server: a, action: 'broadcast', params: { message: 'x' } })).toEqual({ ok: false, code: 'CAPABILITY_MISSING' });
    // 偽トークン
    expect(await executeAction(c, { server: a, action: 'kick', params: { steamId: PLAYER.steamId }, confirmToken: 'v1.x.y' })).toEqual({
      ok: false,
      code: 'CONFIRM_INVALID',
    });
    // 期限切れ
    const p = await prepareAction({ ...c, now: 1_000 }, { server: a, action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    expect(
      await executeAction({ ...c, now: 1_000 + 121_000 }, { server: a, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken }),
    ).toEqual({ ok: false, code: 'CONFIRM_EXPIRED' });
    // action が分からないものは記録しない
    await executeAction(c, { server: a, action: 'nope', confirmToken: 'x' });
    const r = await rows(db);
    expect(r.map((x) => [x.event, x.status, x.error_code, x.confirm_nonce, x.server_id])).toEqual([
      ['broadcast', 'failed', 'CAPABILITY_MISSING', null, Number(a)],
      ['kick', 'failed', 'CONFIRM_INVALID', null, Number(a)],
      ['kick', 'failed', 'CONFIRM_EXPIRED', null, Number(a)],
    ]);
    expect(r[1]?.target_steam_id).toBe(PLAYER.steamId);
    expect(r.every((x) => typeof x.finished_at === 'number')).toBe(true);
    expect(hostCalls.filter((x) => x.includes('/broadcast') || x.endsWith('/kick'))).toHaveLength(0);
  });

  it('D1 に pending を書けなければ実行しない(INTERNAL_ERROR)', async () => {
    const { db, c, a } = await setup();
    const p = await prepareAction(c, { server: a, action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    await db.prepare('DROP TABLE audit_log').run();
    expect(await executeAction(c, { server: a, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken })).toEqual({
      ok: false,
      code: 'INTERNAL_ERROR',
    });
    expect(hostCalls.filter((x) => x.endsWith('/kick'))).toHaveLength(0);
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
    const timeoutFetch: FetchFn = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/capabilities') return Response.json({ routes: ['GET /v1/players', 'POST /v1/players/{steamId}/kick'] });
      if (path === '/v1/players') return Response.json({ players: [PLAYER], count: 1 });
      if (path === '/v1/status') return Response.json({ serverName: 'x', players: { current: 1, max: 8 } });
      // 書き込みは応答せず、タイムアウトの abort を待つ
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const { db, c, a } = await setup();
    const tc = { ...c, deps: { fetchFn: timeoutFetch, log: () => undefined } };
    const p = await prepareAction(tc, { server: a, action: 'kick', params: { steamId: PLAYER.steamId } });
    if (!p.ok) throw new Error('prepare failed');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let e: Awaited<ReturnType<typeof executeAction>>;
    try {
      let done = false;
      const pending = executeAction(tc, { server: a, action: 'kick', params: p.data.params, confirmToken: p.data.confirmToken }).then((r) => {
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
  it('server が無い・形式不正(default を含む)の prepare / execute は VALIDATION_FAILED(記録しない)。無い id は SERVER_NOT_FOUND', async () => {
    const { db, c } = await setup();
    expect(await prepareAction(c, { action: 'kick', params: { steamId: PLAYER.steamId } })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      opts: { fields: { server: 'required' } },
    });
    for (const server of ['01', 'default']) {
      expect(await prepareAction(c, { server, action: 'kick', params: { steamId: PLAYER.steamId } })).toMatchObject({
        opts: { fields: { server: 'invalid_format' } },
      });
    }
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
  });

  it('server_id が NULL の書き込み行(複数サーバー対応前)は serverId: null。login / logout も null', async () => {
    const { db } = await setup();
    await db
      .prepare(
        `INSERT INTO audit_log (created_at, event, status, params_json) VALUES (1, 'broadcast', 'succeeded', '{}'), (2, 'login', 'succeeded', '{}')`,
      )
      .run();
    const { entries } = await listAudit(db, { limit: 10, before: null });
    expect(entries.map((e) => [e.event, e.serverId])).toEqual([
      ['login', null],
      ['broadcast', null],
    ]);
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
    const r = (await db.prepare('SELECT server_id, error_code FROM audit_log ORDER BY id').all()).results;
    expect(r).toEqual([
      { server_id: Number(a), error_code: 'CONFIRM_INVALID' },
      { server_id: Number(a), error_code: 'SERVER_DISABLED' },
      { server_id: Number(a), error_code: 'CONFIRM_INVALID' },
    ]);
  });
});
