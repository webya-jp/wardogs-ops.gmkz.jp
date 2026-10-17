// キルフィードの正規化(対応表の各候補・長い整数・外側の形 4 種・自殺・incomplete・1 バッチの上限・診断)。docs/ARCHITECTURE.md 17.10.2。
// プレイヤー名は架空、Steam ID は 0 始まり(または 1 始まり)の 17 桁のダミー(実在の SteamID64 の形式ではない)。
import { describe, expect, it } from 'vitest';
import { KILL_FIELD_NAMES, KILLFEED_MAX_KILLS_PER_BATCH } from '../../types/api';
import { KILL_FIELD_CANDIDATES } from './fields';
import { normalizeFeedBatch, normalizeFeedEvent, parseFeedJson, quoteBigIntegers } from './normalize';

const T = 1_792_000_000_000;
const ID_A = '00000000000777601';
const ID_B = '00000000000777602';
const ev = (v: unknown) => normalizeFeedEvent(v, { index: 0, receivedAt: T });

describe('長い整数(K-10)', () => {
  it('文字列の外の 16 桁以上の整数だけを引用符で囲む(小数・指数・負数・0 始まり・文字列の中は囲まない)', () => {
    const src = '{"a":12345678901234567,"b":"98765432109876543","c":1234567890123456.5,"d":1e20,"e":-12345678901234567,"f":123456789012345,"g":"x\\"12345678901234567"}';
    const q = quoteBigIntegers(src);
    expect(q.count).toBe(1);
    const v = JSON.parse(q.text) as Record<string, unknown>;
    expect(v.a).toBe('12345678901234567');
    expect(v.b).toBe('98765432109876543');
    expect(typeof v.c).toBe('number');
    expect(typeof v.d).toBe('number');
    expect(typeof v.e).toBe('number');
    expect(v.f).toBe(123456789012345);
    expect(v.g).toBe('x"12345678901234567');
  });

  it('数値の Steam ID を桁落ちさせずに読む。JSON でなければ ok: false', () => {
    const r = normalizeFeedBatch(`[{"type":"killed","killer":{"name":"TestPlayerA","steamId":10000000000777601},"victim":{"steamId":"${ID_B}"}}]`, { receivedAt: T });
    expect(r?.bigIntegersQuoted).toBe(1);
    expect(r?.kills[0]?.killer?.steamId).toBe('10000000000777601');
    expect(parseFeedJson('{bad').ok).toBe(false);
    expect(normalizeFeedBatch('[1,', { receivedAt: T })).toBeNull();
  });
});

describe('外側の形', () => {
  const kill = { type: 'killed', victim: { name: 'TestPlayerB' } };
  it('array / events / single / unknown。オブジェクトでない要素は invalid', () => {
    expect(normalizeFeedBatch(JSON.stringify([kill, 1, 'x']), { receivedAt: T })).toMatchObject({ envelope: 'array', counts: { kill: 1, invalid: 2 } });
    expect(normalizeFeedBatch(JSON.stringify({ events: [kill, kill] }), { receivedAt: T })).toMatchObject({ envelope: 'events', counts: { kill: 2 } });
    expect(normalizeFeedBatch(JSON.stringify(kill), { receivedAt: T })).toMatchObject({ envelope: 'single', counts: { kill: 1 } });
    expect(normalizeFeedBatch(JSON.stringify({ foo: 1 }), { receivedAt: T })).toMatchObject({ envelope: 'unknown', kills: [] });
    expect(normalizeFeedBatch('42', { receivedAt: T })).toMatchObject({ envelope: 'unknown' });
  });
});

describe('種類の判定', () => {
  it('KILL_EVENT_TYPES(英数字以外を除いて小文字)は kill、それ以外は other。種類が無ければ被害者が読めるときだけ kill', () => {
    for (const t of ['killed', 'Kill', 'player_killed', 'DEATH', 'player-died']) expect(ev({ type: t, victim: { name: 'X' } }).result).toBe('kill');
    expect(ev({ type: 'test_unknown_event', foo: 1 }).result).toBe('other');
    expect(ev({ victim: { name: 'X' } }).result).toBe('kill');
    expect(ev({ foo: 1 }).result).toBe('other');
    expect(ev({ type: 'killed', a: 1 }).result).toBe('incomplete');
    expect(ev(null).result).toBe('invalid');
  });
});

describe('対応表の各候補', () => {
  // 各候補を 1 つだけ含むイベントで、その項目が取れること(被害者は常に入れる)
  const sample: Record<string, unknown> = {
    type: 'killed',
    eventAt: '2026-10-17T00:00:00Z',
    gameTimeSec: 3151,
    killerName: 'TestPlayerA',
    killerSteamId: ID_A,
    killerFaction: 'Blue',
    victimName: 'TestPlayerB',
    victimSteamId: ID_B,
    victimFaction: 'Red',
    weaponId: 'WEPN_031',
    weaponName: 'Test Rifle',
    vehicleId: 'TNK_01',
    vehicleName: 'Test Tank',
    distanceM: 12,
    headshot: true,
    penetration: true,
    roadkill: true,
    vehicleExplosion: true,
    suicide: true,
    flagList: ['HEADSHOT'],
  };
  const receivedAt = Date.parse('2026-10-17T00:00:05Z');

  function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const segs = path.split('.');
    let cur = obj;
    for (const seg of segs.slice(0, -1)) {
      if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1] as string] = value;
  }

  for (const field of KILL_FIELD_NAMES) {
    for (const c of KILL_FIELD_CANDIDATES[field]) {
      const path = typeof c === 'string' ? c : c.path;
      it(`${field} ← ${path}`, () => {
        const e: Record<string, unknown> = {};
        let value = sample[field];
        if (typeof c !== 'string' && c.scale) value = 1200; // cm
        setPath(e, path, value);
        // 当事者が無いと incomplete になるので、別の経路で被害者を足す(対象の項目と重ならないキー)
        if (!field.startsWith('victim') && !path.startsWith('victim') && path !== 'killed' && path !== 'target' && path !== 'dead' && path !== 'player') {
          e.victim_name = 'TestPlayerB';
        }
        if (field.startsWith('victim') && field !== 'victimName' && field !== 'victimSteamId') e.killerName = 'TestPlayerA';
        const r = normalizeFeedEvent(e, { index: 0, receivedAt });
        expect(r.matched[field]).toBe(path);
      });
    }
  }

  it('当事者のキーそのものが文字列: 17 桁は Steam ID、それ以外は名前', () => {
    const r = ev({ type: 'killed', killer: ID_A, victim: 'TestPlayerB' });
    expect(r.kill?.killer).toEqual({ name: null, steamId: ID_A, faction: null, factionSource: null });
    expect(r.kill?.victim?.name).toBe('TestPlayerB');
  });

  it('値の検証: Steam ID の形式・距離の範囲と丸め・cm・時刻の範囲・ゲーム内時刻の文字列・真偽の表記・名前の切り詰め', () => {
    const r = ev({
      type: 'killed',
      killer: { name: `A${'x'.repeat(100)}\u0007`, steamId: '123', id: ID_A, team: 2 },
      victim: { name: '  TestPlayerB  ' },
      distance: '37.26',
      timestamp: T + 2 * 24 * 3600 * 1000,
      time: Math.floor(T / 1000),
      gameTime: '52:31',
      isHeadshot: 'true',
      penetration: 1,
      roadkill: 'yes',
    });
    expect(r.kill?.killer?.steamId).toBe(ID_A);
    expect(r.matched.killerSteamId).toBe('killer.id');
    expect(Array.from(r.kill?.killer?.name ?? '').length).toBe(64);
    expect(r.kill?.killer?.faction).toBe('2');
    expect(r.kill?.victim?.name).toBe('TestPlayerB');
    expect(r.kill?.distanceM).toBe(37.3);
    expect(r.kill?.eventAt).toBe(Math.floor(T / 1000) * 1000);
    expect(r.matched.eventAt).toBe('time');
    expect(r.kill?.gameTimeSec).toBe(52 * 60 + 31);
    expect(r.kill?.flags).toMatchObject({ headshot: true, penetration: true, roadkill: false });
    expect(ev({ type: 'killed', victim: { name: 'X' }, distanceCm: 4210 }).kill?.distanceM).toBe(42.1);
    expect(ev({ type: 'killed', victim: { name: 'X' }, distance: -1 }).kill?.distanceM).toBeNull();
    expect(ev({ type: 'killed', victim: { name: 'X' }, distance: 1e9 }).kill?.distanceM).toBeNull();
  });

  it('flagList(配列・区切り文字列)は個別の真偽と OR。WALLBANG は penetration', () => {
    const r = ev({ type: 'killed', victim: { name: 'X' }, tags: 'roadkill, wallbang|vehicle_explosion', headshot: true });
    expect(r.kill?.flags).toEqual({ headshot: true, penetration: true, roadkill: true, vehicleExplosion: true, suicide: false });
  });
});

describe('組み立て', () => {
  it('自殺: 印、または両者の Steam ID が同じ。killer は残す', () => {
    const same = ev({ type: 'killed', killer: { name: 'TestPlayerA', steamId: ID_A }, victim: { name: 'TestPlayerA', steamId: ID_A } });
    expect(same.kill?.flags.suicide).toBe(true);
    expect(same.kill?.killer?.steamId).toBe(ID_A);
    expect(ev({ type: 'killed', victim: { name: 'X' }, suicide: true }).kill?.flags.suicide).toBe(true);
  });

  it('当事者は名前か Steam ID があるときだけ。陣営は本文にあれば factionSource = event。乗り物が無ければ null', () => {
    const r = ev({ type: 'killed', killer: { faction: 'Blue' }, victim: { name: 'TestPlayerB', faction: 'Red' }, cause: 'Test Fall' });
    expect(r.kill?.killer).toBeNull();
    expect(r.kill?.victim).toEqual({ name: 'TestPlayerB', steamId: null, faction: 'Red', factionSource: 'event' });
    expect(r.kill?.weapon).toEqual({ id: null, name: 'Test Fall' });
    expect(r.kill?.vehicle).toBeNull();
  });

  it('1 バッチは先頭から 100 件まで。超えた分は droppedKills', () => {
    const list = Array.from({ length: KILLFEED_MAX_KILLS_PER_BATCH + 5 }, () => ({ type: 'killed', victim: { name: 'X' } }));
    const r = normalizeFeedBatch(JSON.stringify(list), { receivedAt: T });
    expect(r?.kills.length).toBe(KILLFEED_MAX_KILLS_PER_BATCH);
    expect(r?.droppedKills).toBe(5);
    expect(r?.counts.kill).toBe(KILLFEED_MAX_KILLS_PER_BATCH + 5);
  });

  it('診断: matched と unmappedKeys(値は含めない)。受信の処理(diagnostics なし)では作らない', () => {
    const body = JSON.stringify([{ type: 'killed', victim: { name: 'X' }, weird: 'secret-value', other: { a: 1 } }]);
    const d = normalizeFeedBatch(body, { receivedAt: T, diagnostics: true });
    expect(d?.diagnostics?.[0]?.matched).toEqual({ type: 'type', victimName: 'victim.name' });
    expect(d?.diagnostics?.[0]?.unmappedKeys).toEqual(['weird', 'other']);
    expect(JSON.stringify(d?.diagnostics)).not.toContain('secret-value');
    expect(normalizeFeedBatch(body, { receivedAt: T })?.diagnostics).toBeUndefined();
  });
});
