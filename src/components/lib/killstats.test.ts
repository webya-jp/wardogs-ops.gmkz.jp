// キルフィードの集計(docs/ARCHITECTURE.md 17.10.6)。プレイヤー名・Steam ID はすべて架空のダミー。
import { describe, expect, it } from 'vitest';
import { KILL_TIME_BUCKETS_MAX, KILLFEED_TOP_PLAYERS } from '../../types/api';
import type { KillEvent, KillParty, MatchSummary } from '../../types/api';
import {
  buildKillfeedExport,
  buildTimeline,
  chooseBucketMinutes,
  exportFileName,
  factionIndex,
  factionInitials,
  filterKills,
  formatGameTime,
  mergeKills,
  normalizeQuery,
  summarizeKills,
} from './killstats';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 17, 5, 0, 0); // 2026-10-17 14:00 JST

const A = '76561190000000001';
const B = '76561190000000002';
const C = '76561190000000003';

function party(name: string | null, steamId: string | null, faction: string | null = null): KillParty {
  return { name, steamId, faction, factionSource: faction === null ? null : 'roster' };
}

let nextId = 1;
function kill(over: Partial<KillEvent> & { at?: number } = {}): KillEvent {
  const { at, ...rest } = over;
  return {
    id: nextId++,
    receivedAt: at ?? T0,
    eventAt: null,
    gameTimeSec: null,
    killer: party('TestPlayerA', A, 'Blue'),
    victim: party('TestPlayerB', B, 'Red'),
    weapon: { id: 'WEPN_TEST', name: 'Test Rifle' },
    vehicle: null,
    flags: { headshot: false, penetration: false, roadkill: false, vehicleExplosion: false, suicide: false },
    teamkill: false,
    distanceM: null,
    ...rest,
  };
}

const flags = (f: Partial<KillEvent['flags']>): KillEvent['flags'] => ({
  headshot: false,
  penetration: false,
  roadkill: false,
  vehicleExplosion: false,
  suicide: false,
  ...f,
});

function sample(): KillEvent[] {
  nextId = 1;
  return [
    kill({ at: T0 + 10_000, flags: flags({ headshot: true }), distanceM: 37.2 }),
    kill({ at: T0 + 2 * MIN, distanceM: 150 }),
    // 自殺(キラーは残す)
    kill({ at: T0 + 3 * MIN, victim: party('TestPlayerA', A, 'Blue'), flags: flags({ suicide: true }), teamkill: null }),
    // 環境による死亡
    kill({ at: T0 + 4 * MIN, killer: null, victim: party('TestPlayerC', C), teamkill: null, weapon: { id: null, name: 'Test Fall' } }),
    // チームキル
    kill({ at: T0 + 5 * MIN, killer: party('TestPlayerB', B, 'Red'), victim: party('TestPlayerC', C, 'Red'), teamkill: true, distanceM: 150 }),
    // 陣営不明(teamkill 判定不可)・乗り物
    kill({
      at: T0 + 6 * MIN,
      teamkill: null,
      vehicle: { id: 'TNK_TEST', name: 'Test Tank' },
      weapon: { id: null, name: 'Anti Air' },
      flags: flags({ roadkill: true, penetration: true }),
      distanceM: 5,
    }),
  ];
}

describe('summarizeKills', () => {
  it('統計カードの定義(キル・デス・自殺・HS・チームキル・判定できない件数・Steam ID の数・距離)', () => {
    const s = summarizeKills(sample(), { origin: T0, end: T0 + 10 * MIN });
    expect(s.totals).toEqual({
      kills: 4,
      deaths: 6,
      suicides: 1,
      headshots: 1,
      teamkills: 1,
      teamkillUnknown: 1,
      playersInvolved: 3,
      withDistance: 4,
    });
    expect(s.headshotRate).toBeCloseTo(0.25);
    expect(s.averageDistanceM).toBeCloseTo((37.2 + 150 + 150 + 5) / 4);
  });

  it('最長キルは同じ距離なら先のもの', () => {
    const kills = sample();
    const s = summarizeKills(kills, { origin: T0, end: null });
    expect(s.longest?.id).toBe(kills[1]!.id);
  });

  it('キル 0 件ならヘッドショット率・平均・最長は null', () => {
    const s = summarizeKills([], { origin: null, end: null });
    expect(s.headshotRate).toBeNull();
    expect(s.averageDistanceM).toBeNull();
    expect(s.longest).toBeNull();
    expect(s.timeline.buckets).toEqual([]);
    expect(s.distance).toHaveLength(6);
  });

  it('距離の階級は下限を含み上限を含まない', () => {
    nextId = 1;
    const kills = [0, 9.9, 10, 25, 49.9, 100, 199.9, 200, 5000].map((d) => kill({ distanceM: d }));
    const s = summarizeKills(kills, { origin: T0, end: T0 });
    expect(s.distance.map((b) => b.kills)).toEqual([2, 1, 2, 0, 2, 2]);
    expect(s.distance[0]).toMatchObject({ minM: 0, maxM: 10 });
    expect(s.distance[5]).toMatchObject({ minM: 200, maxM: null });
  });

  it('上位のプレイヤー: キルの多い順、同数はデスの少ない順。K/D はデス 0 ならキル数', () => {
    const s = summarizeKills(sample(), { origin: T0, end: null });
    const a = s.topPlayers.find((p) => p.steamId === A)!;
    const b = s.topPlayers.find((p) => p.steamId === B)!;
    // A: キル 3(自殺は数えない)、デス 1(自殺)。B: キル 1、デス 3
    expect(a).toMatchObject({ kills: 3, deaths: 1, kd: 3 });
    expect(b).toMatchObject({ kills: 1, deaths: 3 });
    expect(b.kd).toBeCloseTo(1 / 3);
    expect(s.topPlayers[0]!.steamId).toBe(A);
    const c = s.topPlayers.find((p) => p.steamId === C)!;
    expect(c).toMatchObject({ kills: 0, deaths: 2, kd: 0 });
  });

  it('Steam ID が無い当事者は名前で数え、関わったプレイヤーには数えない', () => {
    nextId = 1;
    const kills = [kill({ killer: party('TestNoId', null), victim: party('TestPlayerB', B) })];
    const s = summarizeKills(kills, { origin: T0, end: null });
    expect(s.totals.playersInvolved).toBe(1);
    expect(s.topPlayers[0]).toMatchObject({ key: 'name:TestNoId', kills: 1, kd: 1 });
  });

  it('上位のプレイヤーは最大 KILLFEED_TOP_PLAYERS 人', () => {
    nextId = 1;
    const kills = Array.from({ length: 15 }, (_, i) =>
      kill({ killer: party(`TestKiller${i}`, `7656119000000${String(1000 + i)}`) }),
    );
    expect(summarizeKills(kills, { origin: T0, end: null }).topPlayers.length).toBe(KILLFEED_TOP_PLAYERS);
  });

  it('武器・原因: 乗り物と武器の組で数え、多い順', () => {
    nextId = 1;
    const kills = [
      kill({ weapon: { id: 'W1', name: 'Test Rifle' }, flags: flags({ headshot: true }) }),
      kill({ weapon: { id: 'W1', name: null } }),
      kill({ weapon: { id: null, name: 'Anti Air' }, vehicle: { id: 'TNK_TEST', name: 'Test Tank' } }),
      kill({ weapon: { id: null, name: 'Anti Air' } }),
    ];
    const s = summarizeKills(kills, { origin: T0, end: null });
    expect(s.weapons.map((w) => [w.key, w.kills, w.headshots])).toEqual([
      ['|W1', 2, 1],
      ['TNK_TEST|Anti Air', 1, 0],
      ['|Anti Air', 1, 0],
    ]);
  });
});

describe('時間帯', () => {
  it('棒が KILL_TIME_BUCKETS_MAX 本以下になる最小の幅', () => {
    expect(chooseBucketMinutes(0)).toBe(1);
    expect(chooseBucketMinutes(35 * MIN)).toBe(1);
    expect(chooseBucketMinutes(36 * MIN)).toBe(2);
    expect(chooseBucketMinutes(3 * 60 * MIN)).toBe(10);
    expect(chooseBucketMinutes(1000 * 24 * 60 * MIN)).toBe(1440);
  });

  it('起点は分に切り捨て、キルの無い棒も出す。終点まで', () => {
    nextId = 1;
    const kills = [kill({ at: T0 + 30_000, flags: flags({ headshot: true }) }), kill({ at: T0 + 4 * MIN + 1 })];
    const tl = buildTimeline(kills, { origin: T0 + 15_000, end: T0 + 9 * MIN });
    expect(tl.bucketMinutes).toBe(1);
    expect(tl.buckets).toHaveLength(10);
    expect(tl.buckets[0]).toEqual({ start: T0, kills: 1, headshots: 1 });
    expect(tl.buckets[4]).toEqual({ start: T0 + 4 * MIN, kills: 1, headshots: 0 });
    expect(tl.buckets[2]!.kills).toBe(0);
  });

  it('記録外は最初のキルから最後のキルまで', () => {
    nextId = 1;
    const kills = [kill({ at: T0 + 90_000 }), kill({ at: T0 + 100 * MIN })];
    const tl = buildTimeline(kills, { origin: null, end: null });
    expect(tl.buckets[0]!.start).toBe(T0 + MIN);
    expect(tl.buckets.length).toBeLessThanOrEqual(KILL_TIME_BUCKETS_MAX);
    expect(tl.buckets.reduce((n, b) => n + b.kills, 0)).toBe(2);
  });

  it('自殺・環境による死亡は棒に数えない', () => {
    const tl = buildTimeline(sample(), { origin: T0, end: T0 + 10 * MIN });
    expect(tl.buckets.reduce((n, b) => n + b.kills, 0)).toBe(4);
  });
});

describe('filterKills', () => {
  const kills = sample();
  const ids = (f: Parameters<typeof filterKills>[1], q = '', b: Parameters<typeof filterKills>[3] = null) =>
    filterKills(kills, f, q, b).map((k) => k.id);

  it('8 種のフィルタ', () => {
    expect(ids('all')).toHaveLength(6);
    expect(ids('kills')).toEqual([1, 2, 5, 6]);
    expect(ids('headshots')).toEqual([1]);
    expect(ids('teamkills')).toEqual([5]);
    expect(ids('suicides')).toEqual([3]);
    expect(ids('long')).toEqual([2, 5]);
    expect(ids('vehicle')).toEqual([6]);
    expect(ids('penetration')).toEqual([6]);
  });

  it('検索: NFKC・小文字の部分一致(名前・Steam ID・武器・乗り物)', () => {
    expect(ids('all', 'ＴＥＳＴＰＬＡＹＥＲＣ')).toEqual([4, 5]);
    expect(ids('all', '0000000003')).toEqual([4, 5]);
    expect(ids('all', 'test fall')).toEqual([4]);
    expect(ids('all', 'tnk_')).toEqual([6]);
    expect(ids('kills', 'tank')).toEqual([6]);
    expect(ids('all', '   ')).toHaveLength(6);
  });

  it('時間帯の棒(start を含み end を含まない)', () => {
    expect(ids('all', '', { start: T0 + 2 * MIN, end: T0 + 4 * MIN })).toEqual([2, 3]);
  });

  it('検索語は 64 文字まで', () => {
    expect(Array.from(normalizeQuery('x'.repeat(100)))).toHaveLength(64);
  });
});

describe('mergeKills', () => {
  it('id で重複を除き古い順。max で新しい方を残す', () => {
    nextId = 1;
    const a = kill({ at: T0 });
    const b = kill({ at: T0 + 1 });
    const c = kill({ at: T0 + 1 });
    expect(mergeKills([a, b], [b, c]).map((k) => k.id)).toEqual([1, 2, 3]);
    expect(mergeKills([a, b], [c], 2).map((k) => k.id)).toEqual([2, 3]);
  });
});

describe('表示用', () => {
  it('ゲーム内時刻', () => {
    expect(formatGameTime(3151)).toBe('52:31');
    expect(formatGameTime(5)).toBe('0:05');
    expect(formatGameTime(3661)).toBe('1:01:01');
  });

  it('陣営の印', () => {
    expect(factionIndex(['Blue', 'Red'], 'Red')).toBe(1);
    expect(factionIndex(['Blue'], 'Green')).toBeNull();
    expect(factionIndex(['Blue'], null)).toBeNull();
    expect(factionInitials('Blue')).toBe('Bl');
    expect(factionInitials('😀😁😂')).toBe('😀😁');
  });

  it('ファイル名はタイムゾーンの日時', () => {
    expect(exportFileName('3', '12', T0, 'Asia/Tokyo')).toBe('killfeed-s3-12-20261017-1400.json');
    expect(exportFileName('3', 'unrecorded', T0, 'UTC')).toBe('killfeed-s3-unrecorded-20261017-0500.json');
  });
});

describe('buildKillfeedExport', () => {
  it('集計は画面と同じ定義で、絞り込み前の全件を入れる', () => {
    const kills = sample();
    const match: MatchSummary = {
      id: '12',
      serverId: '3',
      serverName: null,
      status: 'ended',
      startedAt: T0,
      endedAt: T0 + 10 * MIN,
      endReason: 'manual',
      map: 'TestMap',
      scoreCap: 100,
      scoreCapSource: 'default',
      sampleCount: 0,
      lastSampleAt: null,
      lastScores: [],
    };
    const ex = buildKillfeedExport({
      server: { id: '3', name: 'Test Server' },
      scope: '12',
      match,
      samples: [],
      kills,
      truncated: false,
      timeZone: 'Asia/Tokyo',
      exportedAt: T0 + 20 * MIN,
    });
    expect(ex.format).toBe('wardogs-ops.killfeed');
    expect(ex.version).toBe(1);
    expect(ex.kills).toHaveLength(6);
    expect(ex.summary).toEqual(summarizeKills(kills, { origin: T0, end: T0 + 10 * MIN }));
    expect(JSON.parse(JSON.stringify(ex))).toEqual(ex);
  });

  it('記録中の試合は summaryAt を終点にし、画面の集計と棒の数・幅が一致する', () => {
    const kills = sample();
    const match: MatchSummary = {
      id: '13',
      serverId: '3',
      serverName: null,
      status: 'recording',
      startedAt: T0,
      endedAt: null,
      endReason: null,
      map: 'TestMap',
      scoreCap: 100,
      scoreCapSource: 'default',
      sampleCount: 0,
      lastSampleAt: null,
      lastScores: [],
    };
    const summaryAt = T0 + 30 * MIN;
    const screen = summarizeKills(kills, { origin: T0, end: summaryAt });
    const ex = buildKillfeedExport({
      server: { id: '3', name: null },
      scope: '13',
      match,
      samples: [],
      kills,
      truncated: false,
      timeZone: 'Asia/Tokyo',
      // 書き出しは画面の取得から 2 時間後(summaryAt を使わなければ棒の幅が変わる)
      exportedAt: T0 + 150 * MIN,
      summaryAt,
    });
    expect(ex.summary.timeline).toEqual(screen.timeline);
    expect(ex.summary.timeline.bucketMinutes).toBe(1);
    expect(ex.summary.timeline.buckets).toHaveLength(31);
  });
});
