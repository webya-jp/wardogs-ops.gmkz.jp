import { describe, expect, it } from 'vitest';
import { STATUS_EXPERIENCE_MAX_LENGTH, STATUS_EXPERIENCES_MAX } from '../../types/api';
import {
  applyRotation,
  normalizeBans,
  normalizeExperiences,
  normalizeMaps,
  normalizePlayers,
  normalizeStatus,
  parseBannedAt,
  parseRotation,
} from './normalize';
import { normalizePath, normalizeRouteEntry, parseCapabilities, buildCapabilitiesResponse } from './capabilities';

const T = 1_800_000_000_000;

describe('normalize', () => {
  it('status: 想定の形と、欠けた項目を null にする', () => {
    const s = normalizeStatus(
      {
        serverName: 'S',
        map: 'M',
        players: { current: 3, max: 64 },
        factionScores: [{ faction: 'A', score: 1 }, 5, 'x'],
        rotation: { nowIndex: 0, nextIndex: 1 },
        experiences: [],
      },
      T,
    );
    expect(s).toEqual({
      serverName: 'S',
      map: 'M',
      players: { current: 3, max: 64 },
      factionScores: [
        { faction: 'A', score: 1 },
        { faction: null, score: 5 },
        { faction: null, score: null },
      ],
      rotation: { nowIndex: 0, nextIndex: 1, count: null, nextMap: null, nextMapName: null },
      experiences: [],
      scoreCap: null,
      matchSeconds: null,
      fetchedAt: T,
    });
    expect(normalizeStatus({}, T)?.experiences).toEqual([]);
    expect(normalizeStatus({}, T)?.players).toEqual({ current: null, max: null });
    expect(normalizeStatus('x', T)).toBeNull();
    expect(normalizeStatus([], T)).toBeNull();
  });

  it('players: cash を落とし、数値の Steam ID は安全な整数のときだけ文字列化', () => {
    const p = normalizePlayers(
      {
        players: [
          { name: 'A', steamId: '00000000000000001', faction: 'Blue', kills: 1, deaths: 2, cash: 999, pingMs: 30 },
          { name: 'B', steamId: Number('76561198000000001') },
          'bad',
        ],
        count: 3,
      },
      T,
    );
    expect(p?.count).toBe(2);
    expect(p?.players[0]).toEqual({ steamId: '00000000000000001', name: 'A', faction: 'Blue', kills: 1, deaths: 2, pingMs: 30 });
    expect(p?.players[1]?.steamId).toBe('');
    expect(normalizePlayers({ nope: [] }, T)).toBeNull();
  });

  it('bans: bannedAtUtc を epoch ミリ秒に', () => {
    const b = normalizeBans({ bans: [{ steamId: '00000000000000009', bannedAtUtc: '2026-10-01T12:00:00Z', bannedBy: 'x', reason: 'r' }] }, T);
    expect(b?.bans[0]).toEqual({ steamId: '00000000000000009', bannedAt: Date.UTC(2026, 9, 1, 12), bannedBy: 'x', reason: 'r', knownName: null });
    expect(parseBannedAt('2026-10-01T12:00:00')).toBe(Date.UTC(2026, 9, 1, 12));
    expect(parseBannedAt(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseBannedAt('garbage')).toBeNull();
  });

  it('maps: オブジェクトと文字列の両方', () => {
    expect(normalizeMaps({ maps: [{ id: 'a', displayName: 'A' }, 'b', { name: 'no id' }] }, T)?.maps).toEqual([
      { id: 'a', displayName: 'A' },
      { id: 'b', displayName: null },
    ]);
  });
});

describe('status.experiences', () => {
  it('文字列の要素だけを、上限件数・上限文字数・制御文字除去で', () => {
    expect(normalizeExperiences(['A', 1, null, { x: 1 }, '', 'BC'])).toEqual(['A', 'BC']);
    expect(normalizeExperiences('A')).toEqual([]);
    expect(normalizeExperiences(undefined)).toEqual([]);
    const many = Array.from({ length: STATUS_EXPERIENCES_MAX + 5 }, (_, i) => `e${i}`);
    expect(normalizeExperiences(many)).toHaveLength(STATUS_EXPERIENCES_MAX);
    const [long] = normalizeExperiences(['あ'.repeat(STATUS_EXPERIENCE_MAX_LENGTH + 10)]);
    expect(Array.from(long ?? '')).toHaveLength(STATUS_EXPERIENCE_MAX_LENGTH);
    expect(normalizeStatus({ experiences: ['m'] }, T)?.experiences).toEqual(['m']);
  });
});

describe('rotation', () => {
  const base = { nowIndex: 0, nextIndex: 1, count: null, nextMap: null, nextMapName: null };

  it('{ enabled, mode, entries[] } から count・nextMap・nextMapName', () => {
    const p = parseRotation({ enabled: true, mode: 'x', entries: [{ map: 'a' }, { map: 'b', displayName: 'B' }, 'c'] });
    expect(applyRotation(base, p)).toEqual({ nowIndex: 0, nextIndex: 1, count: 3, nextMap: 'b', nextMapName: 'B' });
    expect(applyRotation({ ...base, nextIndex: 2 }, p)).toMatchObject({ count: 3, nextMap: 'c', nextMapName: null });
    expect(applyRotation({ ...base, nextIndex: 0 }, p)).toMatchObject({ nextMap: 'a', nextMapName: null });
  });

  it('要素の形式の揺れ: map がオブジェクト、mapId / id、表示名のフィールド名', () => {
    const p = parseRotation({ entries: [{ map: { id: 'a', displayName: 'A' } }, { mapId: 'b', mapName: 'B' }, { id: 'c', name: 'C' }] });
    expect(p?.enabled).toBeNull();
    expect(p?.entries).toEqual([
      { map: 'a', displayName: 'A' },
      { map: 'b', displayName: 'B' },
      { map: 'c', displayName: 'C' },
    ]);
  });

  it('解釈できない要素・範囲外・nextIndex なしは nextMap だけ null(count は残す)', () => {
    const p = parseRotation({ enabled: true, entries: [42, null, { map: 7 }, { displayName: 'only name' }] });
    expect(p?.count).toBe(4);
    for (const i of [0, 1, 2, 3, 4, -1]) {
      expect(applyRotation({ ...base, nextIndex: i }, p)).toMatchObject({ count: 4, nextMap: null, nextMapName: null });
    }
    expect(applyRotation({ ...base, nextIndex: null }, p)).toMatchObject({ count: 4, nextMap: null });
  });

  it('enabled: false・最上位の形が違う・取得失敗は 3 項目とも null(nowIndex / nextIndex は残す)', () => {
    const nulls = { nowIndex: 0, nextIndex: 1, count: null, nextMap: null, nextMapName: null };
    expect(applyRotation(base, parseRotation({ enabled: false, entries: [{ map: 'a' }, { map: 'b' }] }))).toEqual(nulls);
    expect(parseRotation({ enabled: true })).toBeNull();
    expect(parseRotation({ entries: 'a,b' })).toBeNull();
    expect(parseRotation([{ map: 'a' }])).toBeNull();
    expect(parseRotation(null)).toBeNull();
    expect(applyRotation(base, null)).toEqual(nulls);
  });
});

describe('capabilities', () => {
  it('ルート表記の正規化', () => {
    expect(normalizePath('/v1/players/{steamId}/kick')).toBe('/v1/players/{}/kick');
    expect(normalizePath('/v1/players/:id/kick/')).toBe('/v1/players/{}/kick');
    expect(normalizeRouteEntry('post /v1/broadcast')).toBe('POST /v1/broadcast');
    expect(normalizeRouteEntry({ method: 'DELETE', path: '/v1/bans/<steamId>' })).toBe('DELETE /v1/bans/{}');
    expect(normalizeRouteEntry('/v1/status')).toBe('* /v1/status');
    expect(normalizeRouteEntry(42)).toBeNull();
    expect(normalizeRouteEntry('FOO /x')).toBeNull();
  });

  it('available / missing / unknown', () => {
    const parsed = parseCapabilities({ apiVersion: '1', build: 'b', routes: ['GET /v1/status', 'POST /v1/players/{steamId}/kick'] });
    const r = buildCapabilitiesResponse(parsed, T);
    expect(r.source).toBe('rcon');
    expect(r.read.status).toBe('available');
    expect(r.read.players).toBe('missing');
    expect(r.write.kick).toBe('available');
    expect(r.write.ban).toBe('missing');
    const u = buildCapabilitiesResponse(parseCapabilities({ routes: [] }), T);
    expect(u.source).toBe('unavailable');
    expect(u.write.kick).toBe('unknown');
    expect(parseCapabilities('x')).toBeNull();
  });
});
