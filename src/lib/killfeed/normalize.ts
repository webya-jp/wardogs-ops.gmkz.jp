// キルフィードの正規化(受信した本文 → KillEvent)。docs/ARCHITECTURE.md 17.10.2。
// 純粋関数(D1・時刻に依存しない。受信時刻は引数)。受信(feed.ts)と正規化の試行の API(GET /api/feed/raw/:id/normalized)が同じ関数を使う。
// 候補名の対応表は fields.ts の 1 か所。届く本文の実際の項目名は未確認(K-1、K-9〜K-14)で、読めない項目は null にする。
// 名前・Steam ID・本文をログに出さない(この関数はログを出さない)。
import {
  FEED_NORMALIZE_PREVIEW_MAX,
  KILL_FIELD_NAMES,
  KILL_FLAGS,
  KILLFEED_DISTANCE_MAX_M,
  KILLFEED_LABEL_MAX_LENGTH,
  KILLFEED_MAX_KILLS_PER_BATCH,
  KILLFEED_NAME_MAX_LENGTH,
  STEAM_ID_PATTERN,
} from '../../types/api';
import type {
  FeedEnvelope,
  FeedNormalizedEvent,
  FeedNormalizeResult,
  KillEvent,
  KillFieldName,
  KillFlag,
  KillParty,
} from '../../types/api';
import { FLAG_WORDS, KILL_EVENT_TYPES, KILL_FIELD_CANDIDATES, PARTY_SCALAR_PATHS } from './fields';
import type { FieldCandidate } from './fields';

/** 正規化したキル(id は保存時、teamkill は読み取り時に決まる) */
export type NormalizedKill = Omit<KillEvent, 'id' | 'teamkill'>;

const DAY_MS = 24 * 60 * 60 * 1000;
const TYPE_MAX_LENGTH = 64;
const UNMAPPED_KEYS_MAX = 32;
const GAME_TIME_MAX_SEC = 86_400;

// ============================================================
// 1. 本文を読む(16 桁以上の整数を文字列として読む。K-10)
// ============================================================

const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/**
 * JSON の文字列の外にある、引用符の無い 16 桁以上の整数(先頭が 0 でなく、小数点・指数・符号が付かないもの)を
 * 引用符で囲む(JSON.parse で 2^53 を超える桁が落ちるのを避ける)。文字列の内外とエスケープを追う 1 回の走査
 */
export function quoteBigIntegers(text: string): { text: string; count: number } {
  const n = text.length;
  let out = '';
  let last = 0;
  let count = 0;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      // 文字列を読み飛ばす(\ の次の 1 文字は見ない)
      i += 1;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === 34) {
          i += 1;
          break;
        } else i += 1;
      }
      continue;
    }
    if (c === 45 || isDigit(c)) {
      const start = i;
      if (c === 45) i += 1;
      while (i < n && isDigit(text.charCodeAt(i))) i += 1;
      const intEnd = i;
      let integer = true;
      if (i < n && text.charCodeAt(i) === 46) {
        integer = false;
        i += 1;
        while (i < n && isDigit(text.charCodeAt(i))) i += 1;
      }
      if (i < n && (text.charCodeAt(i) === 101 || text.charCodeAt(i) === 69)) {
        integer = false;
        i += 1;
        if (i < n && (text.charCodeAt(i) === 43 || text.charCodeAt(i) === 45)) i += 1;
        while (i < n && isDigit(text.charCodeAt(i))) i += 1;
      }
      if (integer && c !== 45 && c !== 48 && intEnd - start >= 16) {
        out += `${text.slice(last, start)}"${text.slice(start, intEnd)}"`;
        last = intEnd;
        count += 1;
      }
      continue;
    }
    i += 1;
  }
  return count === 0 ? { text, count } : { text: out + text.slice(last), count };
}

export type ParsedFeedJson = { ok: true; value: unknown; bigIntegersQuoted: number } | { ok: false };

/** 長い整数を守って JSON として読む。読めなければ ok: false(受信は 400 bad_json) */
export function parseFeedJson(text: string): ParsedFeedJson {
  const q = quoteBigIntegers(text);
  try {
    return { ok: true, value: JSON.parse(q.text) as unknown, bigIntegersQuoted: q.count };
  } catch {
    return { ok: false };
  }
}

// ============================================================
// 値の取り出しと検証
// ============================================================

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 制御文字を除き、前後の空白を落とし、max 文字(コードポイント)まで。空なら null */
function cleanText(v: string, max: number): string | null {
  const s = Array.from(v.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '').trim()).slice(0, max).join('');
  return s === '' ? null : s;
}

function textValue(v: unknown, max: number, allowNumber: boolean): string | null {
  if (typeof v === 'string') return cleanText(v, max);
  if (allowNumber && typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function steamIdValue(v: unknown): string | null {
  let s: string | null = null;
  if (typeof v === 'string') s = v.trim();
  else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) s = String(v);
  return s !== null && STEAM_ID_PATTERN.test(s) ? s : null;
}

function boolValue(v: unknown): boolean | null {
  if (v === true || v === 1 || v === 'true') return true;
  if (v === false || v === 0 || v === 'false') return false;
  return null;
}

function numberValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

function eventAtValue(v: unknown, receivedAt: number): number | null {
  let ms: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 1e12) ms = Math.round(v);
    else if (v >= 1e9) ms = Math.round(v * 1000);
  } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim())) {
    const t = Date.parse(v.trim());
    ms = Number.isFinite(t) ? t : null;
  }
  if (ms === null || Math.abs(ms - receivedAt) > DAY_MS) return null;
  return ms;
}

function gameTimeValue(v: unknown): number | null {
  let sec: number | null = null;
  if (typeof v === 'string') {
    const m = /^\s*(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?:\.\d+)?\s*$/.exec(v);
    if (m) sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    else sec = numberValue(v);
  } else sec = numberValue(v);
  return sec !== null && sec >= 0 && sec <= GAME_TIME_MAX_SEC ? sec : null;
}

function distanceValue(v: unknown, scale: number): number | null {
  const n = numberValue(v);
  if (n === null) return null;
  const m = Math.round(n * scale * 10) / 10;
  return m >= 0 && m <= KILLFEED_DISTANCE_MAX_M ? m : null;
}

function flagListValue(v: unknown): KillFlag[] | null {
  let words: unknown[];
  if (Array.isArray(v)) words = v;
  else if (typeof v === 'string') words = v.split(/[\s,|;/+]+/);
  else return null;
  const out: KillFlag[] = [];
  for (const w of words.slice(0, 64)) {
    if (typeof w !== 'string') continue;
    const flag = FLAG_WORDS[w.toUpperCase().replace(/[^A-Z0-9]/g, '')];
    if (flag && !out.includes(flag)) out.push(flag);
  }
  return out;
}

type FieldValue = string | number | boolean | KillFlag[];

/** 1 項目の値を検証・変換する(通らなければ null で、次の候補を試す) */
function validate(field: KillFieldName, path: string, raw: unknown, scale: number, receivedAt: number): FieldValue | null {
  if (raw === undefined || raw === null) return null;
  // 当事者のキーそのもの(killer / victim 等)が文字列: 17 桁なら Steam ID、それ以外は名前
  if (PARTY_SCALAR_PATHS.has(path)) {
    if (typeof raw !== 'string') return null;
    const isId = STEAM_ID_PATTERN.test(raw.trim());
    if (field === 'killerSteamId' || field === 'victimSteamId') return isId ? raw.trim() : null;
    return isId ? null : cleanText(raw, KILLFEED_NAME_MAX_LENGTH);
  }
  switch (field) {
    case 'type':
      return textValue(raw, TYPE_MAX_LENGTH, false);
    case 'eventAt':
      return eventAtValue(raw, receivedAt);
    case 'gameTimeSec':
      return gameTimeValue(raw);
    case 'killerName':
    case 'victimName':
      return textValue(raw, KILLFEED_NAME_MAX_LENGTH, false);
    case 'killerSteamId':
    case 'victimSteamId':
      return steamIdValue(raw);
    case 'killerFaction':
    case 'victimFaction':
      return textValue(raw, KILLFEED_NAME_MAX_LENGTH, true);
    case 'weaponId':
    case 'vehicleId':
      return textValue(raw, KILLFEED_LABEL_MAX_LENGTH, true);
    case 'weaponName':
    case 'vehicleName':
      return textValue(raw, KILLFEED_LABEL_MAX_LENGTH, false);
    case 'distanceM':
      return distanceValue(raw, scale);
    case 'flagList':
      return flagListValue(raw);
    default:
      // headshot / penetration / roadkill / vehicleExplosion / suicide
      return boolValue(raw);
  }
}

const candidatePath = (c: FieldCandidate): { path: string; scale: number } =>
  typeof c === 'string' ? { path: c, scale: 1 } : { path: c.path, scale: c.scale ?? 1 };

interface Extracted {
  values: Partial<Record<KillFieldName, FieldValue>>;
  matched: Partial<Record<KillFieldName, string>>;
}

function extract(obj: Record<string, unknown>, receivedAt: number): Extracted {
  const values: Extracted['values'] = {};
  const matched: Extracted['matched'] = {};
  for (const field of KILL_FIELD_NAMES) {
    for (const c of KILL_FIELD_CANDIDATES[field]) {
      const { path, scale } = candidatePath(c);
      const v = validate(field, path, getPath(obj, path), scale, receivedAt);
      if (v !== null) {
        values[field] = v;
        matched[field] = path;
        break;
      }
    }
  }
  return { values, matched };
}

// ============================================================
// 2〜5. 外側の形・種類・組み立て
// ============================================================

const str = (v: FieldValue | undefined): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: FieldValue | undefined): number | null => (typeof v === 'number' ? v : null);

function party(name: FieldValue | undefined, steamId: FieldValue | undefined, faction: FieldValue | undefined): KillParty | null {
  const n = str(name);
  const id = str(steamId);
  if (n === null && id === null) return null;
  const f = str(faction);
  return { name: n, steamId: id, faction: f, factionSource: f === null ? null : 'event' };
}

function emptyFlags(): Record<KillFlag, boolean> {
  return { headshot: false, penetration: false, roadkill: false, vehicleExplosion: false, suicide: false };
}

/** 種類の値を英数字だけの小文字に */
const typeKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface NormalizeEventOptions {
  index: number;
  receivedAt: number;
  /** false なら unmappedKeys を作らない(受信の処理。CPU の節約)。既定 true */
  diagnostics?: boolean;
}

/** 1 イベントの正規化(診断込み)。オブジェクトでなければ invalid */
export function normalizeFeedEvent(value: unknown, opts: NormalizeEventOptions): FeedNormalizedEvent {
  if (!isObj(value)) return { index: opts.index, type: null, result: 'invalid', kill: null, matched: {}, unmappedKeys: [] };
  const { values: v, matched } = extract(value, opts.receivedAt);
  const type = str(v.type);
  const killer = party(v.killerName, v.killerSteamId, v.killerFaction);
  const victim = party(v.victimName, v.victimSteamId, v.victimFaction);

  // 種類の項目が無ければ、被害者が読めるときだけキルとみなす(資料では種類は killed だけ)
  const isKill = type === null ? victim !== null : KILL_EVENT_TYPES.has(typeKey(type));
  let result: FeedNormalizeResult = isKill ? 'kill' : 'other';
  let kill: NormalizedKill | null = null;
  if (isKill) {
    if (killer === null && victim === null) result = 'incomplete';
    else {
      const flags = emptyFlags();
      for (const f of KILL_FLAGS) if (v[f] === true) flags[f] = true;
      if (Array.isArray(v.flagList)) for (const f of v.flagList) flags[f] = true;
      if (killer?.steamId && victim?.steamId && killer.steamId === victim.steamId) flags.suicide = true;
      const vehicleId = str(v.vehicleId);
      const vehicleName = str(v.vehicleName);
      kill = {
        receivedAt: opts.receivedAt,
        eventAt: numOrNull(v.eventAt),
        gameTimeSec: numOrNull(v.gameTimeSec),
        killer,
        victim,
        weapon: { id: str(v.weaponId), name: str(v.weaponName) },
        vehicle: vehicleId === null && vehicleName === null ? null : { id: vehicleId, name: vehicleName },
        flags,
        distanceM: numOrNull(v.distanceM),
      };
    }
  }

  if (opts.diagnostics === false) return { index: opts.index, type, result, kill, matched, unmappedKeys: [] };
  // どの候補にも使われなかった最上位のキー(値は含めない)
  const used = new Set(Object.values(matched).map((p) => (p as string).split('.')[0]));
  const unmappedKeys = Object.keys(value)
    .filter((k) => !used.has(k))
    .slice(0, UNMAPPED_KEYS_MAX)
    .map((k) => Array.from(k.replace(/[\p{Cc}]/gu, '')).slice(0, TYPE_MAX_LENGTH).join(''));
  return { index: opts.index, type, result, kill, matched, unmappedKeys };
}

/** 外側の形とイベントの並び */
export function envelopeOf(value: unknown): { envelope: FeedEnvelope; events: unknown[] } {
  if (Array.isArray(value)) return { envelope: 'array', events: value };
  if (isObj(value)) {
    if (Array.isArray(value.events)) return { envelope: 'events', events: value.events };
    const hasType = KILL_FIELD_CANDIDATES.type.some((c) => {
      const raw = getPath(value, candidatePath(c).path);
      return typeof raw === 'string' && raw.trim() !== '';
    });
    if (hasType) return { envelope: 'single', events: [value] };
  }
  return { envelope: 'unknown', events: [] };
}

export interface NormalizeBatchOptions {
  receivedAt: number;
  /** 項目ごとの診断(matched / unmappedKeys)を先頭から previewMax 件まで作る(受信では作らない) */
  diagnostics?: boolean;
  previewMax?: number;
  /** 1 バッチから返すキルの上限(既定 KILLFEED_MAX_KILLS_PER_BATCH)。超えた分は droppedKills */
  maxKills?: number;
}

export interface NormalizedBatch {
  envelope: FeedEnvelope;
  /** 先頭から maxKills 件まで */
  kills: NormalizedKill[];
  /** バッチ全体の件数(kill は上限で捨てた分を含む) */
  counts: Record<FeedNormalizeResult, number>;
  droppedKills: number;
  bigIntegersQuoted: number;
  diagnostics?: FeedNormalizedEvent[];
}

/** 読み済みの値(parseFeedJson の結果)を正規化する */
export function normalizeFeedValue(value: unknown, opts: NormalizeBatchOptions, bigIntegersQuoted = 0): NormalizedBatch {
  const { envelope, events } = envelopeOf(value);
  const maxKills = opts.maxKills ?? KILLFEED_MAX_KILLS_PER_BATCH;
  const previewMax = opts.previewMax ?? FEED_NORMALIZE_PREVIEW_MAX;
  const counts: Record<FeedNormalizeResult, number> = { kill: 0, other: 0, incomplete: 0, invalid: 0 };
  const kills: NormalizedKill[] = [];
  const diagnostics: FeedNormalizedEvent[] = [];
  let droppedKills = 0;
  events.forEach((e, index) => {
    const withDiag = opts.diagnostics === true && index < previewMax;
    const r = normalizeFeedEvent(e, { index, receivedAt: opts.receivedAt, diagnostics: withDiag });
    counts[r.result] += 1;
    if (r.kill) {
      if (kills.length < maxKills) kills.push(r.kill);
      else droppedKills += 1;
    }
    if (withDiag) diagnostics.push(r);
  });
  const out: NormalizedBatch = { envelope, kills, counts, droppedKills, bigIntegersQuoted };
  if (opts.diagnostics) out.diagnostics = diagnostics;
  return out;
}

/** 本文の文字列から正規化する。JSON として読めなければ null */
export function normalizeFeedBatch(bodyText: string, opts: NormalizeBatchOptions): NormalizedBatch | null {
  const parsed = parseFeedJson(bodyText);
  if (!parsed.ok) return null;
  return normalizeFeedValue(parsed.value, opts, parsed.bigIntegersQuoted);
}
