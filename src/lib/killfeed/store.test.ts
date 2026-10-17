// キルフィード 第 2 段階: 受信からの保存(feed_kills)、日次の上限、raw_enabled、陣営の付与(roster の鮮度・出所)、
// 一覧と差分、トリガー(試合・サーバーの削除)、記録外の期限切れ、正規化の試行、受信設定の項目。docs/ARCHITECTURE.md 17.10。
// D1 は node:sqlite で 0001〜0004 を適用したもの。プレイヤー名は架空、Steam ID はダミー、トークンはテストの中で生成したものだけ。
import { beforeEach, describe, expect, it } from 'vitest';
import { KILLFEED_DAILY_MAX_KILLS, KILLFEED_GLOBAL_DAILY_MAX_KILLS, KILLFEED_ROSTER_MAX_AGE_MS, KILLFEED_UNRECORDED_RETENTION_DAYS } from '../../types/api';
import type { KillfeedKillsResponse } from '../../types/api';
import { listSettingsAudit } from '../audit';
import { runCleanup } from '../cron';
import { getFeedStatus, handleIngest, issueFeedToken, resetFeedForTest, updateFeedSettings, utcDay } from '../feed';
import type { FeedMutationContext, IngestLogEntry } from '../feed';
import { createServer, deleteServer, resetServersForTest } from '../servers';
import type { MutationContext } from '../servers';
import { testKeys } from '../testing/keys';
import { makeD1 } from '../testing/sqlite-d1';
import { buildRosterJson, listKills, parseKillsQuery, previewRawNormalized, teamkillOf } from './store';

const T0 = Math.floor(1_792_000_000_000 / 60_000) * 60_000;
const ID = (n: number) => `000000000007777${String(n).padStart(2, '0')}`;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Setup {
  db: D1Database;
  m: MutationContext;
  f: FeedMutationContext;
  a: string;
  b: string;
  token: string;
}

async function setup(): Promise<Setup> {
  const db = await makeD1();
  const keys = await testKeys();
  const deps = { fetchFn: async () => Response.json({ serverName: 'x', players: { current: 0, max: 1 } }), log: () => undefined };
  const m: MutationContext = { sctx: { db, key: keys.serverPassword }, actor: { operator: 'op', sessionTag: 'AAAAAAAA', ipHash: null }, deps };
  const a = await createServer(m, { name: 'Server A', host: 'rcon-a.example.com', port: 7777, password: 'x'.repeat(24) });
  const b = await createServer(m, { name: 'Server B', host: 'rcon-b.example.com', port: 7777, password: 'y'.repeat(24) });
  if (!a.ok || !b.ok) throw new Error('create failed');
  const f: FeedMutationContext = { db, actor: m.actor, now: T0 };
  const t = await issueFeedToken(f, a.data.server.id);
  if (!t.ok) throw new Error(t.code);
  return { db, m, f, a: a.data.server.id, b: b.data.server.id, token: t.data.token };
}

async function ingest(s: Setup, body: string, now = T0, logs: IngestLogEntry[] = []): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const r = new Request('http://panel.example.com/api/ingest/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    body,
  });
  const res = await handleIngest(s.db, r, { now, waitUntil: (p) => pending.push(p), log: (e) => logs.push(e) });
  await Promise.all(pending);
  return res;
}

const count = async (db: D1Database, table: string, where = '1 = 1') =>
  Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())?.n);

async function startRecording(db: D1Database, server: string, at = T0): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO match_recordings (server_id, server_name, status, started_at, map, score_cap, score_cap_source, created_at, updated_at)
       VALUES (?1, 'Server', 'recording', ?2, 'mock_map_alpha', 100, 'default', ?2, ?2) RETURNING id`,
    )
    .bind(Number(server), at)
    .first<{ id: number }>();
  return Number(r?.id);
}

async function addSample(db: D1Database, recordingId: number, takenAt: number, roster: string | null, scores = '[{"faction":"Red","score":3},{"faction":"Blue","score":2}]') {
  await db
    .prepare(
      `INSERT INTO match_samples (recording_id, bucket_minute, taken_at, map, players_current, players_max, faction_scores_json, cash_total, faction_stats_json, roster_json)
       VALUES (?1, ?2, ?3, 'mock_map_alpha', 4, 64, ?4, NULL, '[]', ?5)`,
    )
    .bind(recordingId, Math.floor(takenAt / 60_000), takenAt, scores, roster)
    .run();
}

const kill = (killer: number | null, victim: number, extra: Record<string, unknown> = {}) => ({
  type: 'killed',
  ...(killer === null ? {} : { killer: { name: `TestPlayer${killer}`, steamId: ID(killer) } }),
  victim: { name: `TestPlayer${victim}`, steamId: ID(victim) },
  ...extra,
});

async function list(s: Setup, server: string, match: string, after?: string): Promise<KillfeedKillsResponse> {
  const q = parseKillsQuery(new URL(`http://x/api/killfeed/kills?server=${server}&match=${match}${after ? `&after=${after}` : ''}`));
  if (!q.ok) throw new Error('query');
  const r = await listKills(s.db, q, utcDay(T0));
  if (r === 'not_found') throw new Error('not_found');
  return r;
}

beforeEach(() => {
  resetFeedForTest();
  resetServersForTest();
});

describe('受信からの保存', () => {
  it('キルを feed_kills に 1 キル 1 行。キル以外・読めないキルは保存せず件数だけ(1 分ごとに feed_daily へ)。ログは件数だけ', async () => {
    const s = await setup();
    const logs: IngestLogEntry[] = [];
    const body = JSON.stringify([
      kill(1, 2, { weapon: { id: 'WEPN_031', name: 'Test Rifle' }, distanceM: 37.2, headshot: true }),
      kill(3, 4, { vehicle: { id: 'TNK_01', name: 'Test Tank' }, tags: 'ROADKILL' }),
      { type: 'test_unknown_event', foo: 1 },
      { type: 'killed', a: 1 },
    ]);
    expect((await ingest(s, body, T0, logs)).status).toBe(204);
    expect(await count(s.db, 'feed_kills')).toBe(2);
    expect(await count(s.db, 'feed_raw_events')).toBe(1);
    const r = await list(s, s.a, 'unrecorded');
    expect(r.kills.map((k) => k.killer?.name)).toEqual(['TestPlayer1', 'TestPlayer3']);
    expect(r.kills[0]).toMatchObject({ weapon: { id: 'WEPN_031', name: 'Test Rifle' }, distanceM: 37.2, flags: { headshot: true }, teamkill: null });
    expect(r.kills[1]).toMatchObject({ vehicle: { id: 'TNK_01', name: 'Test Tank' }, flags: { roadkill: true } });
    // 1 回目の受信で件数も書かれる(受信の状況の更新と同じ機会)
    expect(r.today).toEqual({ kills: 2, otherEvents: 1, incomplete: 1, droppedKills: 0 });
    // 2 回目(1 分未満)は件数を溜めるだけ
    await ingest(s, JSON.stringify([{ type: 'test_unknown_event' }]), T0 + 2000);
    expect((await list(s, s.a, 'unrecorded')).today.otherEvents).toBe(1);
    await ingest(s, '[]', T0 + 61_000);
    expect((await list(s, s.a, 'unrecorded')).today.otherEvents).toBe(2);
    expect(JSON.stringify(logs)).not.toMatch(/TestPlayer|0000000000077/);
  });

  it('raw_enabled = false: 生データは書かずキルだけ保存。PUT の rawEnabled の検証と変更ログ(変えたときだけ rawEnabled を入れる)', async () => {
    const s = await setup();
    expect(await updateFeedSettings(s.f, s.a, { enabled: true, rawEnabled: 'no' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { rawEnabled: 'invalid_format' } } });
    const u = await updateFeedSettings(s.f, s.a, { enabled: true, rawEnabled: false });
    expect(u.ok && u.data.rawEnabled).toBe(false);
    // rawEnabled 省略は変えない・変化が無ければ記録しない
    const u2 = await updateFeedSettings(s.f, s.a, { enabled: true });
    expect(u2.ok && u2.data.rawEnabled).toBe(false);
    const audit = await listSettingsAudit(s.db, { limit: 10, before: null });
    const updates = audit.entries.filter((e) => e.event === 'feed_settings_update');
    expect(updates.map((e) => e.params)).toEqual([{ enabled: true, rawEnabled: false }]);

    expect((await ingest(s, JSON.stringify([kill(1, 2)]))).status).toBe(204);
    expect(await count(s.db, 'feed_raw_events')).toBe(0);
    expect(await count(s.db, 'feed_kills')).toBe(1);
    const st = await getFeedStatus(s.db, s.a, T0);
    expect(st.ok && st.data).toMatchObject({ rawEnabled: false, killsToday: { kills: 1 }, today: { batches: 0 }, killLimits: { dailyKills: KILLFEED_DAILY_MAX_KILLS } });
    expect(st.ok && st.data.lastStoredAt).toBe(T0);
  });

  it('生データの 1 日の上限はキルの保存を止めない', async () => {
    const s = await setup();
    await s.db.prepare('INSERT INTO feed_daily (server_id, day, batches, bytes) VALUES (?1, ?2, 1000, 0)').bind(Number(s.a), utcDay(T0)).run();
    await ingest(s, JSON.stringify([kill(1, 2)]));
    expect(await count(s.db, 'feed_raw_events')).toBe(0);
    expect(await count(s.db, 'feed_kills')).toBe(1);
    const st = await getFeedStatus(s.db, s.a, T0);
    expect(st.ok && st.data.lastDroppedReason).toBe('daily_limit');
  });

  it('キルの日次の上限(サーバー・全体): 超えるバッチは全部捨てて droppedKills に数える', async () => {
    const s = await setup();
    const day = utcDay(T0);
    await s.db.prepare('INSERT INTO feed_daily (server_id, day, kills) VALUES (?1, ?2, ?3)').bind(Number(s.a), day, KILLFEED_DAILY_MAX_KILLS - 1).run();
    await ingest(s, JSON.stringify([kill(1, 2), kill(2, 3)]));
    expect(await count(s.db, 'feed_kills')).toBe(0);
    let r = await list(s, s.a, 'unrecorded');
    expect(r.today).toMatchObject({ kills: KILLFEED_DAILY_MAX_KILLS - 1, droppedKills: 2 });
    // 1 件なら入る
    await ingest(s, JSON.stringify([kill(1, 2)]), T0 + 61_000);
    expect(await count(s.db, 'feed_kills')).toBe(1);
    // 全体
    await s.db.prepare('UPDATE feed_daily SET kills = 0 WHERE server_id = ?1').bind(Number(s.a)).run();
    await s.db.prepare('UPDATE feed_daily SET kills = ?2 WHERE server_id = 0 AND day = ?1').bind(day, KILLFEED_GLOBAL_DAILY_MAX_KILLS).run();
    await ingest(s, JSON.stringify([kill(1, 2)]), T0 + 122_000);
    expect(await count(s.db, 'feed_kills')).toBe(1);
    r = await list(s, s.a, 'unrecorded');
    expect(r.today.droppedKills).toBe(3);
  });

  it('保存を止めている(enabled = false)ときはキルも保存しない', async () => {
    const s = await setup();
    await updateFeedSettings(s.f, s.a, { enabled: false });
    await ingest(s, JSON.stringify([kill(1, 2)]));
    expect(await count(s.db, 'feed_kills')).toBe(0);
  });
});

describe('陣営の付与とチームキル', () => {
  const roster = JSON.stringify({ f: ['Blue', 'Red'], p: { [ID(1)]: 0, [ID(2)]: 1, [ID(3)]: 0 } });

  it('記録中の試合の最後のサンプルの roster(3 分以内)から陣営を付ける。同じ出所で同じ陣営ならチームキル', async () => {
    const s = await setup();
    const rid = await startRecording(s.db, s.a, T0 - 120_000);
    await addSample(s.db, rid, T0 - 120_000, roster);
    await ingest(s, JSON.stringify([kill(1, 2), kill(1, 3), kill(1, 9)]));
    const r = await list(s, s.a, String(rid));
    expect(r.match?.id).toBe(String(rid));
    expect(r.kills.map((k) => [k.killer?.faction, k.killer?.factionSource, k.victim?.faction, k.teamkill])).toEqual([
      ['Blue', 'roster', 'Red', false],
      ['Blue', 'roster', 'Blue', true],
      ['Blue', 'roster', null, null],
    ]);
    // 陣営の順: 最後のサンプルの factionScores の順 → キルに現れた順
    expect(r.factions).toEqual(['Red', 'Blue']);
    expect(await count(s.db, 'feed_kills', 'recording_id = 0')).toBe(0);
  });

  it('roster が 3 分より古い・記録外なら陣営は不明', async () => {
    const s = await setup();
    const rid = await startRecording(s.db, s.a, T0 - 10 * 60_000);
    await addSample(s.db, rid, T0 - KILLFEED_ROSTER_MAX_AGE_MS - 1000, roster);
    await ingest(s, JSON.stringify([kill(1, 2)]));
    const r = await list(s, s.a, String(rid));
    expect(r.kills[0]?.killer?.faction).toBeNull();
    expect(r.kills[0]?.teamkill).toBeNull();
  });

  it('イベントの陣営は event、roster の陣営は roster。出所が違えば teamkill = null', async () => {
    const s = await setup();
    const rid = await startRecording(s.db, s.a, T0 - 60_000);
    await addSample(s.db, rid, T0 - 60_000, roster);
    await ingest(s, JSON.stringify([{ type: 'killed', killer: { name: 'TestPlayer1', steamId: ID(1), faction: 'Blue' }, victim: { name: 'TestPlayer3', steamId: ID(3) } }]));
    const k = (await list(s, s.a, String(rid))).kills[0];
    expect([k?.killer?.factionSource, k?.victim?.factionSource, k?.teamkill]).toEqual(['event', 'roster', null]);
    expect(teamkillOf({ killer: { name: null, steamId: ID(1), faction: 'A', factionSource: 'event' }, victim: { name: null, steamId: ID(1), faction: 'A', factionSource: 'event' }, flags: { headshot: false, penetration: false, roadkill: false, vehicleExplosion: false, suicide: true } })).toBeNull();
  });

  it('buildRosterJson: 名前は入れない。Steam ID と陣営の両方が分かる人だけ。誰もいなければ null', () => {
    const json = buildRosterJson([
      { faction: 'Blue', cash: 1, steamId: ID(1) },
      { faction: 'Red', cash: 1, steamId: ID(2) },
      { faction: null, cash: 1, steamId: ID(3) },
      { faction: 'Blue', cash: 1, steamId: 'bad' },
    ]);
    expect(JSON.parse(json ?? '{}')).toEqual({ f: ['Blue', 'Red'], p: { [ID(1)]: 0, [ID(2)]: 1 } });
    expect(buildRosterJson([{ faction: 'Blue', cash: null }])).toBeNull();
    expect(buildRosterJson(null)).toBeNull();
  });
});

describe('一覧と差分', () => {
  it('同じ受信時刻の複数行でも (receivedAt, id) の位置で差分を取る。キルが無ければ after をそのまま返す', async () => {
    const s = await setup();
    await ingest(s, JSON.stringify([kill(1, 2), kill(2, 3), kill(3, 4)]));
    const full = await list(s, s.a, 'unrecorded');
    expect(full.kills.length).toBe(3);
    const second = full.kills[1];
    if (!second) throw new Error('no kill');
    const cur = `${second.receivedAt}-${second.id}`;
    const inc = await list(s, s.a, 'unrecorded', cur);
    expect(inc.incremental).toBe(true);
    expect(inc.kills.map((k) => k.victim?.name)).toEqual(['TestPlayer4']);
    const none = await list(s, s.a, 'unrecorded', full.cursor ?? '');
    expect(none.kills).toEqual([]);
    expect(none.cursor).toBe(full.cursor);
    await ingest(s, JSON.stringify([kill(4, 1)]), T0 + 5000);
    expect((await list(s, s.a, 'unrecorded', full.cursor ?? '')).kills.map((k) => k.victim?.name)).toEqual(['TestPlayer1']);
  });

  it('クエリの検証と、試合が無い・別サーバーの試合は not_found。記録外は新しい方から 500 件を古い順に', async () => {
    const bad = (qs: string) => {
      const r = parseKillsQuery(new URL(`http://x/api/killfeed/kills?${qs}`));
      return r.ok ? null : r.fields;
    };
    expect(bad('match=unrecorded')).toEqual({ server: 'required' });
    expect(bad('server=1')).toEqual({ match: 'required' });
    expect(bad('server=1&match=abc')).toEqual({ match: 'invalid_format' });
    expect(bad('server=1&match=1&after=1-0')).toEqual({ after: 'invalid_format' });
    expect(bad('server=x&match=1&after=xx')).toEqual({ server: 'invalid_format', after: 'invalid_format' });
    const s = await setup();
    const rid = await startRecording(s.db, s.b);
    const q = parseKillsQuery(new URL(`http://x/?server=${s.a}&match=${rid}`));
    if (!q.ok) throw new Error('q');
    expect(await listKills(s.db, q, utcDay(T0))).toBe('not_found');
    const q2 = parseKillsQuery(new URL(`http://x/?server=${s.a}&match=999`));
    if (!q2.ok) throw new Error('q');
    expect(await listKills(s.db, q2, utcDay(T0))).toBe('not_found');
    // 記録外の上限(直接 INSERT で 502 行)
    const rows = Array.from({ length: 502 }, (_, i) => `(${Number(s.a)}, 0, ${T0 + i}, 'V${i}')`).join(',');
    await s.db.prepare(`INSERT INTO feed_kills (server_id, recording_id, received_at, victim_name) VALUES ${rows}`).run();
    const r = await list(s, s.a, 'unrecorded');
    expect(r.truncated).toBe(true);
    expect(r.kills.length).toBe(500);
    expect(r.kills[0]?.victim?.name).toBe('V2');
    expect(r.kills[499]?.victim?.name).toBe('V501');
    expect(r.match).toBeNull();
    // 削除済みのサーバーの id は 0 件
    expect((await list(s, '99', 'unrecorded')).kills).toEqual([]);
  });
});

describe('保持(トリガー・期限切れ)', () => {
  it('試合の削除でその試合のキルが消え、サーバーの削除で記録外のキルが消える(試合に属するキルは残る)', async () => {
    const s = await setup();
    const rid = await startRecording(s.db, s.a);
    await ingest(s, JSON.stringify([kill(1, 2)]));
    await s.db.prepare(`UPDATE match_recordings SET status = 'ended', ended_at = ?1 WHERE id = ?2`).bind(T0 + 1000, rid).run();
    await ingest(s, JSON.stringify([kill(2, 3)]), T0 + 2000);
    expect(await count(s.db, 'feed_kills', `recording_id = ${rid}`)).toBe(1);
    expect(await count(s.db, 'feed_kills', 'recording_id = 0')).toBe(1);
    const rid2 = await startRecording(s.db, s.a, T0 + 3000);
    await ingest(s, JSON.stringify([kill(3, 4)]), T0 + 4000);
    await s.db.prepare('DELETE FROM match_recordings WHERE id = ?1').bind(rid).run();
    expect(await count(s.db, 'feed_kills', `recording_id = ${rid}`)).toBe(0);
    expect(await count(s.db, 'feed_kills')).toBe(2);
    const del = await deleteServer(s.m, s.a, { confirmName: 'Server A' });
    expect(del.ok).toBe(true);
    expect(await count(s.db, 'feed_kills', 'recording_id = 0')).toBe(0);
    expect(await count(s.db, 'feed_kills', `recording_id = ${rid2}`)).toBe(1);
  });

  it('毎時の掃除: 記録外のキルは 7 日より古いものだけ消す。試合に属するキルは消さない', async () => {
    const s = await setup();
    const old = T0 - KILLFEED_UNRECORDED_RETENTION_DAYS * DAY_MS - 1000;
    const sid = Number(s.a);
    await s.db
      .prepare(`INSERT INTO feed_kills (server_id, recording_id, received_at, victim_name) VALUES (?1, 0, ?2, 'old'), (?1, 0, ?3, 'new'), (?1, 5, ?2, 'match')`)
      .bind(sid, old, T0 - 1000)
      .run();
    await runCleanup(s.db, T0);
    const { results } = await s.db.prepare('SELECT victim_name FROM feed_kills ORDER BY id').all<{ victim_name: string }>();
    expect((results ?? []).map((r) => r.victim_name)).toEqual(['new', 'match']);
  });
});

describe('正規化の試行(GET /api/feed/raw/:id/normalized)', () => {
  it('保存済みの生データに今の対応表で正規化を試す(保存しない)。別サーバー・無い id は null', async () => {
    const s = await setup();
    await ingest(s, `[{"type":"killed","killer":{"name":"TestPlayer1","steamId":10000000000777701},"victim":{"name":"TestPlayer2"},"weird":1},{"type":"x"}]`);
    const raw = await s.db.prepare('SELECT id FROM feed_raw_events').first<{ id: number }>();
    const before = await count(s.db, 'feed_kills');
    const p = await previewRawNormalized(s.db, s.a, Number(raw?.id));
    expect(p).toMatchObject({ envelope: 'array', counts: { kill: 1, other: 1, incomplete: 0, invalid: 0 }, bigIntegersQuoted: 1 });
    expect(p?.events[0]).toMatchObject({ index: 0, type: 'killed', result: 'kill', unmappedKeys: ['weird'] });
    expect(p?.events[0]?.kill?.killer?.steamId).toBe('10000000000777701');
    expect(await count(s.db, 'feed_kills')).toBe(before);
    expect(await previewRawNormalized(s.db, s.b, Number(raw?.id))).toBeNull();
    expect(await previewRawNormalized(s.db, s.a, 9999)).toBeNull();
  });
});
