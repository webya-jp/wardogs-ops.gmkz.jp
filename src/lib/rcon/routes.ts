// 本パネルが使う RCON ルートの固定リスト。docs/API.md 6 章(ルートの実在・形式はすべて非公式資料ベースの未検証。R-1)。
// ここに無いルートは RCON に送らない。`PUT /v1/config` 等は第 2 段階まで追加しない。
import type { ActionParamsMap, ReadKind, WriteAction } from '../../types/api';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface RouteDef {
  method: HttpMethod;
  /** パラメータ部は {steamId} の形 */
  template: string;
}

/** 監査ログ・ログ用のルート名("POST /v1/players/{steamId}/kick")。接続先や実際の Steam ID は含めない */
export function routeKey(r: RouteDef): string {
  return `${r.method} ${r.template}`;
}

export const CAPABILITIES_ROUTE: RouteDef = { method: 'GET', template: '/v1/capabilities' };

export const READ_ROUTES: Record<ReadKind, RouteDef> = {
  status: { method: 'GET', template: '/v1/status' },
  players: { method: 'GET', template: '/v1/players' },
  bans: { method: 'GET', template: '/v1/bans' },
  maps: { method: 'GET', template: '/v1/catalog/maps' },
};

/**
 * 次のマップ・ローテーション件数(/api/status の補助。docs/API.md 3 章)。CapabilitiesResponse.read には足さない。
 * capabilities の routes にあるときだけ呼ぶ
 */
export const ROTATION_ROUTE: RouteDef = { method: 'GET', template: '/v1/rotation' };

export const WRITE_ROUTES: Record<WriteAction, RouteDef> = {
  kick: { method: 'POST', template: '/v1/players/{steamId}/kick' },
  ban: { method: 'POST', template: '/v1/bans' },
  unban: { method: 'DELETE', template: '/v1/bans/{steamId}' },
  broadcast: { method: 'POST', template: '/v1/broadcast' },
  message: { method: 'POST', template: '/v1/players/{steamId}/message' },
  map: { method: 'POST', template: '/v1/match/map' },
  match_end: { method: 'POST', template: '/v1/match/end' },
};

export interface BuiltRequest {
  route: RouteDef;
  path: string;
  /** undefined なら本文を送らない */
  body?: Record<string, unknown>;
}

const enc = encodeURIComponent;

/** 検証済みの params から RCON への要求を組み立てる(送る本文は docs/API.md 6.2 のとおり) */
export function buildWriteRequest<A extends WriteAction>(action: A, params: ActionParamsMap[A]): BuiltRequest {
  const route = WRITE_ROUTES[action];
  switch (action) {
    case 'kick': {
      const p = params as ActionParamsMap['kick'];
      return { route, path: `/v1/players/${enc(p.steamId)}/kick`, body: p.reason ? { reason: p.reason } : {} };
    }
    case 'ban': {
      const p = params as ActionParamsMap['ban'];
      return { route, path: '/v1/bans', body: p.reason ? { steamId: p.steamId, reason: p.reason } : { steamId: p.steamId } };
    }
    case 'unban': {
      const p = params as ActionParamsMap['unban'];
      return { route, path: `/v1/bans/${enc(p.steamId)}` };
    }
    case 'broadcast': {
      const p = params as ActionParamsMap['broadcast'];
      return { route, path: '/v1/broadcast', body: { message: p.message } };
    }
    case 'message': {
      const p = params as ActionParamsMap['message'];
      return { route, path: `/v1/players/${enc(p.steamId)}/message`, body: { message: p.message } };
    }
    case 'map': {
      const p = params as ActionParamsMap['map'];
      return { route, path: '/v1/match/map', body: { map: p.map } };
    }
    case 'match_end':
      // 本文の要否は未確認(R-12)。空 JSON を送る
      return { route, path: '/v1/match/end', body: {} };
    default:
      throw new Error('unknown action');
  }
}
