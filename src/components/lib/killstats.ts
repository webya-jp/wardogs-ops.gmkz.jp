// キルフィードの集計・絞り込み・JSON 出力(ブラウザで計算する純粋関数。docs/ARCHITECTURE.md 17.10.6、docs/API.md 11.3)。
// 集計の定義はこのファイルの 1 か所に置き、画面(統計カード等)と JSON 出力が必ず同じ数字になるようにする。
// - キル: キラーがいて自殺でないイベント(チームキルを含む)/ デス: 被害者がいるイベント(自殺・環境による死亡を含む)
// - 集計は絞り込み前の全件で行う(絞り込み・検索・時間帯の棒の選択はキルログだけに効く)
// プレイヤー名・陣営名・武器名は生データ(翻訳しない。画面はテキストとして描画する)。
import {
  KILL_DISTANCE_BIN_EDGES_M,
  KILL_LONG_DISTANCE_M,
  KILL_TIME_BUCKET_MINUTES,
  KILL_TIME_BUCKETS_MAX,
  KILLFEED_SEARCH_MAX_LENGTH,
  KILLFEED_TOP_PLAYERS,
  KILLFEED_TOP_WEAPONS,
  KILLFEED_UNRECORDED,
} from '../../types/api';
import type {
  KillDistanceBin,
  KillEvent,
  KillfeedExport,
  KillfeedScope,
  KillfeedSummary,
  KillFilter,
  KillParty,
  KillPlayerStat,
  KillTimeBucket,
  KillWeaponStat,
  MatchSample,
  MatchSummary,
  ServerId,
} from '../../types/api';

const MINUTE_MS = 60_000;

/** キル(キラーがいて自殺でない。チームキルを含む) */
export function isKill(k: KillEvent): boolean {
  return k.killer !== null && !k.flags.suicide;
}

/** デス(被害者がいる。自殺・環境による死亡を含む) */
export function isDeath(k: KillEvent): boolean {
  return k.victim !== null;
}

/** 乗り物が関わったキル(フィルタ vehicle) */
export function isVehicleKill(k: KillEvent): boolean {
  return k.vehicle !== null || k.flags.roadkill || k.flags.vehicleExplosion;
}

/** プレイヤーの集計の鍵(Steam ID、無ければ `name:<名前>`。どちらも無ければ null) */
export function partyKey(p: KillParty | null): string | null {
  if (!p) return null;
  if (p.steamId) return p.steamId;
  if (p.name !== null) return `name:${p.name}`;
  return null;
}

/** 武器・原因の集計の鍵(乗り物と武器の id、無ければ名前) */
export function weaponKey(k: Pick<KillEvent, 'weapon' | 'vehicle'>): string {
  const v = k.vehicle ? (k.vehicle.id ?? k.vehicle.name ?? '') : '';
  const w = k.weapon.id ?? k.weapon.name ?? '';
  return `${v}|${w}`;
}

/**
 * 時間帯の棒の幅(分)。KILL_TIME_BUCKET_MINUTES のうち、起点から終点までの棒が KILL_TIME_BUCKETS_MAX 本以下になる最小のもの。
 * どれでも収まらなければ最大の幅
 */
export function chooseBucketMinutes(spanMs: number): number {
  const span = Math.max(0, spanMs);
  for (const m of KILL_TIME_BUCKET_MINUTES) {
    if (Math.floor(span / (m * MINUTE_MS)) + 1 <= KILL_TIME_BUCKETS_MAX) return m;
  }
  return KILL_TIME_BUCKET_MINUTES[KILL_TIME_BUCKET_MINUTES.length - 1] ?? 1440;
}

export interface SummarizeOptions {
  /** 起点(試合の開始時刻)。記録外は null(最初のキルの受信時刻) */
  origin: number | null;
  /** 終点(試合の終了時刻、記録中は現在)。記録外は null(最後のキル) */
  end: number | null;
}

/** 時間帯の区切り(棒の始まりの一覧)。キルが起点より前・終点より後にあれば、それを含むように広げる */
export function buildTimeline(kills: readonly KillEvent[], opts: SummarizeOptions): { bucketMinutes: number; buckets: KillTimeBucket[] } {
  const first = kills[0]?.receivedAt ?? null;
  const last = kills.length > 0 ? Math.max(...kills.map((k) => k.receivedAt)) : null;
  const minAt = kills.length > 0 ? Math.min(...kills.map((k) => k.receivedAt)) : null;
  const rawOrigin = opts.origin ?? first;
  if (rawOrigin === null) return { bucketMinutes: KILL_TIME_BUCKET_MINUTES[0] ?? 1, buckets: [] };
  const originAt = minAt !== null ? Math.min(rawOrigin, minAt) : rawOrigin;
  const origin = Math.floor(originAt / MINUTE_MS) * MINUTE_MS;
  const end = Math.max(opts.end ?? last ?? origin, last ?? origin, origin);
  const bucketMinutes = chooseBucketMinutes(end - origin);
  const size = bucketMinutes * MINUTE_MS;
  const count = Math.floor((end - origin) / size) + 1;
  const buckets: KillTimeBucket[] = [];
  for (let i = 0; i < count; i++) buckets.push({ start: origin + i * size, kills: 0, headshots: 0 });
  for (const k of kills) {
    if (!isKill(k)) continue;
    const idx = Math.min(count - 1, Math.max(0, Math.floor((k.receivedAt - origin) / size)));
    const b = buckets[idx];
    if (!b) continue;
    b.kills += 1;
    if (k.flags.headshot) b.headshots += 1;
  }
  return { bucketMinutes, buckets };
}

/** 集計(統計カード・時間帯別・上位・武器・距離・最長)。kills は古い順 */
export function summarizeKills(kills: readonly KillEvent[], opts: SummarizeOptions): KillfeedSummary {
  let killCount = 0;
  let deaths = 0;
  let suicides = 0;
  let headshots = 0;
  let teamkills = 0;
  let teamkillUnknown = 0;
  let withDistance = 0;
  let distanceSum = 0;
  let longest: KillEvent | null = null;
  const steamIds = new Set<string>();
  const players = new Map<string, KillPlayerStat>();
  const weapons = new Map<string, KillWeaponStat>();
  const distance: KillDistanceBin[] = [];
  let lower = 0;
  for (const edge of KILL_DISTANCE_BIN_EDGES_M) {
    distance.push({ minM: lower, maxM: edge, kills: 0 });
    lower = edge;
  }
  distance.push({ minM: lower, maxM: null, kills: 0 });

  const player = (p: KillParty): KillPlayerStat | null => {
    const key = partyKey(p);
    if (key === null) return null;
    let s = players.get(key);
    if (!s) {
      s = { key, name: p.name, steamId: p.steamId, faction: p.faction, kills: 0, deaths: 0, kd: 0 };
      players.set(key, s);
    }
    // 最後に観測した名前・陣営を残す(null で上書きしない)
    if (p.name !== null) s.name = p.name;
    if (p.faction !== null) s.faction = p.faction;
    return s;
  };

  for (const k of kills) {
    if (k.killer?.steamId) steamIds.add(k.killer.steamId);
    if (k.victim?.steamId) steamIds.add(k.victim.steamId);
    if (k.flags.suicide) suicides += 1;
    if (isDeath(k) && k.victim) {
      deaths += 1;
      const s = player(k.victim);
      if (s) s.deaths += 1;
    }
    if (!isKill(k) || !k.killer) continue;
    killCount += 1;
    if (k.flags.headshot) headshots += 1;
    if (k.teamkill === true) teamkills += 1;
    else if (k.teamkill === null) teamkillUnknown += 1;
    const ks = player(k.killer);
    if (ks) ks.kills += 1;

    const wk = weaponKey(k);
    let ws = weapons.get(wk);
    if (!ws) {
      ws = { key: wk, weapon: { ...k.weapon }, vehicle: k.vehicle ? { ...k.vehicle } : null, kills: 0, headshots: 0 };
      weapons.set(wk, ws);
    }
    ws.kills += 1;
    if (k.flags.headshot) ws.headshots += 1;

    if (k.distanceM !== null && Number.isFinite(k.distanceM)) {
      withDistance += 1;
      distanceSum += k.distanceM;
      if (longest === null || (longest.distanceM ?? -1) < k.distanceM) longest = k;
      const bin = distance.find((b) => k.distanceM! >= b.minM && (b.maxM === null || k.distanceM! < b.maxM));
      if (bin) bin.kills += 1;
    }
  }

  const topPlayers = [...players.values()]
    .map((s) => ({ ...s, kd: s.deaths === 0 ? s.kills : s.kills / s.deaths }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, KILLFEED_TOP_PLAYERS);
  const topWeapons = [...weapons.values()]
    .sort((a, b) => b.kills - a.kills || b.headshots - a.headshots || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, KILLFEED_TOP_WEAPONS);

  return {
    totals: {
      kills: killCount,
      deaths,
      suicides,
      headshots,
      teamkills,
      teamkillUnknown,
      playersInvolved: steamIds.size,
      withDistance,
    },
    headshotRate: killCount === 0 ? null : headshots / killCount,
    longest,
    averageDistanceM: withDistance === 0 ? null : distanceSum / withDistance,
    timeline: buildTimeline(kills, opts),
    topPlayers,
    weapons: topWeapons,
    distance,
  };
}

/** 検索語を比較用にする(NFKC・小文字・前後の空白を除く・KILLFEED_SEARCH_MAX_LENGTH 文字まで) */
export function normalizeQuery(query: string): string {
  return Array.from(query.normalize('NFKC').toLowerCase().trim()).slice(0, KILLFEED_SEARCH_MAX_LENGTH).join('');
}

function fold(s: string | null | undefined): string {
  return s ? s.normalize('NFKC').toLowerCase() : '';
}

/** フィルタ 1 種に当てはまるか */
export function matchesFilter(k: KillEvent, filter: KillFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'kills':
      return isKill(k);
    case 'headshots':
      return isKill(k) && k.flags.headshot;
    case 'teamkills':
      return k.teamkill === true;
    case 'suicides':
      return k.flags.suicide;
    case 'long':
      return k.distanceM !== null && k.distanceM >= KILL_LONG_DISTANCE_M;
    case 'vehicle':
      return isVehicleKill(k);
    case 'penetration':
      return k.flags.penetration;
    default:
      return true;
  }
}

/** 検索語(normalizeQuery 済み)に当てはまるか。名前・Steam ID・武器と乗り物の id と名前の部分一致 */
export function matchesQuery(k: KillEvent, q: string): boolean {
  if (q === '') return true;
  const hay = [
    k.killer?.name,
    k.killer?.steamId,
    k.victim?.name,
    k.victim?.steamId,
    k.weapon.id,
    k.weapon.name,
    k.vehicle?.id,
    k.vehicle?.name,
  ];
  return hay.some((s) => fold(s).includes(q));
}

/** 時間帯の棒の範囲(start を含み end を含まない) */
export interface TimeRange {
  start: number;
  end: number;
}

/** 棒 1 本の範囲 */
export function bucketRange(bucket: Pick<KillTimeBucket, 'start'>, bucketMinutes: number): TimeRange {
  return { start: bucket.start, end: bucket.start + bucketMinutes * MINUTE_MS };
}

/** キルログの絞り込み(フィルタ × 検索語 × 時間帯の棒)。順序は入力のまま */
export function filterKills(
  kills: readonly KillEvent[],
  filter: KillFilter,
  query: string,
  bucket: TimeRange | null,
): KillEvent[] {
  const q = normalizeQuery(query);
  return kills.filter(
    (k) =>
      matchesFilter(k, filter) &&
      matchesQuery(k, q) &&
      (bucket === null || (k.receivedAt >= bucket.start && k.receivedAt < bucket.end)),
  );
}

/**
 * 差分の取得の結果を足す(id で重複を除き、(receivedAt, id) の古い順に並べる)。
 * max を与えたら新しい方から max 件だけ残す(記録外は KILLFEED_UNRECORDED_MAX)
 */
export function mergeKills(existing: readonly KillEvent[], incoming: readonly KillEvent[], max?: number): KillEvent[] {
  if (incoming.length === 0) return existing as KillEvent[];
  const seen = new Set(existing.map((k) => k.id));
  const merged = [...existing];
  for (const k of incoming) {
    if (seen.has(k.id)) continue;
    seen.add(k.id);
    merged.push(k);
  }
  merged.sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id);
  return max !== undefined && merged.length > max ? merged.slice(merged.length - max) : merged;
}

/** ゲーム内時刻(秒)を m:ss / h:mm:ss にする */
export function formatGameTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 陣営の印の配色の番号(factions の添字。不明・一覧に無ければ null) */
export function factionIndex(factions: readonly string[], faction: string | null): number | null {
  if (faction === null) return null;
  const i = factions.indexOf(faction);
  return i < 0 ? null : i;
}

/** 陣営名の先頭 2 文字(サロゲートペアを分けない) */
export function factionInitials(faction: string): string {
  return Array.from(faction.trim() || faction).slice(0, 2).join('');
}

/** 書き出すファイル名: killfeed-s<サーバー id>-<試合 id または unrecorded>-<YYYYMMDD-HHmm>.json(日時は timeZone) */
export function exportFileName(serverId: ServerId, scope: KillfeedScope, at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const safe = (s: string) => s.replace(/[^0-9A-Za-z_-]/g, '');
  const scopePart = scope === KILLFEED_UNRECORDED ? KILLFEED_UNRECORDED : safe(scope);
  return `killfeed-s${safe(serverId)}-${scopePart}-${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}.json`;
}

/** 集計の起点・終点(試合なら開始〜終了〔記録中は now〕、記録外は null = キルから決める) */
export function summarizeOptionsFor(match: Pick<MatchSummary, 'startedAt' | 'endedAt'> | null, now: number): SummarizeOptions {
  if (!match) return { origin: null, end: null };
  return { origin: match.startedAt, end: match.endedAt ?? now };
}

export interface BuildExportInput {
  server: { id: ServerId; name: string | null };
  scope: KillfeedScope;
  match: MatchSummary | null;
  samples: readonly MatchSample[];
  /** 絞り込み前の全件(古い順) */
  kills: readonly KillEvent[];
  truncated: boolean;
  timeZone: string;
  exportedAt: number;
}

/** 「JSON で書き出す」の中身。集計は summarizeKills を同じ起点・終点で計算し直す(画面と同じ数字になる) */
export function buildKillfeedExport(input: BuildExportInput): KillfeedExport {
  return {
    format: 'wardogs-ops.killfeed',
    version: 1,
    exportedAt: input.exportedAt,
    timeZone: input.timeZone,
    server: { id: input.server.id, name: input.server.name },
    scope: input.scope,
    match: input.match,
    samples: [...input.samples],
    summary: summarizeKills(input.kills, summarizeOptionsFor(input.match, input.exportedAt)),
    kills: [...input.kills],
    truncated: input.truncated,
  };
}
