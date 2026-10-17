// RCON 応答の正規化。docs/API.md 6.1、src/types/api.ts。
// 形式はすべて非公式資料ベースの未検証(R-8, R-9, R-11)。解釈できない項目は null にし、
// 最上位の形が想定と違えば null を返す(呼び出し側で RCON_BAD_RESPONSE)。生の応答は返さない。
import { STATUS_EXPERIENCE_MAX_LENGTH, STATUS_EXPERIENCES_MAX } from '../../types/api';
import type {
  Ban,
  BansResponse,
  FactionScore,
  MapsResponse,
  Player,
  PlayersResponse,
  StatusResponse,
  StatusRotation,
} from '../../types/api';

const STR_MAX = 256;
const MAX_PLAYERS = 1000;
const MAX_BANS = 10_000;
const MAX_MAPS = 2000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = STR_MAX): string | null {
  if (typeof v !== 'string') return null;
  const s = Array.from(v.replace(/[\p{Cc}\u2028\u2029]/gu, '')).slice(0, max).join('');
  return s === '' ? null : s;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

/**
 * Steam ID: 文字列はそのまま(制御文字を除く)。数値は安全な整数のときだけ文字列化する
 * (SteamID64 を JSON の number で受けると精度が落ちるため、別人を操作しないよう空にして操作ボタンを無効にさせる)
 */
function steamId(v: unknown): string {
  if (typeof v === 'string') return v.replace(/[\p{Cc}\s]/gu, '').slice(0, 64);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return '';
}

function faction(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return str(v);
}

export function normalizeStatus(data: unknown, fetchedAt: number): StatusResponse | null {
  if (!isObj(data)) return null;
  const players = isObj(data.players) ? data.players : {};
  const rotation = isObj(data.rotation) ? data.rotation : {};
  const scores: FactionScore[] = Array.isArray(data.factionScores)
    ? data.factionScores.slice(0, 16).map((s): FactionScore => {
        if (typeof s === 'number') return { faction: null, score: num(s) };
        if (isObj(s)) return { faction: faction(s.faction ?? s.name ?? s.team), score: num(s.score ?? s.points) };
        return { faction: null, score: null };
      })
    : [];
  return {
    serverName: str(data.serverName),
    map: str(data.map),
    players: { current: int(players.current), max: int(players.max) },
    factionScores: scores,
    rotation: {
      nowIndex: int(rotation.nowIndex),
      nextIndex: int(rotation.nextIndex),
      // 以下 3 項目は /v1/rotation から補う(reads.ts の readStatus)。ここでは null
      count: null,
      nextMap: null,
      nextMapName: null,
    },
    experiences: normalizeExperiences(data.experiences),
    fetchedAt,
  };
}

/** status.experiences[]: 文字列の要素だけを先頭から上限件数・上限文字数まで(要確認 R-19) */
export function normalizeExperiences(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v.slice(0, 100)) {
    if (out.length >= STATUS_EXPERIENCES_MAX) break;
    const s = str(e, STATUS_EXPERIENCE_MAX_LENGTH);
    if (s !== null) out.push(s);
  }
  return out;
}

// ---- GET /v1/rotation(docs/research/wardogs-rcon.md 2.1。形 {enabled, mode, entries[]} は未検証。R-19) ----

const MAX_ROTATION_ENTRIES = 2000;

export interface RotationEntry {
  map: string | null;
  displayName: string | null;
}

/** /v1/rotation を解釈した結果(isolate 内にキャッシュする。nextIndex は毎回 /v1/status の値を使う) */
export interface ParsedRotation {
  /** enabled が boolean でなければ null(無効とはみなさない) */
  enabled: boolean | null;
  /** entries の件数(要素の形式が解釈できなくても数える) */
  count: number;
  entries: RotationEntry[];
}

function rotationEntry(e: unknown): RotationEntry {
  if (typeof e === 'string') return { map: str(e), displayName: null };
  if (!isObj(e)) return { map: null, displayName: null };
  // map が { id, displayName } の形で入っている場合にも対応する
  const m = e.map ?? e.mapId ?? e.id;
  if (isObj(m)) return { map: str(m.id ?? m.mapId), displayName: str(m.displayName ?? m.name) };
  return { map: str(m), displayName: str(e.displayName ?? e.mapName ?? e.name) };
}

/** 最上位が { entries: [] } でなければ null(呼び出し側で失敗扱い) */
export function parseRotation(data: unknown): ParsedRotation | null {
  if (!isObj(data) || !Array.isArray(data.entries)) return null;
  return {
    enabled: typeof data.enabled === 'boolean' ? data.enabled : null,
    count: data.entries.length,
    entries: data.entries.slice(0, MAX_ROTATION_ENTRIES).map(rotationEntry),
  };
}

/**
 * status の rotation に /v1/rotation の結果を重ねる。rotation が無い・取れない・enabled: false なら 3 項目とも null。
 * nextIndex が範囲外・要素を解釈できない場合は nextMap / nextMapName だけ null
 */
export function applyRotation(base: StatusRotation, parsed: ParsedRotation | null): StatusRotation {
  if (!parsed || parsed.enabled === false) return { ...base, count: null, nextMap: null, nextMapName: null };
  const i = base.nextIndex;
  const entry = i !== null && i >= 0 && i < parsed.entries.length ? parsed.entries[i] : undefined;
  const nextMap = entry?.map ?? null;
  return { ...base, count: parsed.count, nextMap, nextMapName: nextMap === null ? null : (entry?.displayName ?? null) };
}

export function normalizePlayers(data: unknown, fetchedAt: number): PlayersResponse | null {
  const list = isObj(data) ? data.players : Array.isArray(data) ? data : undefined;
  if (!Array.isArray(list)) return null;
  const players: Player[] = [];
  for (const p of list.slice(0, MAX_PLAYERS)) {
    if (!isObj(p)) continue;
    players.push({
      steamId: steamId(p.steamId),
      name: str(p.name) ?? '',
      faction: faction(p.faction),
      kills: int(p.kills),
      deaths: int(p.deaths),
      pingMs: num(p.pingMs),
    });
  }
  return { players, count: players.length, fetchedAt };
}

/** bannedAtUtc: ISO 文字列 / epoch(秒またはミリ秒)を epoch ミリ秒に */
export function parseBannedAt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e12 ? Math.round(v) : Math.round(v * 1000);
  if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim();
    // タイムゾーン表記が無い ISO 形式は UTC とみなす(名前が bannedAtUtc のため)
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t) ? `${t}Z` : t;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function normalizeBans(data: unknown, fetchedAt: number): BansResponse | null {
  const list = isObj(data) ? data.bans : Array.isArray(data) ? data : undefined;
  if (!Array.isArray(list)) return null;
  const bans: Ban[] = [];
  for (const b of list.slice(0, MAX_BANS)) {
    if (typeof b === 'string') {
      bans.push({ steamId: steamId(b), bannedAt: null, bannedBy: null, reason: null, knownName: null });
      continue;
    }
    if (!isObj(b)) continue;
    bans.push({
      steamId: steamId(b.steamId),
      bannedAt: parseBannedAt(b.bannedAtUtc ?? b.bannedAt),
      bannedBy: str(b.bannedBy),
      reason: str(b.reason),
      knownName: null,
    });
  }
  return { bans, count: bans.length, fetchedAt };
}

export function normalizeMaps(data: unknown, fetchedAt: number): MapsResponse | null {
  const list = isObj(data) ? data.maps : Array.isArray(data) ? data : undefined;
  if (!Array.isArray(list)) return null;
  const maps: MapsResponse['maps'] = [];
  for (const m of list.slice(0, MAX_MAPS)) {
    if (typeof m === 'string') {
      const id = str(m);
      if (id) maps.push({ id, displayName: null });
      continue;
    }
    if (!isObj(m)) continue;
    const id = str(m.id);
    if (id) maps.push({ id, displayName: str(m.displayName ?? m.name) });
  }
  return { maps, fetchedAt };
}
