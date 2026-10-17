// 既知のマップ一覧(RCON の GET /v1/catalog/maps が使えない・空のときの代替)。
// 2026-10-18 時点で運営者が確認した WARDOGS のマップ名。id の正式な形式は未確認(要確認 R-11)のため、
// 表示名をそのまま id として使う。カタログが取得できたときは常にそちらを優先する。
import type { MapsResponse } from '../../types/api';

export const KNOWN_MAP_NAMES = ['Zestafona', 'Ozeti', 'Bakurani'] as const;

export function builtinMaps(fetchedAt: number): MapsResponse {
  return {
    maps: KNOWN_MAP_NAMES.map((name) => ({ id: name, displayName: name })),
    fetchedAt,
    source: 'builtin',
  };
}

/** カタログの結果が使えるなら source を付けて返し、空なら既知の一覧に置き換える */
export function withMapsFallback(catalog: MapsResponse | null, fetchedAt: number): MapsResponse {
  if (catalog && catalog.maps.length > 0) return { ...catalog, source: 'catalog' };
  return builtinMaps(fetchedAt);
}
