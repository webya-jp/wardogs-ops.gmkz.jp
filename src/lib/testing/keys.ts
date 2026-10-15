// テスト専用: 固定のダミー instance_key から鍵を作る(本番コードからは import しない)。
import { deriveKeysFrom } from '../keys';
import type { DerivedKeys } from '../keys';

/** seed ごとに異なる 32 バイトのダミー instance_key から鍵を派生する */
export function testKeys(seed = 1): Promise<DerivedKeys> {
  return deriveKeysFrom(new Uint8Array(32).fill(seed));
}
