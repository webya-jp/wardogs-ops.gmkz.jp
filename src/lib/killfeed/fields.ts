// キルフィードの正規化の対応表(**この 1 か所**)。docs/ARCHITECTURE.md 17.10.2。
// 届く本文の実際の項目名は未確認(要確認 K-1、K-9〜K-14)。下の候補名はすべて推測で、観測で本物の形を見たら
// 該当行の**先頭**に実際のキー名を足す(normalize.test.ts に本物の形のダミーを 1 件足してからデプロイする)。
// 候補は先頭から試し、型の検証に通った最初の値を使う。パスはドット区切り。
import type { KillFieldName } from '../../types/api';

/** 候補: パス(ドット区切り)か、数値に掛ける倍率付きのパス(cm → m など) */
export type FieldCandidate = string | { path: string; scale?: number };

/** 当事者の入れ子のオブジェクトの名前(キラー側 / 被害者側) */
const KILLER_OBJECTS = ['killer'] as const;
const VICTIM_OBJECTS = ['victim', 'killed', 'target', 'dead', 'player'] as const;

const NAME_KEYS = ['name', 'playerName', 'displayName', 'nick'] as const;
const STEAM_KEYS = ['steamId', 'steamID', 'steam_id', 'steamId64', 'playerId', 'uniqueId', 'id'] as const;
const FACTION_KEYS = ['faction', 'team', 'teamName', 'side'] as const;

const nested = (objs: readonly string[], keys: readonly string[]): string[] => objs.flatMap((o) => keys.map((k) => `${o}.${k}`));

/**
 * 項目ごとの候補名。`killer` / `victim` などの当事者のキー自体(文字列のとき)は normalize.ts が
 * 「17 桁なら Steam ID、それ以外は名前」として別に読む(この表の末尾の扱い。17.10.2 の表の `killer`(文字列))
 */
export const KILL_FIELD_CANDIDATES: Record<KillFieldName, readonly FieldCandidate[]> = {
  type: ['type', 'event', 'eventType', 'kind', 'action'],
  eventAt: ['timestamp', 'time', 'at', 'occurredAt', 'createdAt', 'utc', 'ts'],
  gameTimeSec: ['gameTime', 'gameTimeSec', 'matchTime', 'matchSeconds', 'elapsed', 'elapsedSec', 'roundTime'],

  killerName: [
    ...nested(KILLER_OBJECTS, NAME_KEYS),
    'attacker.name',
    'attacker.playerName',
    'instigator.name',
    'killerName',
    'killer_name',
    'attackerName',
    'attacker_name',
    'killer',
  ],
  killerSteamId: [
    ...nested(KILLER_OBJECTS, STEAM_KEYS),
    'attacker.steamId',
    'attacker.id',
    'instigator.steamId',
    'killerSteamId',
    'killer_steam_id',
    'killerId',
    'attackerSteamId',
    'killer',
  ],
  killerFaction: [
    ...nested(KILLER_OBJECTS, FACTION_KEYS),
    'attacker.faction',
    'attacker.team',
    'killerFaction',
    'killerTeam',
    'killer_team',
    'attackerTeam',
  ],

  victimName: [...nested(VICTIM_OBJECTS, NAME_KEYS), 'victimName', 'victim_name', ...VICTIM_OBJECTS],
  victimSteamId: [...nested(VICTIM_OBJECTS, STEAM_KEYS), 'victimSteamId', 'victim_steam_id', 'victimId', ...VICTIM_OBJECTS],
  victimFaction: [...nested(VICTIM_OBJECTS, FACTION_KEYS), 'victimFaction', 'victimTeam', 'victim_team'],

  weaponId: ['weapon.id', 'weapon.code', 'weapon.class', 'weaponId', 'weapon_id', 'weaponClass', 'damageType'],
  weaponName: ['weapon.name', 'weapon.displayName', 'weaponName', 'weapon_name', 'weapon', 'vehicleWeapon', 'seatWeapon', 'cause', 'causeName'],
  vehicleId: ['vehicle.id', 'vehicle.code', 'vehicleId', 'vehicle_id', 'killerVehicle.id'],
  vehicleName: ['vehicle.name', 'vehicle.displayName', 'vehicleName', 'vehicle_name', 'vehicle', 'killerVehicle.name'],

  // distance の単位(m か cm か)は要確認 K-9
  distanceM: ['distanceM', 'distance_m', 'distanceMeters', 'distance', 'range', { path: 'distanceCm', scale: 0.01 }, { path: 'distance_cm', scale: 0.01 }],

  headshot: ['headshot', 'isHeadshot', 'headShot', 'hs'],
  penetration: ['penetration', 'isPenetration', 'penetrated', 'wallbang'],
  roadkill: ['roadkill', 'isRoadkill', 'roadKill'],
  vehicleExplosion: ['vehicleExplosion', 'isVehicleExplosion', 'vehicle_explosion'],
  suicide: ['suicide', 'isSuicide'],
  flagList: ['flags', 'tags', 'modifiers', 'hitFlags'],
};

/**
 * 当事者のキーそのもの(`killer` / `victim` 等)が文字列のときの扱い: 17 桁なら Steam ID、それ以外は名前。
 * normalize.ts はこの集合のパスを「文字列で、Steam ID / 名前のどちらに当たるか」で検証する
 */
export const PARTY_SCALAR_PATHS: ReadonlySet<string> = new Set([...KILLER_OBJECTS, ...VICTIM_OBJECTS]);

/** 種類の値(英数字以外を除いて小文字にしたもの)がこのどれかならキル */
export const KILL_EVENT_TYPES: ReadonlySet<string> = new Set(['killed', 'kill', 'playerkilled', 'death', 'playerdied']);

/** flagList の語(大文字・英数字だけにしたもの)→ 印 */
export const FLAG_WORDS: Readonly<Record<string, 'headshot' | 'penetration' | 'roadkill' | 'vehicleExplosion' | 'suicide'>> = {
  HEADSHOT: 'headshot',
  PENETRATION: 'penetration',
  WALLBANG: 'penetration',
  ROADKILL: 'roadkill',
  VEHICLEEXPLOSION: 'vehicleExplosion',
  SUICIDE: 'suicide',
};
