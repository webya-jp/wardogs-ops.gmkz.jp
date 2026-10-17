// キルフィード 第 2 段階の保存と読み取り(feed_kills)。docs/ARCHITECTURE.md 17.10.3〜17.10.5・17.10.9、docs/API.md 11 章。
// D1・時刻は引数で受け取る(cloudflare:workers に依存させない)。
// - 日次の上限: feed_daily.kills を 1 文の UPSERT で足す(サーバー → 全体。断られたらそのバッチのキルを全部捨てる)
// - 陣営: イベントに無ければ、記録中の試合の最後のサンプルの roster_json(3 分以内)から Steam ID で引く(isolate 内に 30 秒キャッシュ)
// - 保存: json_each で 1 文の INSERT(バインドは JSON の文字列 1 つ。D1 のバインド変数の上限を避ける。要確認 C-25)
// - 名前・Steam ID をログに出さない(この層はログを出さない)
import {
  FEED_NORMALIZE_PREVIEW_MAX,
  KILL_CURSOR_PATTERN,
  KILL_FACTION_SOURCES,
  KILL_FLAGS,
  KILLFEED_DAILY_MAX_KILLS,
  KILLFEED_GLOBAL_DAILY_MAX_KILLS,
  KILLFEED_INCREMENT_MAX,
  KILLFEED_MATCH_KILLS_MAX,
  KILLFEED_NAME_MAX_LENGTH,
  KILLFEED_ROSTER_MAX_AGE_MS,
  KILLFEED_ROSTER_MAX_PLAYERS,
  KILLFEED_UNRECORDED,
  KILLFEED_UNRECORDED_MAX,
  MATCH_ID_PATTERN,
  MAX_SERVERS,
  SERVER_ID_PATTERN,
  STEAM_ID_PATTERN,
} from '../../types/api';
import type {
  FeedNormalizePreviewResponse,
  KillEvent,
  KillFactionSource,
  KillfeedIngestCounts,
  KillfeedKillsResponse,
  KillfeedScope,
  KillFlag,
  KillParty,
  ServerId,
  ValidationIssue,
} from '../../types/api';
import type { RecordingPlayer } from '../rcon/normalize';
import { getMatchSummary } from '../recordings';
import { normalizeFeedBatch } from './normalize';
import type { NormalizedKill } from './normalize';

const ROSTER_CACHE_MS = 30_000;
const MAX_CACHE = MAX_SERVERS * 3;

// ============================================================
// 印のビット(feed_kills.flags。KILL_FLAGS の順に 1, 2, 4, 8, 16)
// ============================================================

export function flagsToBits(flags: Record<KillFlag, boolean>): number {
  return KILL_FLAGS.reduce((bits, f, i) => (flags[f] ? bits | (1 << i) : bits), 0);
}

export function bitsToFlags(bits: number): Record<KillFlag, boolean> {
  const out = {} as Record<KillFlag, boolean>;
  KILL_FLAGS.forEach((f, i) => {
    out[f] = (bits & (1 << i)) !== 0;
  });
  return out;
}

// ============================================================
// 陣営の観測(match_samples.roster_json)
// ============================================================

export interface Roster {
  /** 陣営名 */
  f: string[];
  /** Steam ID → f の添字 */
  p: Record<string, number>;
}

/**
 * Cron・記録の開始が取った /v1/players から roster_json を作る(名前は入れない。最大 KILLFEED_ROSTER_MAX_PLAYERS 人)。
 * players が取れない・Steam ID と陣営の両方が分かる人がいなければ null
 */
export function buildRosterJson(players: RecordingPlayer[] | null): string | null {
  if (!players) return null;
  const f: string[] = [];
  const p: Record<string, number> = {};
  let n = 0;
  for (const pl of players) {
    if (n >= KILLFEED_ROSTER_MAX_PLAYERS) break;
    const id = pl.steamId ?? null;
    const faction = pl.faction === null ? null : Array.from(pl.faction).slice(0, KILLFEED_NAME_MAX_LENGTH).join('');
    if (id === null || !STEAM_ID_PATTERN.test(id) || faction === null || faction === '') continue;
    if (Object.prototype.hasOwnProperty.call(p, id)) continue;
    let idx = f.indexOf(faction);
    if (idx < 0) {
      f.push(faction);
      idx = f.length - 1;
    }
    p[id] = idx;
    n += 1;
  }
  return n === 0 ? null : JSON.stringify({ f, p });
}

export function parseRoster(json: string | null | undefined): Roster | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (!Array.isArray(o.f) || typeof o.p !== 'object' || o.p === null || Array.isArray(o.p)) return null;
    const f = o.f.map((x) => (typeof x === 'string' ? x : null));
    const p: Record<string, number> = {};
    for (const [k, i] of Object.entries(o.p as Record<string, unknown>)) {
      if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < f.length && f[i] !== null) p[k] = i;
    }
    return { f: f.map((x) => x ?? ''), p };
  } catch {
    return null;
  }
}

interface RosterCacheEntry {
  at: number;
  takenAt: number | null;
  roster: Roster | null;
}

const rosterCache = new Map<ServerId, RosterCacheEntry>();

export function resetKillfeedStoreForTest(): void {
  rosterCache.clear();
  pendingCounts.clear();
}

/** 記録中の試合の最後のサンプルの観測(isolate 内に 30 秒。記録外なら roster は null) */
async function loadRoster(db: D1Database, server: ServerId, now: number): Promise<RosterCacheEntry> {
  const cached = rosterCache.get(server);
  if (cached && now - cached.at < ROSTER_CACHE_MS && now >= cached.at) return cached;
  const row = await db
    .prepare(
      `SELECT s.taken_at AS taken_at, s.roster_json AS roster_json
         FROM match_recordings r JOIN match_samples s ON s.recording_id = r.id
        WHERE r.server_id = ?1 AND r.status = 'recording'
        ORDER BY s.bucket_minute DESC LIMIT 1`,
    )
    .bind(Number(server))
    .first<{ taken_at: number; roster_json: string | null }>();
  const entry: RosterCacheEntry = { at: now, takenAt: row ? Number(row.taken_at) : null, roster: row ? parseRoster(row.roster_json) : null };
  rosterCache.delete(server);
  rosterCache.set(server, entry);
  while (rosterCache.size > MAX_CACHE) {
    const first = rosterCache.keys().next();
    if (first.done) break;
    rosterCache.delete(first.value);
  }
  return entry;
}

function withRoster(p: KillParty | null, roster: Roster): KillParty | null {
  if (!p || p.faction !== null || p.steamId === null) return p;
  const i = roster.p[p.steamId];
  const faction = i === undefined ? undefined : roster.f[i];
  return faction ? { ...p, faction, factionSource: 'roster' } : p;
}

/**
 * 陣営の無い当事者に、受信時の直近のプレイヤー一覧の観測から陣営を付ける(17.10.4)。
 * 陣営の無い当事者がいるときだけ D1 を読む(30 秒キャッシュ)。観測が無い・3 分より古ければそのまま
 */
export async function attachRosterFactions(db: D1Database, server: ServerId, kills: NormalizedKill[], receivedAt: number): Promise<NormalizedKill[]> {
  const needs = kills.some((k) => (k.killer && k.killer.faction === null && k.killer.steamId) || (k.victim && k.victim.faction === null && k.victim.steamId));
  if (!needs) return kills;
  const r = await loadRoster(db, server, receivedAt);
  if (!r.roster || r.takenAt === null || Math.abs(receivedAt - r.takenAt) > KILLFEED_ROSTER_MAX_AGE_MS) return kills;
  const roster = r.roster;
  return kills.map((k) => ({ ...k, killer: withRoster(k.killer, roster), victim: withRoster(k.victim, roster) }));
}

// ============================================================
// 日次の上限と保存
// ============================================================

/** feed_daily.kills に n を足す(上限を超えるなら足さずに false)。1 文の UPSERT */
async function takeKillDaily(db: D1Database, server: number, day: number, n: number, max: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO feed_daily (server_id, day, kills) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4
       ON CONFLICT (server_id, day) DO UPDATE SET kills = kills + excluded.kills
        WHERE kills + excluded.kills <= ?4
       RETURNING kills`,
    )
    .bind(server, day, n, max)
    .first<{ kills: number }>();
  return row !== null;
}

/** サーバー → 全体(server_id = 0)の順に上限を判定して足す。断られた理由を返す(足せたら null) */
export async function takeKillQuota(db: D1Database, server: ServerId, day: number, n: number): Promise<'daily_limit' | 'global_limit' | null> {
  if (!(await takeKillDaily(db, Number(server), day, n, KILLFEED_DAILY_MAX_KILLS))) return 'daily_limit';
  if (!(await takeKillDaily(db, 0, day, n, KILLFEED_GLOBAL_DAILY_MAX_KILLS))) return 'global_limit';
  return null;
}

const KILL_INSERT_SQL = `INSERT INTO feed_kills (server_id, recording_id, received_at, event_at, game_time_sec,
    killer_name, killer_steam_id, killer_faction, killer_faction_source,
    victim_name, victim_steam_id, victim_faction, victim_faction_source,
    weapon_id, weapon_name, vehicle_id, vehicle_name, flags, distance_m)
  SELECT ?1, COALESCE((SELECT id FROM match_recordings WHERE server_id = ?1 AND status = 'recording'), 0), ?2,
    json_extract(value, '$.ea'), json_extract(value, '$.gt'),
    json_extract(value, '$.kn'), json_extract(value, '$.ks'), json_extract(value, '$.kf'), json_extract(value, '$.kfs'),
    json_extract(value, '$.vn'), json_extract(value, '$.vs'), json_extract(value, '$.vf'), json_extract(value, '$.vfs'),
    json_extract(value, '$.wi'), json_extract(value, '$.wn'), json_extract(value, '$.hi'), json_extract(value, '$.hn'),
    json_extract(value, '$.fl'), json_extract(value, '$.dm')
  FROM json_each(?3) ORDER BY CAST(key AS INTEGER)`;

/** json_each に渡す 1 キル分(キーは短く。値はすべてスカラー) */
export function killToJsonRow(k: NormalizedKill): Record<string, string | number | null> {
  return {
    ea: k.eventAt,
    gt: k.gameTimeSec,
    kn: k.killer?.name ?? null,
    ks: k.killer?.steamId ?? null,
    kf: k.killer?.faction ?? null,
    kfs: k.killer?.factionSource ?? null,
    vn: k.victim?.name ?? null,
    vs: k.victim?.steamId ?? null,
    vf: k.victim?.faction ?? null,
    vfs: k.victim?.factionSource ?? null,
    wi: k.weapon.id,
    wn: k.weapon.name,
    hi: k.vehicle?.id ?? null,
    hn: k.vehicle?.name ?? null,
    fl: flagsToBits(k.flags),
    dm: k.distanceM,
  };
}

/** 1 文の INSERT(受信時に記録中の試合へ割り当て、無ければ記録外 = 0)。保存した件数 */
export async function insertKills(db: D1Database, server: ServerId, receivedAt: number, kills: NormalizedKill[]): Promise<number> {
  if (kills.length === 0) return 0;
  const r = await db.prepare(KILL_INSERT_SQL).bind(Number(server), receivedAt, JSON.stringify(kills.map(killToJsonRow))).run();
  return Number(r.meta?.changes ?? kills.length);
}

// ============================================================
// その他の件数(isolate 内で足し、受信の状況の更新と同じ機会に feed_daily へ。17.10.3 の 16)
// ============================================================

interface PendingCounts {
  other: number;
  incomplete: number;
  dropped: number;
}

const pendingCounts = new Map<ServerId, PendingCounts>();

export function addPendingCounts(server: ServerId, c: Partial<PendingCounts>): void {
  if (!c.other && !c.incomplete && !c.dropped) return;
  const cur = pendingCounts.get(server) ?? { other: 0, incomplete: 0, dropped: 0 };
  cur.other += c.other ?? 0;
  cur.incomplete += c.incomplete ?? 0;
  cur.dropped += c.dropped ?? 0;
  pendingCounts.delete(server);
  pendingCounts.set(server, cur);
  while (pendingCounts.size > MAX_CACHE) {
    const first = pendingCounts.keys().next();
    if (first.done) break;
    pendingCounts.delete(first.value);
  }
}

export function hasPendingCounts(server: ServerId): boolean {
  return pendingCounts.has(server);
}

/** 溜めた件数を足す文(無ければ null)。呼んだ時点で溜めた分は消す */
export function takePendingCountsStmt(db: D1Database, server: ServerId, day: number): D1PreparedStatement | null {
  const c = pendingCounts.get(server);
  if (!c) return null;
  pendingCounts.delete(server);
  return db
    .prepare(
      `INSERT INTO feed_daily (server_id, day, other_events, incomplete, dropped_kills) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (server_id, day) DO UPDATE SET other_events = other_events + excluded.other_events,
         incomplete = incomplete + excluded.incomplete, dropped_kills = dropped_kills + excluded.dropped_kills`,
    )
    .bind(Number(server), day, c.other, c.incomplete, c.dropped);
}

const ZERO_COUNTS: KillfeedIngestCounts = { kills: 0, otherEvents: 0, incomplete: 0, droppedKills: 0 };

/** 今日(UTC)の正規化の件数(行が無ければ 0) */
export async function readIngestCounts(db: D1Database, server: ServerId, day: number): Promise<KillfeedIngestCounts> {
  const r = await db
    .prepare('SELECT kills, other_events, incomplete, dropped_kills FROM feed_daily WHERE server_id = ?1 AND day = ?2')
    .bind(Number(server), day)
    .first<{ kills: number; other_events: number; incomplete: number; dropped_kills: number }>();
  if (!r) return { ...ZERO_COUNTS };
  return { kills: Number(r.kills), otherEvents: Number(r.other_events), incomplete: Number(r.incomplete), droppedKills: Number(r.dropped_kills) };
}

// ============================================================
// 読み取り(GET /api/killfeed/kills)
// ============================================================

interface KillRow {
  id: number;
  received_at: number;
  event_at: number | null;
  game_time_sec: number | null;
  killer_name: string | null;
  killer_steam_id: string | null;
  killer_faction: string | null;
  killer_faction_source: string | null;
  victim_name: string | null;
  victim_steam_id: string | null;
  victim_faction: string | null;
  victim_faction_source: string | null;
  weapon_id: string | null;
  weapon_name: string | null;
  vehicle_id: string | null;
  vehicle_name: string | null;
  flags: number;
  distance_m: number | null;
}

const SOURCES: ReadonlySet<string> = new Set(KILL_FACTION_SOURCES);
const nOrNull = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

function rowParty(name: string | null, steamId: string | null, faction: string | null, source: string | null): KillParty | null {
  if (name === null && steamId === null) return null;
  const f = faction ?? null;
  return {
    name,
    steamId: steamId !== null && STEAM_ID_PATTERN.test(steamId) ? steamId : null,
    faction: f,
    factionSource: f !== null && source !== null && SOURCES.has(source) ? (source as KillFactionSource) : null,
  };
}

/** チームキルの判定(17.10.4): 自殺でなく、両者の陣営が同じ出所で分かるときだけ true / false */
export function teamkillOf(k: Pick<KillEvent, 'killer' | 'victim' | 'flags'>): boolean | null {
  if (k.flags.suicide || !k.killer || !k.victim) return null;
  const a = k.killer;
  const b = k.victim;
  if (a.faction === null || b.faction === null || a.factionSource === null || a.factionSource !== b.factionSource) return null;
  return a.faction === b.faction;
}

export function rowToKill(r: KillRow): KillEvent {
  const killer = rowParty(r.killer_name, r.killer_steam_id, r.killer_faction, r.killer_faction_source);
  const victim = rowParty(r.victim_name, r.victim_steam_id, r.victim_faction, r.victim_faction_source);
  const flags = bitsToFlags(Number(r.flags ?? 0));
  const vehicle = r.vehicle_id === null && r.vehicle_name === null ? null : { id: r.vehicle_id, name: r.vehicle_name };
  const base = {
    id: Number(r.id),
    receivedAt: Number(r.received_at),
    eventAt: nOrNull(r.event_at),
    gameTimeSec: nOrNull(r.game_time_sec),
    killer,
    victim,
    weapon: { id: r.weapon_id, name: r.weapon_name },
    vehicle,
    flags,
    distanceM: nOrNull(r.distance_m),
  };
  return { ...base, teamkill: teamkillOf(base) };
}

export type KillsQuery =
  | { ok: true; server: ServerId; scope: KillfeedScope; after: { receivedAt: number; id: number; raw: string } | null }
  | { ok: false; fields: Record<string, ValidationIssue> };

export function parseKillsQuery(url: URL): KillsQuery {
  const fields: Record<string, ValidationIssue> = {};
  const ss = url.searchParams.get('server');
  const ms = url.searchParams.get('match');
  const as = url.searchParams.get('after');
  if (ss === null || ss === '') fields.server = 'required';
  else if (!SERVER_ID_PATTERN.test(ss)) fields.server = 'invalid_format';
  if (ms === null || ms === '') fields.match = 'required';
  else if (ms !== KILLFEED_UNRECORDED && !MATCH_ID_PATTERN.test(ms)) fields.match = 'invalid_format';
  let after: { receivedAt: number; id: number; raw: string } | null = null;
  if (as !== null && as !== '') {
    const m = KILL_CURSOR_PATTERN.exec(as);
    if (!m || !Number.isSafeInteger(Number(m[1])) || !Number.isSafeInteger(Number(m[2]))) fields.after = 'invalid_format';
    else after = { receivedAt: Number(m[1]), id: Number(m[2]), raw: as };
  }
  if (Object.keys(fields).length > 0 || ss === null || ms === null) return { ok: false, fields };
  return { ok: true, server: ss, scope: ms, after };
}

const KILL_COLS = `id, received_at, event_at, game_time_sec, killer_name, killer_steam_id, killer_faction, killer_faction_source,
  victim_name, victim_steam_id, victim_faction, victim_faction_source, weapon_id, weapon_name, vehicle_id, vehicle_name, flags, distance_m`;

/** 試合が無い・server と違う → 'not_found'(404 MATCH_NOT_FOUND) */
export async function listKills(
  db: D1Database,
  q: { server: ServerId; scope: KillfeedScope; after: { receivedAt: number; id: number; raw: string } | null },
  day: number,
): Promise<KillfeedKillsResponse | 'not_found'> {
  const sid = Number(q.server);
  const unrecorded = q.scope === KILLFEED_UNRECORDED;
  const match = unrecorded ? null : await getMatchSummary(db, Number(q.scope));
  if (!unrecorded && (!match || match.serverId !== q.server)) return 'not_found';
  const rid = unrecorded ? 0 : Number(q.scope);

  let rows: KillRow[];
  let truncated: boolean;
  if (q.after) {
    const { results } = await db
      .prepare(
        `SELECT ${KILL_COLS} FROM feed_kills
          WHERE server_id = ?1 AND recording_id = ?2 AND (received_at > ?3 OR (received_at = ?3 AND id > ?4))
          ORDER BY received_at, id LIMIT ?5`,
      )
      .bind(sid, rid, q.after.receivedAt, q.after.id, KILLFEED_INCREMENT_MAX + 1)
      .all<KillRow>();
    rows = results ?? [];
    truncated = rows.length > KILLFEED_INCREMENT_MAX;
    rows = rows.slice(0, KILLFEED_INCREMENT_MAX);
  } else if (unrecorded) {
    const { results } = await db
      .prepare(`SELECT ${KILL_COLS} FROM feed_kills WHERE server_id = ?1 AND recording_id = 0 ORDER BY received_at DESC, id DESC LIMIT ?2`)
      .bind(sid, KILLFEED_UNRECORDED_MAX + 1)
      .all<KillRow>();
    rows = results ?? [];
    truncated = rows.length > KILLFEED_UNRECORDED_MAX;
    rows = rows.slice(0, KILLFEED_UNRECORDED_MAX).reverse();
  } else {
    const { results } = await db
      .prepare(`SELECT ${KILL_COLS} FROM feed_kills WHERE server_id = ?1 AND recording_id = ?2 ORDER BY received_at, id LIMIT ?3`)
      .bind(sid, rid, KILLFEED_MATCH_KILLS_MAX + 1)
      .all<KillRow>();
    rows = results ?? [];
    truncated = rows.length > KILLFEED_MATCH_KILLS_MAX;
    rows = rows.slice(0, KILLFEED_MATCH_KILLS_MAX);
  }
  const kills = rows.map(rowToKill);

  // 陣営の表示順: 試合の最後のサンプルの factionScores の順 → キルに現れた順
  const factions: string[] = [];
  const addFaction = (f: string | null | undefined) => {
    if (f && !factions.includes(f)) factions.push(f);
  };
  for (const s of match?.lastScores ?? []) addFaction(s.faction);
  for (const k of kills) {
    addFaction(k.killer?.faction);
    addFaction(k.victim?.faction);
  }

  const last = kills[kills.length - 1];
  const cursor = last ? `${last.receivedAt}-${last.id}` : (q.after?.raw ?? null);
  const configured = (await db.prepare('SELECT 1 AS x FROM server_feeds WHERE server_id = ?1').bind(sid).first()) !== null;
  return {
    server: q.server,
    scope: q.scope,
    match,
    factions,
    kills,
    cursor,
    incremental: q.after !== null,
    truncated,
    today: await readIngestCounts(db, q.server, day),
    configured,
  };
}

// ============================================================
// 正規化の試行(GET /api/feed/raw/:id/normalized。何も保存しない)
// ============================================================

/** 保存済みの生データ 1 件に今の対応表で正規化を試す。生データが無い(期限切れ・別サーバー)なら null */
export async function previewRawNormalized(db: D1Database, server: ServerId, entryId: number): Promise<FeedNormalizePreviewResponse | null> {
  const row = await db
    .prepare('SELECT id, received_at, body FROM feed_raw_events WHERE id = ?1 AND server_id = ?2')
    .bind(entryId, Number(server))
    .first<{ id: number; received_at: number; body: string }>();
  if (!row) return null;
  const receivedAt = Number(row.received_at);
  const norm = normalizeFeedBatch(row.body, { receivedAt, diagnostics: true, previewMax: FEED_NORMALIZE_PREVIEW_MAX });
  return {
    server,
    entryId: Number(row.id),
    receivedAt,
    envelope: norm?.envelope ?? 'unknown',
    events: norm?.diagnostics ?? [],
    counts: norm?.counts ?? { kill: 0, other: 0, incomplete: 0, invalid: 0 },
    bigIntegersQuoted: norm?.bigIntegersQuoted ?? 0,
  };
}
