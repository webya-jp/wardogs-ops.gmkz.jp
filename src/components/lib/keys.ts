// 実行時に外から来た文字列(D1 の event・error_code など)がカタログのキーか確かめる。
// 無いキーで t() を呼ぶと文言が引けないため、表示前にここで確認する。
import { ja } from '../../i18n/ja';
import type { MessageKey } from '../../i18n';

export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(ja, key);
}
