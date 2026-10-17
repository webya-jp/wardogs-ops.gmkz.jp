// キルフィードの表示用の整形(docs/ARCHITECTURE.md 17.10.7)。文言はカタログ、数値・時刻は Intl(locale とタイムゾーンを渡す)。
// プレイヤー名・武器名・乗り物名は生データ(翻訳しない)。
import { formatDateTime, formatNumber } from '../../i18n';
import type { KillEvent, KillParty } from '../../types/api';
import type { I18n } from './hooks';

/** 時:分(グラフの目盛り・時間帯の表示) */
export function hm(i18n: I18n, epochMs: number): string {
  return formatDateTime(epochMs, i18n.locale, i18n.timeZone, { hour: '2-digit', minute: '2-digit' });
}

/** 割合(0〜1)。null は「−」 */
export function pct(i18n: I18n, rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return i18n.t('common.none');
  return formatNumber(rate, i18n.locale, { style: 'percent', maximumFractionDigits: 1 });
}

/** 距離(m。小数第 1 位まで) */
export function meters(i18n: I18n, m: number): string {
  return formatNumber(m, i18n.locale, { maximumFractionDigits: 1 });
}

/** 小数第 2 位まで(K/D) */
export function ratio(i18n: I18n, v: number): string {
  return formatNumber(v, i18n.locale, { maximumFractionDigits: 2 });
}

/** 当事者の表示名(キラーが null は「(環境・不明)」、名前が null は「(名前不明)」) */
export function partyName(i18n: I18n, p: KillParty | null): string {
  if (!p) return i18n.t('killfeed.log.environment');
  return p.name ?? i18n.t('killfeed.log.unknownPlayer');
}

/** 武器・原因(乗り物があれば「乗り物 · 武器」。名前が無ければ内部 ID。両方無ければ「不明」) */
export function weaponLabel(i18n: I18n, k: Pick<KillEvent, 'weapon' | 'vehicle'>): string {
  const w = k.weapon.name ?? k.weapon.id;
  const v = k.vehicle ? (k.vehicle.name ?? k.vehicle.id) : null;
  if (v !== null && w !== null) return i18n.t('killfeed.weapons.vehicleWeapon', { vehicle: v, weapon: w });
  return v ?? w ?? i18n.t('killfeed.weapons.unknown');
}
