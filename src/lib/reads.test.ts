// /api/status の組み立て(/v1/status + /v1/rotation のキャッシュ)。接続先・パスワードはダミー。
import { beforeEach, describe, expect, it } from 'vitest';
import type { FetchFn } from './rcon/client';
import { resetCapabilitiesForTest } from './rcon/capabilities';
import { invalidateRotation, readStatus, resetRotationForTest, ROTATION_FAIL_TTL_MS, ROTATION_TTL_MS } from './reads';
import type { ResolvedServer } from './servers';

const T = 1_800_000_000_000;

function server(id: string, host = 'rcon.example.com'): ResolvedServer {
  return { id, auditServerId: Number(id), name: `S${id}`, rcon: { baseUrl: `http://${host}:7777`, password: 'dummy-password-0000' } };
}

interface Mock {
  fetchFn: FetchFn;
  calls: string[];
  set: (o: Partial<{ routes: string[]; rotation: () => Response; status: unknown }>) => void;
}

function mock(): Mock {
  const calls: string[] = [];
  let routes = ['GET /v1/status', 'GET /v1/rotation'];
  let rotation = (): Response => Response.json({ enabled: true, mode: 'm', entries: [{ map: 'a', displayName: 'A' }, { map: 'b' }] });
  let status: unknown = { serverName: 'S', map: 'a', experiences: ['x'], players: { current: 1, max: 8 }, rotation: { nowIndex: 0, nextIndex: 0 } };
  const fetchFn: FetchFn = async (url) => {
    const u = new URL(url);
    calls.push(`${u.hostname}${u.pathname}`);
    if (u.pathname === '/v1/capabilities') return Response.json({ routes });
    if (u.pathname === '/v1/status') return Response.json(status);
    if (u.pathname === '/v1/rotation') return rotation();
    return new Response('{}', { status: 404 });
  };
  return {
    fetchFn,
    calls,
    set: (o) => {
      if (o.routes) routes = o.routes;
      if (o.rotation) rotation = o.rotation;
      if (o.status !== undefined) status = o.status;
    },
  };
}

const count = (m: Mock, path: string) => m.calls.filter((c) => c.endsWith(path)).length;
const ROT = '/v1/rotation';

beforeEach(() => {
  resetCapabilitiesForTest();
  resetRotationForTest();
});

describe('readStatus', () => {
  it('rotation があれば count・nextMap・nextMapName を補い、experiences を返す', async () => {
    const m = mock();
    const r = await readStatus(server('1'), { fetchFn: m.fetchFn, log: () => undefined, now: T });
    expect(r.ok && r.data.rotation).toEqual({ nowIndex: 0, nextIndex: 0, count: 2, nextMap: 'a', nextMapName: 'A' });
    expect(r.ok && r.data.experiences).toEqual(['x']);
  });

  it('capabilities の routes に GET /v1/rotation が無ければ呼ばない(unavailable でも呼ばない)', async () => {
    const m = mock();
    m.set({ routes: ['GET /v1/status'] });
    const r = await readStatus(server('1'), { fetchFn: m.fetchFn, log: () => undefined, now: T });
    expect(r.ok && r.data.rotation).toMatchObject({ count: null, nextMap: null, nextMapName: null });
    expect(count(m, ROT)).toBe(0);

    resetCapabilitiesForTest();
    m.set({ routes: [] });
    const u = await readStatus(server('1'), { fetchFn: m.fetchFn, log: () => undefined, now: T });
    expect(u.ok).toBe(true);
    expect(count(m, ROT)).toBe(0);
  });

  it('成功は 300 秒キャッシュ(サーバーごと)、invalidateRotation で破棄', async () => {
    const m = mock();
    const d = { fetchFn: m.fetchFn, log: () => undefined };
    await readStatus(server('1'), { ...d, now: T });
    await readStatus(server('1'), { ...d, now: T + ROTATION_TTL_MS - 1 });
    expect(count(m, ROT)).toBe(1);
    await readStatus(server('2', 'rcon2.example.com'), { ...d, now: T });
    expect(count(m, ROT)).toBe(2);
    // 次のマップは毎回 /v1/status の nextIndex から求める(キャッシュするのは entries だけ)
    m.set({ status: { rotation: { nowIndex: 0, nextIndex: 1 } } });
    const r = await readStatus(server('1'), { ...d, now: T + 1 });
    expect(r.ok && r.data.rotation).toMatchObject({ nextMap: 'b', nextMapName: null });
    expect(count(m, ROT)).toBe(2);
    invalidateRotation('1');
    await readStatus(server('1'), { ...d, now: T + 2 });
    await readStatus(server('2', 'rcon2.example.com'), { ...d, now: T + 2 });
    expect(count(m, ROT)).toBe(3);
    await readStatus(server('1'), { ...d, now: T + ROTATION_TTL_MS + 3 });
    expect(count(m, ROT)).toBe(4);
  });

  it('失敗(500・形式不正・enabled: false)でも status は成功、3 項目は null。失敗は 60 秒キャッシュ', async () => {
    const m = mock();
    const d = { fetchFn: m.fetchFn, log: () => undefined };
    m.set({ rotation: () => new Response('{}', { status: 500 }) });
    const r = await readStatus(server('1'), { ...d, now: T });
    expect(r.ok && r.data.rotation).toEqual({ nowIndex: 0, nextIndex: 0, count: null, nextMap: null, nextMapName: null });
    await readStatus(server('1'), { ...d, now: T + ROTATION_FAIL_TTL_MS - 1 });
    expect(count(m, ROT)).toBe(1);

    m.set({ rotation: () => Response.json({ entries: 'nope' }) });
    const bad = await readStatus(server('1'), { ...d, now: T + ROTATION_FAIL_TTL_MS });
    expect(count(m, ROT)).toBe(2);
    expect(bad.ok && bad.data.rotation.count).toBeNull();

    m.set({ rotation: () => Response.json({ enabled: false, entries: [{ map: 'a' }] }) });
    const off = await readStatus(server('1'), { ...d, now: T + 2 * ROTATION_FAIL_TTL_MS });
    expect(count(m, ROT)).toBe(3);
    expect(off.ok && off.data.rotation).toMatchObject({ count: null, nextMap: null });
  });

  it('/v1/status 自体の失敗はそのまま返す(rotation は呼ばない)', async () => {
    const m = mock();
    m.set({ status: 'not an object' });
    const r = await readStatus(server('1'), { fetchFn: m.fetchFn, log: () => undefined, now: T });
    expect(r).toEqual({ ok: false, code: 'RCON_BAD_RESPONSE', opts: {} });
    expect(count(m, ROT)).toBe(0);
  });
});
