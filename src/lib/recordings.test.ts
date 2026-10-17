// スコア記録: 開始・停止の二段階(record_start / record_stop)、Cron のサンプル・終了条件・二重実行、保持数、一覧。
// D1 は node:sqlite で 0001〜0003 を適用したもの。ホスト名・パスワードはダミーだけを使う。docs/ARCHITECTURE.md 17.2・17.3・17.5・17.7。
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_ACTIVE_RECORDINGS, RECORDING_EMPTY_END_MS, RECORDING_MAX_DURATION_MS } from '../types/api';
import type { MatchesResponse, RecordingExecuteResponse, RecordingPrepareResponse } from '../types/api';
import { executeAction, prepareAction } from './actions';
import type { ActionContext } from './actions';
import { listSettingsAudit } from './audit';
import { isCleanupMinute, runCron, runCleanup } from './cron';
import type { CronSummary } from './cron';
import type { FetchFn } from './rcon/client';
import { resetCapabilitiesForTest } from './rcon/capabilities';
import { resetRotationForTest } from './reads';
import { buildSample, effectiveScoreCap, getMatchSamples, listMatches } from './recordings';
import { createServer, deleteServer, resetServersForTest, updateServer } from './servers';
import type { MutationContext } from './servers';
import { testKeys } from './testing/keys';
import { makeD1 } from './testing/sqlite-d1';

const SID = 'AAAAAAAAAAAAAAAAAAAAAA';
// 2026-10-17T00:00:00Z 付近の固定時刻(分の境界)
const T0 = Math.floor(1_792_000_000_000 / 60_000) * 60_000;

interface MockState {
  map: string;
  scores: { faction: string; score: number }[];
  current: number;
  scoreCap?: number;
  statusFails?: boolean;
  playersFails?: boolean;
  calls: string[];
}

function mockFetch(st: Record<string, MockState>): FetchFn {
  return async (url) => {
    const u = new URL(url);
    const s = st[u.hostname];
    if (!s) return new Response('{}', { status: 404 });
    s.calls.push(u.pathname);
    if (u.pathname === '/v1/status') {
      if (s.statusFails) return new Response('{}', { status: 500 });
      return Response.json({
        serverName: 'mock',
        map: s.map,
        players: { current: s.current, max: 64 },
        factionScores: s.scores,
        ...(s.scoreCap === undefined ? {} : { scoreCap: s.scoreCap }),
      });
    }
    if (u.pathname === '/v1/players') {
      if (s.playersFails) return new Response('{}', { status: 404 });
      return Response.json({
        players: [
          { name: 'P1', steamId: '00000000000000001', faction: 'Blue', cash: 100 },
          { name: 'P2', steamId: '00000000000000002', faction: 'Red', cash: 50 },
          { name: 'P3', steamId: '00000000000000003', faction: 'Blue', cash: 25 },
          { name: 'P4', steamId: '00000000000000004', faction: 'Red' },
        ],
      });
    }
    if (u.pathname === '/v1/capabilities') return Response.json({ routes: ['GET /v1/status', 'POST /v1/match/end', 'POST /v1/match/map'] });
    if (u.pathname === '/v1/match/end') return Response.json({ ok: true });
    return new Response('{}', { status: 404 });
  };
}

function state(over: Partial<MockState> = {}): MockState {
  return { map: 'mock_map_alpha', scores: [{ faction: 'Blue', score: 10 }, { faction: 'Red', score: 5 }], current: 4, calls: [], ...over };
}

interface Setup {
  db: D1Database;
  c: ActionContext;
  m: MutationContext;
  st: Record<string, MockState>;
  key: CryptoKey;
  a: string;
  b: string;
}

async function setup(): Promise<Setup> {
  const db = await makeD1();
  const keys = await testKeys();
  const st: Record<string, MockState> = { 'rcon-a.example.com': state(), 'rcon-b.example.com': state({ map: 'mock_map_bravo' }) };
  const deps = { fetchFn: mockFetch(st), log: () => undefined };
  const c: ActionContext = {
    keys,
    servers: { db, key: keys.serverPassword },
    session: { aid: 1, sid: SID, iat: 0, exp: 0, operator: 'op' },
    db,
    ipHash: null,
    deps,
  };
  const m: MutationContext = { sctx: c.servers, actor: { operator: 'op', sessionTag: 'AAAAAAAA', ipHash: null }, deps };
  const a = await createServer(m, { name: 'Server A', host: 'rcon-a.example.com', port: 7777, password: 'x'.repeat(24) });
  const b = await createServer(m, { name: 'Server B', host: 'rcon-b.example.com', port: 7777, password: 'y'.repeat(24) });
  if (!a.ok || !b.ok) throw new Error('create failed');
  for (const s of Object.values(st)) s.calls.length = 0;
  return { db, c, m, st, key: keys.serverPassword, a: a.data.server.id, b: b.data.server.id };
}

async function start(s: Setup, server: string, now = T0): Promise<RecordingExecuteResponse> {
  const c = { ...s.c, now };
  const p = await prepareAction(c, { server, action: 'record_start', params: {} });
  if (!p.ok) throw new Error(`prepare ${p.code}`);
  const e = await executeAction(c, { server, action: 'record_start', params: {}, confirmToken: p.data.confirmToken });
  if (!e.ok) throw new Error(`execute ${e.code}`);
  return e.data as RecordingExecuteResponse;
}

const cron = (s: Setup, t: number): Promise<CronSummary> =>
  runCron({ DB: s.db }, t, { fetchFn: mockFetch(s.st), log: () => undefined, serverKey: s.key, logSummary: () => undefined });

const sampleCount = async (db: D1Database, id: string) =>
  Number((await db.prepare('SELECT COUNT(*) AS n FROM match_samples WHERE recording_id = ?1').bind(Number(id)).first<{ n: number }>())?.n);

const matchRow = async (db: D1Database, id: string) =>
  db.prepare('SELECT status, end_reason, empty_since, score_cap, score_cap_source, last_scores_json FROM match_recordings WHERE id = ?1').bind(Number(id)).first<Record<string, unknown>>();

const settingsEvents = async (db: D1Database) =>
  ((await db.prepare('SELECT event, operator, params_json, confirm_nonce FROM settings_audit_log ORDER BY id').all()).results as Record<string, unknown>[]).filter(
    (r) => String(r.event).startsWith('record_'),
  );

beforeEach(() => {
  resetCapabilitiesForTest();
  resetRotationForTest();
  resetServersForTest();
});

describe('上限とサンプル', () => {
  it('上限の優先順位: status.scoreCap(正の数)→ サーバーの設定 → 既定 100', () => {
    expect(effectiveScoreCap(250, 50)).toEqual({ cap: 250, source: 'status' });
    expect(effectiveScoreCap(0, 50)).toEqual({ cap: 50, source: 'setting' });
    expect(effectiveScoreCap(null, null)).toEqual({ cap: 100, source: 'default' });
    expect(effectiveScoreCap(-1, undefined)).toEqual({ cap: 100, source: 'default' });
  });

  it('陣営別の人数・cash と合計(名前・Steam ID は入れない)。players が取れなければ null / 空', () => {
    const status = {
      serverName: 'S', map: 'M', players: { current: 3, max: 8 }, factionScores: [{ faction: 'A', score: 1 }],
      rotation: { nowIndex: null, nextIndex: null }, experiences: [], fetchedAt: 0,
    };
    const s = buildSample(status, [{ faction: 'A', cash: 10 }, { faction: 'B', cash: null }, { faction: 'A', cash: 5 }], 1);
    expect(s.cashTotal).toBe(15);
    expect(s.factions).toEqual([{ faction: 'A', players: 2, cash: 15 }, { faction: 'B', players: 1, cash: null }]);
    expect(JSON.stringify(s)).not.toMatch(/steamId|name/);
    const n = buildSample(status, null, 1);
    expect(n.cashTotal).toBeNull();
    expect(n.factions).toEqual([]);
  });
});

describe('record_start / record_stop(二段階)', () => {
  it('開始: 記録・最初のサンプル・record_start を 1 つの batch で作る。nonce は 1 回限り', async () => {
    const s = await setup();
    const c = { ...s.c, now: T0 };
    const p = await prepareAction(c, { server: s.a, action: 'record_start', params: { extra: 1 } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const pd = p.data as RecordingPrepareResponse;
    expect(pd).toMatchObject({ action: 'record_start', params: {}, destructive: false, server: s.a, map: 'mock_map_alpha', scoreCap: 100, scoreCapSource: 'default', match: null });
    // capabilities は呼ばない
    expect(s.st['rcon-a.example.com']!.calls).toEqual(['/v1/status']);

    const body = { server: s.a, action: 'record_start', params: {}, confirmToken: pd.confirmToken };
    const e = await executeAction(c, body);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const ed = e.data as RecordingExecuteResponse;
    expect(ed).toMatchObject({ auditKind: 'settings', action: 'record_start', server: s.a });
    expect(ed.match).toMatchObject({ status: 'recording', map: 'mock_map_alpha', sampleCount: 1, scoreCap: 100, endReason: null });
    expect(ed.match.lastScores).toEqual([{ faction: 'Blue', score: 10 }, { faction: 'Red', score: 5 }]);
    const ev = await settingsEvents(s.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event: 'record_start', operator: 'op' });
    expect(JSON.parse(String(ev[0]!.params_json))).toEqual({ recordingId: ed.match.id, map: 'mock_map_alpha' });
    expect(ev[0]!.confirm_nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // 同じトークンの再送は ALREADY_EXECUTED(記録中でも)
    expect(await executeAction(c, body)).toMatchObject({ ok: false, code: 'ALREADY_EXECUTED' });
    // 記録中のサーバーで開始の prepare は拒否
    expect(await prepareAction(c, { server: s.a, action: 'record_start', params: {} })).toMatchObject({ ok: false, code: 'RECORDING_ALREADY_ACTIVE' });

    const audit = await listSettingsAudit(s.db, { limit: 10, before: null });
    expect(audit.entries[0]).toMatchObject({ event: 'record_start', status: 'succeeded', errorCode: null, serverId: s.a });
  });

  it('並行した 2 本の開始は部分 UNIQUE 索引で 1 本だけ通る(RECORDING_ALREADY_ACTIVE)', async () => {
    const s = await setup();
    const c = { ...s.c, now: T0 };
    const p1 = await prepareAction(c, { server: s.a, action: 'record_start', params: {} });
    const p2 = await prepareAction(c, { server: s.a, action: 'record_start', params: {} });
    if (!p1.ok || !p2.ok) throw new Error('prepare');
    expect((await executeAction(c, { server: s.a, action: 'record_start', params: {}, confirmToken: p1.data.confirmToken })).ok).toBe(true);
    expect(await executeAction(c, { server: s.a, action: 'record_start', params: {}, confirmToken: p2.data.confirmToken })).toMatchObject({
      ok: false,
      code: 'RECORDING_ALREADY_ACTIVE',
    });
    expect(await settingsEvents(s.db)).toHaveLength(1);
  });

  it('RCON の status が失敗したら記録を始めず、記録もしない(同じトークンでやり直せる)', async () => {
    const s = await setup();
    const c = { ...s.c, now: T0 };
    const p = await prepareAction(c, { server: s.a, action: 'record_start', params: {} });
    if (!p.ok) throw new Error('prepare');
    s.st['rcon-a.example.com']!.statusFails = true;
    const body = { server: s.a, action: 'record_start', params: {}, confirmToken: p.data.confirmToken };
    expect(await executeAction(c, body)).toMatchObject({ ok: false, code: 'RCON_ERROR' });
    expect(await settingsEvents(s.db)).toHaveLength(0);
    s.st['rcon-a.example.com']!.statusFails = false;
    expect((await executeAction(c, body)).ok).toBe(true);
  });

  it('players が取れなくても開始する(cash は null、陣営別は空)', async () => {
    const s = await setup();
    s.st['rcon-a.example.com']!.playersFails = true;
    const r = await start(s, s.a);
    const samples = await getMatchSamples(s.db, r.match.id, s.a);
    expect(samples?.samples[0]).toMatchObject({ cashTotal: null, factions: [] });
  });

  it('トークンの検証(別のサーバー・別の操作・改ざん)は CONFIRM_INVALID、期限切れは CONFIRM_EXPIRED。いずれも記録しない', async () => {
    const s = await setup();
    const c = { ...s.c, now: T0 };
    const p = await prepareAction(c, { server: s.a, action: 'record_start', params: {} });
    if (!p.ok) throw new Error('prepare');
    const tok = p.data.confirmToken;
    expect(await executeAction(c, { server: s.b, action: 'record_start', params: {}, confirmToken: tok })).toMatchObject({ code: 'CONFIRM_INVALID' });
    expect(await executeAction(c, { server: s.a, action: 'record_stop', params: { recordingId: '1' }, confirmToken: tok })).toMatchObject({
      code: 'CONFIRM_INVALID',
    });
    // 書き込み操作のトークンとして使う(action の系列が違う)
    expect(await executeAction(c, { server: s.a, action: 'match_end', params: {}, confirmToken: tok })).toMatchObject({ code: 'CONFIRM_INVALID' });
    expect(await executeAction({ ...c, now: T0 + 121_000 }, { server: s.a, action: 'record_start', params: {}, confirmToken: tok })).toMatchObject({
      code: 'CONFIRM_EXPIRED',
    });
    expect(await settingsEvents(s.db)).toHaveLength(0);
  });

  it('形式不正の recordingId は 400、server の省略は 400', async () => {
    const s = await setup();
    expect(await prepareAction(s.c, { server: s.a, action: 'record_stop', params: { recordingId: 'x' } })).toMatchObject({
      code: 'VALIDATION_FAILED',
      opts: { fields: { recordingId: 'invalid_format' } },
    });
    expect(await prepareAction(s.c, { action: 'record_start', params: {} })).toMatchObject({
      code: 'VALIDATION_FAILED',
      opts: { fields: { server: 'required' } },
    });
  });

  it('全体の上限(MAX_ACTIVE_RECORDINGS)で RECORDING_LIMIT_REACHED', async () => {
    const s = await setup();
    for (let i = 0; i < MAX_ACTIVE_RECORDINGS; i++) {
      await s.db
        .prepare(`INSERT INTO match_recordings (server_id, status, started_at, score_cap, score_cap_source, created_at, updated_at) VALUES (?1, 'recording', 0, 100, 'default', 0, 0)`)
        .bind(100 + i)
        .run();
    }
    expect(await prepareAction(s.c, { server: s.a, action: 'record_start', params: {} })).toMatchObject({ ok: false, code: 'RECORDING_LIMIT_REACHED' });
  });

  it('停止: manual で終え、record_stop を書く。別の試合・既に終わった試合は RECORDING_NOT_ACTIVE', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    const c = { ...s.c, now: T0 + 90_000 };
    expect(await prepareAction(c, { server: s.b, action: 'record_stop', params: { recordingId: r.match.id } })).toMatchObject({
      code: 'RECORDING_NOT_ACTIVE',
    });
    const p = await prepareAction(c, { server: s.a, action: 'record_stop', params: { recordingId: r.match.id } });
    if (!p.ok) throw new Error('prepare');
    expect((p.data as RecordingPrepareResponse).match).toMatchObject({ id: r.match.id, status: 'recording' });
    const p2 = await prepareAction(c, { server: s.a, action: 'record_stop', params: { recordingId: r.match.id } });
    if (!p2.ok) throw new Error('prepare');
    const e = await executeAction(c, { server: s.a, action: 'record_stop', params: { recordingId: r.match.id }, confirmToken: p.data.confirmToken });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect((e.data as RecordingExecuteResponse).match).toMatchObject({ status: 'ended', endReason: 'manual', endedAt: T0 + 90_000 });
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'ended', end_reason: 'manual' });
    // 2 本目のトークンは「既に終わった」
    expect(
      await executeAction(c, { server: s.a, action: 'record_stop', params: { recordingId: r.match.id }, confirmToken: p2.data.confirmToken }),
    ).toMatchObject({ code: 'RECORDING_NOT_ACTIVE' });
    expect((await settingsEvents(s.db)).map((x) => x.event)).toEqual(['record_start', 'record_stop']);
  });

  it('このパネルの match_end が成功したら記録中の試合を match_action で終える', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    const c = { ...s.c, now: T0 + 30_000 };
    const p = await prepareAction(c, { server: s.a, action: 'match_end', params: {} });
    if (!p.ok) throw new Error(`prepare ${p.code}`);
    const e = await executeAction(c, { server: s.a, action: 'match_end', params: {}, confirmToken: p.data.confirmToken });
    expect(e).toMatchObject({ ok: true, data: { auditKind: 'operations' } });
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'ended', end_reason: 'match_action' });
    const ev = await settingsEvents(s.db);
    expect(ev.map((x) => x.event)).toEqual(['record_start', 'record_end']);
    expect(ev[1]).toMatchObject({ operator: null });
    expect(JSON.parse(String(ev[1]!.params_json))).toEqual({ recordingId: r.match.id, reason: 'match_action' });
  });
});

describe('Cron', () => {
  it('記録中が無ければ RCON を呼ばない', async () => {
    const s = await setup();
    const sum = await cron(s, T0);
    expect(sum).toMatchObject({ recordings: 0, sampled: 0, ended: 0 });
    expect(s.st['rcon-a.example.com']!.calls).toEqual([]);
  });

  it('同じ分に 2 回動いてもサンプルは 1 分 1 行。次の分で 1 行増える', async () => {
    const s = await setup();
    const r = await start(s, s.a, T0 + 5_000);
    expect(await sampleCount(s.db, r.match.id)).toBe(1);
    // 開始と同じ分の Cron は主キーで無視される
    await cron(s, T0);
    expect(await sampleCount(s.db, r.match.id)).toBe(1);
    await Promise.all([cron(s, T0 + 60_000), cron(s, T0 + 60_000)]);
    expect(await sampleCount(s.db, r.match.id)).toBe(2);
    const samples = await getMatchSamples(s.db, r.match.id, s.a);
    expect(samples?.samples[1]).toMatchObject({
      at: T0 + 60_000,
      cashTotal: 175,
      factions: [
        { faction: 'Blue', players: 2, cash: 125 },
        { faction: 'Red', players: 2, cash: 50 },
      ],
    });
  });

  it('上限到達で score_cap。二重実行でも record_end は 1 行', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    s.st['rcon-a.example.com']!.scores = [{ faction: 'Blue', score: 100 }, { faction: 'Red', score: 40 }];
    const [x, y] = await Promise.all([cron(s, T0 + 60_000), cron(s, T0 + 60_000)]);
    expect(x.ended + y.ended).toBe(1);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'ended', end_reason: 'score_cap' });
    const row = await matchRow(s.db, r.match.id);
    expect(JSON.parse(String(row?.last_scores_json))).toEqual([{ faction: 'Blue', score: 100 }, { faction: 'Red', score: 40 }]);
    expect((await settingsEvents(s.db)).filter((e) => e.event === 'record_end')).toHaveLength(1);
    // 終了後は RCON を呼ばない
    s.st['rcon-a.example.com']!.calls.length = 0;
    await cron(s, T0 + 120_000);
    expect(s.st['rcon-a.example.com']!.calls).toEqual([]);
  });

  it('status.scoreCap があればそれを使い、記録の上限と出所を更新する。設定値は status が無いときに効く', async () => {
    const s = await setup();
    await updateServer(s.m, s.a, { scoreCap: 30 });
    const r = await start(s, s.a);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ score_cap: 30, score_cap_source: 'setting' });
    s.st['rcon-a.example.com']!.scoreCap = 500;
    s.st['rcon-a.example.com']!.scores = [{ faction: 'Blue', score: 40 }];
    await cron(s, T0 + 60_000);
    // 40 >= 30 だが status の 500 が優先されるので終わらない
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'recording', score_cap: 500, score_cap_source: 'status' });
    delete s.st['rcon-a.example.com']!.scoreCap;
    await cron(s, T0 + 120_000);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'ended', end_reason: 'score_cap', score_cap: 30, score_cap_source: 'setting' });
  });

  it('マップが変わったら map_changed(そのサンプルは保存しない)', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    s.st['rcon-a.example.com']!.map = 'mock_map_charlie';
    await cron(s, T0 + 60_000);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'ended', end_reason: 'map_changed' });
    expect(await sampleCount(s.db, r.match.id)).toBe(1);
  });

  it('人数 0 が 10 分続いたら empty。途中で人が来たら empty_since を戻す', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    const st = s.st['rcon-a.example.com']!;
    st.current = 0;
    await cron(s, T0 + 60_000);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'recording', empty_since: T0 + 60_000 });
    st.current = 2;
    await cron(s, T0 + 120_000);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'recording', empty_since: null });
    st.current = 0;
    await cron(s, T0 + 180_000);
    await cron(s, T0 + 180_000 + RECORDING_EMPTY_END_MS - 60_000);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'recording' });
    await cron(s, T0 + 180_000 + RECORDING_EMPTY_END_MS);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'ended', end_reason: 'empty' });
  });

  it('開始から 3 時間で max_duration(RCON は呼ばない)', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    s.st['rcon-a.example.com']!.calls.length = 0;
    await cron(s, T0 + RECORDING_MAX_DURATION_MS);
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'ended', end_reason: 'max_duration' });
    expect(s.st['rcon-a.example.com']!.calls).toEqual([]);
  });

  it('RCON に届かない分は何もしない(終えない・サンプルを足さない)', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    s.st['rcon-a.example.com']!.statusFails = true;
    const sum = await cron(s, T0 + 60_000);
    expect(sum.failures).toEqual({ RCON_ERROR: 1 });
    expect(await matchRow(s.db, r.match.id)).toMatchObject({ status: 'recording' });
    expect(await sampleCount(s.db, r.match.id)).toBe(1);
  });

  it('サーバーの無効化・削除で server_unavailable。1 台の失敗で他の台を止めない', async () => {
    const s = await setup();
    const ra = await start(s, s.a);
    const rb = await start(s, s.b);
    await updateServer(s.m, s.a, { enabled: false });
    const sum = await cron(s, T0 + 60_000);
    expect(sum).toMatchObject({ recordings: 2, ended: 1, sampled: 1 });
    expect(await matchRow(s.db, ra.match.id)).toMatchObject({ status: 'ended', end_reason: 'server_unavailable' });
    expect(await matchRow(s.db, rb.match.id)).toMatchObject({ status: 'recording' });
    // 削除しても記録は消えない(次の Cron が終える)
    expect((await deleteServer(s.m, s.b, { confirmName: 'Server B' })).ok).toBe(true);
    expect(await matchRow(s.db, rb.match.id)).toMatchObject({ status: 'recording' });
    await cron(s, T0 + 120_000);
    expect(await matchRow(s.db, rb.match.id)).toMatchObject({ status: 'ended', end_reason: 'server_unavailable' });
  });

  it('D1 が無い・0003 未適用なら何もせずに終える(例外を投げない)', async () => {
    expect(await runCron({}, T0, { logSummary: () => undefined })).toMatchObject({ failures: { D1_UNAVAILABLE: 1 } });
    const old = await makeD1({ migrations: ['0001_init.sql', '0002_servers.sql'] });
    expect(await runCron({ DB: old }, T0, { logSummary: () => undefined })).toMatchObject({ failures: { D1_UNAVAILABLE: 1 } });
  });

  it('毎時 17 分だけ掃除する', () => {
    expect(isCleanupMinute(Date.UTC(2026, 9, 17, 3, 17, 0))).toBe(true);
    expect(isCleanupMinute(Date.UTC(2026, 9, 17, 3, 18, 0))).toBe(false);
  });
});

describe('保持と一覧', () => {
  it('終了済みはサーバーごとに 5 試合まで(6 試合目を終えると最も古い試合をサンプルごと削除)', async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = T0 + i * 600_000;
      const r = await start(s, s.a, t);
      ids.push(r.match.id);
      const c = { ...s.c, now: t + 60_000 };
      const p = await prepareAction(c, { server: s.a, action: 'record_stop', params: { recordingId: r.match.id } });
      if (!p.ok) throw new Error('prepare');
      expect((await executeAction(c, { server: s.a, action: 'record_stop', params: { recordingId: r.match.id }, confirmToken: p.data.confirmToken })).ok).toBe(true);
    }
    expect(await matchRow(s.db, ids[0]!)).toBeNull();
    expect(await sampleCount(s.db, ids[0]!)).toBe(0);
    const list: MatchesResponse = await listMatches(s.db, s.a);
    expect(list.matches.map((m) => m.id)).toEqual(ids.slice(1).reverse());
    expect(list).toMatchObject({ activeLimit: MAX_ACTIVE_RECORDINGS, activeCount: 0 });
  });

  it('一覧: 記録中が先頭。別のサーバーの試合の samples は null(MATCH_NOT_FOUND)。削除済みのサーバーは 0 件', async () => {
    const s = await setup();
    const r = await start(s, s.a);
    const list = await listMatches(s.db, s.a);
    expect(list.matches[0]).toMatchObject({ id: r.match.id, status: 'recording', sampleCount: 1, lastSampleAt: T0 });
    expect(list.activeCount).toBe(1);
    expect(await getMatchSamples(s.db, r.match.id, s.b)).toBeNull();
    expect(await getMatchSamples(s.db, r.match.id, null)).not.toBeNull();
    expect((await listMatches(s.db, '999')).matches).toEqual([]);
  });

  it('毎時の掃除: 30 日より古い終了済みの試合と所属の無いサンプル、7 日より古い生データ、8 日より前の日次カウンタ、サーバーの無い受信設定', async () => {
    const s = await setup();
    const now = T0 + 40 * 86_400_000;
    const db = s.db;
    await db.prepare(`INSERT INTO match_recordings (id, server_id, status, started_at, ended_at, end_reason, score_cap, score_cap_source, created_at, updated_at)
                      VALUES (50, 1, 'ended', ?1, ?1, 'manual', 100, 'default', ?1, ?1)`).bind(T0).run();
    await db.prepare(`INSERT INTO match_samples (recording_id, bucket_minute, taken_at) VALUES (50, 1, 1), (77, 1, 1)`).run();
    await db.prepare(`INSERT INTO feed_raw_events (server_id, received_at, bytes, body) VALUES (1, ?1, 2, '[]'), (1, ?2, 2, '[]')`).bind(now - 8 * 86_400_000, now).run();
    await db.prepare(`INSERT INTO feed_daily (server_id, day, batches, bytes) VALUES (1, ?1, 1, 1), (1, ?2, 1, 1)`).bind(Math.floor(now / 86_400_000) - 9, Math.floor(now / 86_400_000)).run();
    await db.prepare(`INSERT INTO server_feeds (server_id, token_hash, token_hint, token_created_at, created_at, updated_at) VALUES (99, 'sha256$x', 'abcd', 0, 0, 0)`).run();
    await runCleanup(db, now);
    const n = async (sql: string) => Number((await db.prepare(sql).first<{ n: number }>())?.n);
    expect(await n('SELECT COUNT(*) AS n FROM match_recordings')).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM match_samples')).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM feed_raw_events')).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM feed_daily')).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM server_feeds')).toBe(0);
  });
});

describe('サーバーのスコア上限の設定', () => {
  it('scoreCap の検証(整数 1〜100,000、null で既定)と変更ログ', async () => {
    const s = await setup();
    expect(await updateServer(s.m, s.a, { scoreCap: 0 })).toMatchObject({ ok: false, opts: { fields: { scoreCap: 'out_of_range' } } });
    expect(await updateServer(s.m, s.a, { scoreCap: 1.5 })).toMatchObject({ ok: false, opts: { fields: { scoreCap: 'invalid_format' } } });
    expect(await updateServer(s.m, s.a, { scoreCap: '50' })).toMatchObject({ ok: false, opts: { fields: { scoreCap: 'invalid_format' } } });
    const r = await updateServer(s.m, s.a, { scoreCap: 50 });
    expect(r).toMatchObject({ ok: true, data: { server: { scoreCap: 50, feedConfigured: false }, test: null } });
    const back = await updateServer(s.m, s.a, { scoreCap: null });
    expect(back).toMatchObject({ ok: true, data: { server: { scoreCap: null } } });
    const logs = (await s.db.prepare(`SELECT params_json FROM settings_audit_log WHERE event = 'server_update' ORDER BY id`).all()).results as { params_json: string }[];
    expect(logs.map((l) => JSON.parse(l.params_json).scoreCap)).toEqual([50, null]);
  });
});

describe('陣営の付与用の観測(roster_json。キルフィード第 2 段階 17.10.4)', () => {
  it('開始時と Cron のサンプルに Steam ID → 陣営の添字だけを書く(名前は入れない)。players が取れなければ NULL', async () => {
    const s = await setup();
    const started = await start(s, s.a);
    const id = Number(started.match.id);
    const rosters = async () =>
      ((await s.db.prepare('SELECT roster_json FROM match_samples WHERE recording_id = ?1 ORDER BY bucket_minute').bind(id).all()).results as { roster_json: string | null }[]).map(
        (r) => r.roster_json,
      );
    const expected = { f: ['Blue', 'Red'], p: { '00000000000000001': 0, '00000000000000002': 1, '00000000000000003': 0, '00000000000000004': 1 } };
    expect((await rosters()).map((r) => (r === null ? null : JSON.parse(r)))).toEqual([expected]);
    expect((await rosters()).join('')).not.toMatch(/P[1-4]/);
    await cron(s, T0 + 60_000);
    (s.st['rcon-a.example.com'] as MockState).playersFails = true;
    await cron(s, T0 + 120_000);
    const all = await rosters();
    expect(all.length).toBe(3);
    expect(JSON.parse(all[1] ?? 'null')).toEqual(expected);
    expect(all[2]).toBeNull();
  });
});
