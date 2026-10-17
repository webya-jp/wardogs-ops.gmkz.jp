import { describe, expect, it } from 'vitest';
import { KNOWN_MAP_NAMES, builtinMaps, withMapsFallback } from './known-maps';

describe('known-maps', () => {
  it('既知のマップ一覧は 3 件', () => {
    expect([...KNOWN_MAP_NAMES]).toEqual(['Zestafona', 'Ozeti', 'Bakurani']);
    expect(builtinMaps(1).maps.map((m) => m.id)).toEqual(['Zestafona', 'Ozeti', 'Bakurani']);
    expect(builtinMaps(1).source).toBe('builtin');
  });
  it('カタログがあればそれを優先し、空なら既知の一覧に置き換える', () => {
    const catalog = { maps: [{ id: 'x', displayName: 'X' }], fetchedAt: 5 };
    expect(withMapsFallback(catalog, 9)).toEqual({ ...catalog, source: 'catalog' });
    expect(withMapsFallback({ maps: [], fetchedAt: 5 }, 9)).toEqual(builtinMaps(9));
    expect(withMapsFallback(null, 9)).toEqual(builtinMaps(9));
  });
});
