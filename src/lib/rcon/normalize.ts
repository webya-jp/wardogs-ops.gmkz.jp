// RCON 応答の正規化。docs/API.md 6.1、src/types/api.ts。
// 形式はすべて非公式資料ベースの未検証(R-8, R-9, R-11)。解釈できない項目は null にし、
// 最上位の形が想定と違えば null を返す(呼び出し側で RCON_BAD_RESPONSE)。生の応答は返さない。
import type { Ban, BansResponse, FactionScore, MapsResponse, Player, PlayersResponse, StatusResponse } from '../../types/api';

const STR_MAX = 256;
const MAX_PLAYERS = 1000;
const MAX_BANS = 10_000;
const MAX_MAPS = 2000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = Array.from(v.replace(/[\p{Cc}\u2028\u2029]/gu, '')).slice(0, STR_MAX).join('');
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
    rotation: { nowIndex: int(rotation.nowIndex), nextIndex: int(rotation.nextIndex) },
    fetchedAt,
  };
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
