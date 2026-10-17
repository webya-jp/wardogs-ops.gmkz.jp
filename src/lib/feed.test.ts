// キルフィード(観測モード): トークンの発行・検証・取り消し、受信の順序と応答、空のバッチ、1 日の上限、受信の状況、生データ。
// D1 は node:sqlite で 0001〜0003 を適用したもの。トークンはテストの中で生成したものだけを使い、値を出力しない。docs/ARCHITECTURE.md 17.6。
import { beforeEach, describe, expect, it } from 'vitest';
import { FEED_DAILY_MAX_BATCHES, FEED_MAX_BODY_BYTES, FEED_RATE_PER_MIN, FEED_TOKEN_PATTERN } from '../types/api';
import { listSettingsAudit } from './audit';
import {
  countEvents,
  getFeedStatus,
  handleIngest,
  hashFeedToken,
  issueFeedToken,
  listFeedRaw,
  parseBearerFeedToken,
  resetFeedForTest,
  revokeFeedToken,
  updateFeedSettings,
  utcDay,
} from './feed';
import type { FeedMutationContext } from './feed';
import { createServer, deleteServer, listServers, resetServersForTest, updateServer } from './servers';
import type { MutationContext } from './servers';
import { testKeys } from './testing/keys';
import { makeD1 } from './testing/sqlite-d1';

const T0 = 1_792_000_000_000;

interface Setup {
  db: D1Database;
  m: MutationContext;
  f: FeedMutationContext;
  a: string;
  b: string;
}

async function setup(): Promise<Setup> {
  const db = await makeD1();
  const keys = await testKeys();
  const deps = { fetchFn: async () => Response.json({ serverName: 'x', players: { current: 0, max: 1 } }), log: () => undefined };
  const m: MutationContext = { sctx: { db, key: keys.serverPassword }, actor: { operator: 'op', sessionTag: 'AAAAAAAA', ipHash: null }, deps };
  const a = await createServer(m, { name: 'Server A', host: 'rcon-a.example.com', port: 7777, password: 'x'.repeat(24) });
  const b = await createServer(m, { name: 'Server B', host: 'rcon-b.example.com', port: 7777, password: 'y'.repeat(24) });
  if (!a.ok || !b.ok) throw new Error('create failed');
  return { db, m, f: { db, actor: m.actor, now: T0 }, a: a.data.server.id, b: b.data.server.id };
}

function req(token: string | null, body: string | null, headers: Record<string, string> = { 'Content-Type': 'application/json' }): Request {
  const h: Record<string, string> = { ...headers };
  if (token !== null) h.Authorization = `Bearer ${token}`;
  return new Request('http://panel.example.com/api/ingest/events', { method: 'POST', headers: h, body });
}

async function ingest(db: D1Database, r: Request, now = T0, logs: unknown[] = []): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const res = await handleIngest(db, r, { now, waitUntil: (p) => pending.push(p), log: (e) => logs.push(e) });
  await Promise.all(pending);
  return res;
}

const rawCount = async (db: D1Database) => Number((await db.prepare('SELECT COUNT(*) AS n FROM feed_raw_events').first<{ n: number }>())?.n);

async function issue(s: Setup, server: string): Promise<string> {
  const r = await issueFeedToken(s.f, server);
  if (!r.ok) throw new Error(r.code);
  return r.data.token;
}

beforeEach(() => {
  resetFeedForTest();
  resetServersForTest();
});

describe('トークン', () => {
  it('形式 wof1.<ServerId>.<43 文字>。D1 には SHA-256 のハッシュと末尾 4 文字だけ。値は応答でだけ返し、変更ログに入れない', async () => {
    const s = await setup();
    const r = await issueFeedToken(s.f, s.a);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { token } = r.data;
    expect(FEED_TOKEN_PATTERN.test(token)).toBe(true);
    expect(token.startsWith(`wof1.${s.a}.`)).toBe(true);
    expect(r.data).toMatchObject({ tokenHint: token.slice(-4), reissued: false, status: { configured: true, enabled: true, tokenHint: token.slice(-4) } });
    const row = await s.db.prepare('SELECT * FROM server_feeds WHERE server_id = ?1').bind(Number(s.a)).first<Record<string, unknown>>();
    expect(row?.token_hash).toBe(await hashFeedToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    // 状態の応答にトークン・ハッシュを含めない
    const st = await getFeedStatus(s.db, s.a, T0);
    expect(JSON.stringify(st)).not.toContain(token);
    expect(JSON.stringify(st)).not.toContain(String(row?.token_hash));
    // 変更ログ
    const logs = JSON.stringify((await s.db.prepare('SELECT * FROM settings_audit_log').all()).results);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(String(row?.token_hash));
    const audit = await listSettingsAudit(s.db, { limit: 5, before: null });
    expect(audit.entries[0]).toMatchObject({ event: 'feed_token_issue', status: 'succeeded', params: { reissued: false }, serverId: s.a });
    // 一覧の feedConfigured
    const list = await listServers(s.m.sctx);
    expect(list.servers.map((x) => x.feedConfigured)).toEqual([true, false]);
  });

  it('Bearer の形式(大文字小文字・空白・別サーバー形式)', () => {
    expect(parseBearerFeedToken(null)).toBeNull();
    expect(parseBearerFeedToken('Bearer wof1.3.short')).toBeNull();
    expect(parseBearerFeedToken(`Basic wof1.3.${'A'.repeat(43)}`)).toBeNull();
    expect(parseBearerFeedToken(`Bearer wof1.0.${'A'.repeat(43)}`)).toBeNull();
    expect(parseBearerFeedToken(`bearer wof1.3.${'A'.repeat(43)}`)).toMatchObject({ server: '3' });
  });

  it('存在しないサーバーは 404、形式不正は 400', async () => {
    const s = await setup();
    expect(await issueFeedToken(s.f, '999')).toMatchObject({ ok: false, code: 'SERVER_NOT_FOUND' });
    expect(await issueFeedToken(s.f, 'default')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await getFeedStatus(s.db, '999')).toMatchObject({ ok: false, code: 'SERVER_NOT_FOUND' });
  });
});

describe('受信(POST /api/ingest/events)', () => {
  it('正しいトークン → 204 で保存。誤ったトークン・形式不正・トークン無し → 401(WWW-Authenticate)。空のバッチは 204 で D1 に書かない', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    const body = JSON.stringify([{ type: 'killed', killer: 'dummy-a', victim: 'dummy-b' }]);

    const ok = await ingest(s.db, req(token, body));
    expect(ok.status).toBe(204);
    expect(await rawCount(s.db)).toBe(1);

    const wrong = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const t of [wrong, `wof1.${s.b}.${'A'.repeat(43)}`, 'not-a-token', null]) {
      const res = await ingest(s.db, req(t, body), T0 + 1);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
      const j = (await res.json()) as { error: { code: string } };
      expect(j.error.code).toBe('FEED_TOKEN_INVALID');
    }
    expect(await rawCount(s.db)).toBe(1);

    // 空のバッチ(本文が空・[]・events が空配列)
    const before = Number((await s.db.prepare('SELECT batches AS n FROM feed_daily WHERE server_id = ?1').bind(Number(s.a)).first<{ n: number }>())?.n);
    for (const b of ['', '[]', '{"events":[]}', '  ']) {
      expect((await ingest(s.db, req(token, b), T0 + 2)).status).toBe(204);
    }
    expect(await rawCount(s.db)).toBe(1);
    const after = Number((await s.db.prepare('SELECT batches AS n FROM feed_daily WHERE server_id = ?1').bind(Number(s.a)).first<{ n: number }>())?.n);
    expect(after).toBe(before);
  });

  it('既知外の JSON も保存する。event_count は配列 / events の長さ、それ以外は null。受信時に記録中の試合を添える', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    await s.db
      .prepare(`INSERT INTO match_recordings (id, server_id, status, started_at, score_cap, score_cap_source, created_at, updated_at) VALUES (7, ?1, 'recording', 0, 100, 'default', 0, 0)`)
      .bind(Number(s.a))
      .run();
    await ingest(s.db, req(token, '[{"type":"killed"},{"type":"other"}]'));
    await ingest(s.db, req(token, '{"events":[{"type":"killed"}],"x":1}'));
    await ingest(s.db, req(token, '{"unknown":true}'));
    const raw = await listFeedRaw(s.db, { server: s.a, limit: 10, before: null });
    expect(raw.configured).toBe(true);
    expect(raw.entries.map((e) => e.eventCount)).toEqual([null, 1, 2]);
    expect(raw.entries.every((e) => e.matchId === '7')).toBe(true);
    expect(raw.entries[2]?.body).toBe('[{"type":"killed"},{"type":"other"}]');
    // ページ送り
    const p1 = await listFeedRaw(s.db, { server: s.a, limit: 2, before: null });
    expect(p1.nextBefore).not.toBeNull();
    const p2 = await listFeedRaw(s.db, { server: s.a, limit: 2, before: p1.nextBefore });
    expect(p2.entries).toHaveLength(1);
    expect(p2.nextBefore).toBeNull();
    // 削除済み・別サーバーは 0 件
    expect((await listFeedRaw(s.db, { server: '999', limit: 10, before: null })).entries).toEqual([]);
  });

  it('Content-Type・サイズ・JSON の検証(トークンの検証の後)。理由を受信の状況に残す', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    expect((await ingest(s.db, req(token, '[1]', { 'Content-Type': 'text/plain' }))).status).toBe(415);
    expect((await ingest(s.db, req(token, 'x'.repeat(FEED_MAX_BODY_BYTES + 1)), T0 + 61_000)).status).toBe(413);
    expect((await ingest(s.db, req(token, '{bad'), T0 + 122_000)).status).toBe(400);
    expect((await ingest(s.db, req(token, '[1]', { 'Content-Type': 'application/json; charset=utf-8' }), T0 + 183_000)).status).toBe(204);
    expect(await rawCount(s.db)).toBe(1);
    const st = await getFeedStatus(s.db, s.a, T0 + 183_000);
    expect(st).toMatchObject({ ok: true, data: { lastRejectedReason: 'bad_json', lastStoredAt: T0 + 183_000, lastReceivedAt: T0 + 183_000 } });
  });

  it('受信の状況は 1 分に 1 回までしか書かない', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    await ingest(s.db, req(token, '[]'), T0);
    await ingest(s.db, req(token, '[]'), T0 + 10_000);
    let st = await getFeedStatus(s.db, s.a, T0);
    expect(st).toMatchObject({ data: { lastReceivedAt: T0 } });
    await ingest(s.db, req(token, '[]'), T0 + 61_000);
    st = await getFeedStatus(s.db, s.a, T0);
    expect(st).toMatchObject({ data: { lastReceivedAt: T0 + 61_000 } });
  });

  it('1 分 90 回を超えたら 429(Retry-After)。数えるのはトークンの検証の後', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    // 不一致のトークンは正しいサーバーの枠を使わない
    for (let i = 0; i < 100; i++) await ingest(s.db, req(`wof1.${s.a}.${'B'.repeat(43)}`, '[]'), T0);
    for (let i = 0; i < FEED_RATE_PER_MIN; i++) expect((await ingest(s.db, req(token, '[]'), T0 + i)).status).toBe(204);
    const r = await ingest(s.db, req(token, '[]'), T0 + 100);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await ingest(s.db, req(token, '[]'), T0 + 60_000)).status).toBe(204);
  });

  it('保存を止めている・サーバーが無効なら 204 で捨てる(理由を残す)', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    expect(await updateFeedSettings(s.f, s.a, { enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect((await ingest(s.db, req(token, '[1]'))).status).toBe(204);
    expect(await rawCount(s.db)).toBe(0);
    expect(await getFeedStatus(s.db, s.a)).toMatchObject({ data: { lastDroppedReason: 'disabled' } });
    await updateFeedSettings(s.f, s.a, { enabled: true });
    await updateServer(s.m, s.a, { enabled: false });
    resetFeedForTest();
    expect((await ingest(s.db, req(token, '[1]'), T0 + 61_000)).status).toBe(204);
    expect(await rawCount(s.db)).toBe(0);
    expect(await getFeedStatus(s.db, s.a)).toMatchObject({ data: { lastDroppedReason: 'server_unusable' } });
  });

  it('1 日の上限(サーバーごと)で 204 のまま捨てる。日が変わると戻る', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    await s.db
      .prepare('INSERT INTO feed_daily (server_id, day, batches, bytes) VALUES (?1, ?2, ?3, 0)')
      .bind(Number(s.a), utcDay(T0), FEED_DAILY_MAX_BATCHES)
      .run();
    expect((await ingest(s.db, req(token, '[1]'))).status).toBe(204);
    expect(await rawCount(s.db)).toBe(0);
    expect(await getFeedStatus(s.db, s.a, T0)).toMatchObject({ data: { lastDroppedReason: 'daily_limit', today: { batches: FEED_DAILY_MAX_BATCHES } } });
    expect((await ingest(s.db, req(token, '[1]'), T0 + 86_400_000)).status).toBe(204);
    expect(await rawCount(s.db)).toBe(1);
  });

  it('全体の上限(server_id = 0)で global_limit', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    await s.db.prepare('INSERT INTO feed_daily (server_id, day, batches, bytes) VALUES (0, ?1, 4000, 0)').bind(utcDay(T0)).run();
    expect((await ingest(s.db, req(token, '[1]'))).status).toBe(204);
    expect(await rawCount(s.db)).toBe(0);
    expect(await getFeedStatus(s.db, s.a, T0)).toMatchObject({ data: { lastDroppedReason: 'global_limit' } });
  });

  it('再発行で古いトークンは使えない。取り消し後は 401(この isolate では即時)。取り消しは冪等で、行があったときだけ記録', async () => {
    const s = await setup();
    const t1 = await issue(s, s.a);
    const re = await issueFeedToken(s.f, s.a);
    if (!re.ok) throw new Error(re.code);
    expect(re.data.reissued).toBe(true);
    expect((await ingest(s.db, req(t1, '[1]'))).status).toBe(401);
    expect((await ingest(s.db, req(re.data.token, '[1]'))).status).toBe(204);
    expect(await revokeFeedToken(s.f, s.a)).toMatchObject({ ok: true, data: { configured: false, today: { batches: 0, bytes: 0 } } });
    expect((await ingest(s.db, req(re.data.token, '[1]'))).status).toBe(401);
    expect((await revokeFeedToken(s.f, s.a)).ok).toBe(true);
    const ev = ((await s.db.prepare(`SELECT event FROM settings_audit_log WHERE event LIKE 'feed_%' ORDER BY id`).all()).results as { event: string }[]).map((r) => r.event);
    expect(ev).toEqual(['feed_token_issue', 'feed_token_issue', 'feed_token_revoke']);
    // 取り消し後も生データは返す(configured: false)
    const raw = await listFeedRaw(s.db, { server: s.a, limit: 10, before: null });
    expect(raw).toMatchObject({ configured: false });
    expect(raw.entries).toHaveLength(1);
  });

  it('PUT feed: 未発行は 404 NOT_FOUND、enabled が真偽でなければ 400、変化が無ければ記録しない', async () => {
    const s = await setup();
    expect(await updateFeedSettings(s.f, s.a, { enabled: false })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    await issue(s, s.a);
    expect(await updateFeedSettings(s.f, s.a, { enabled: 'no' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', opts: { fields: { enabled: 'invalid_format' } } });
    await updateFeedSettings(s.f, s.a, { enabled: true });
    await updateFeedSettings(s.f, s.a, { enabled: false });
    const ev = ((await s.db.prepare(`SELECT params_json FROM settings_audit_log WHERE event = 'feed_settings_update'`).all()).results as { params_json: string }[]);
    expect(ev.map((e) => JSON.parse(e.params_json))).toEqual([{ enabled: false }]);
  });

  it('サーバーの削除で受信設定も消える(以後 401)', async () => {
    const s = await setup();
    const token = await issue(s, s.b);
    expect((await deleteServer(s.m, s.b, { confirmName: 'Server B' })).ok).toBe(true);
    expect(await s.db.prepare('SELECT 1 FROM server_feeds WHERE server_id = ?1').bind(Number(s.b)).first()).toBeNull();
    expect((await ingest(s.db, req(token, '[1]'))).status).toBe(401);
  });

  it('ログにトークン・本文を出さない', async () => {
    const s = await setup();
    const token = await issue(s, s.a);
    const logs: unknown[] = [];
    const secretBody = '[{"type":"killed","name":"dummy-secret-name"}]';
    await ingest(s.db, req(token, secretBody, { 'Content-Type': 'text/plain' }), T0, logs);
    await ingest(s.db, req(`${token.slice(0, -2)}zz`, secretBody), T0, logs);
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(token);
    expect(text).not.toContain('dummy-secret-name');
  });

  it('countEvents', () => {
    expect(countEvents([])).toEqual({ count: 0, empty: true });
    expect(countEvents([1, 2])).toEqual({ count: 2, empty: false });
    expect(countEvents({ events: [] })).toEqual({ count: 0, empty: true });
    expect(countEvents({ a: 1 })).toEqual({ count: null, empty: false });
    expect(countEvents(3)).toEqual({ count: null, empty: false });
  });
});
