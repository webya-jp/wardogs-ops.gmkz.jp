// 実行時に外から来た文字列(D1 の event・error_code など)がカタログのキーか確かめる。
// 無いキーで t() を呼ぶと文言が引けないため、表示前にここで確認する。
import { ja } from '../../i18n/ja';
import type { MessageKey, Translator } from '../../i18n';

export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(ja, key);
}

/** API から来たコード(終了理由・受信の理由など)から組み立てたキーを引く。カタログに無ければ「不明」 */
export function tCode(t: Translator, key: string): string {
  return isMessageKey(key) ? t(key) : t('common.unknown');
}
