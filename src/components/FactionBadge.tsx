// 陣営の印(docs/ARCHITECTURE.md 17.10.7)。色だけで区別させないよう、陣営名の先頭 2 文字を書き、title と読み上げ用の文字に陣営名の全体を出す。
// 配色は factions(応答の陣営の表示順)の添字で、推移のグラフと同じトークン(--chart-1〜3、その他)。不明は「?」(読み上げは「陣営不明」)。
// 陣営名は生データ(翻訳しない。テキストとして描画する)。
import type { I18n } from './lib/hooks';
import { factionIndex, factionInitials } from './lib/killstats';

interface Props {
  i18n: I18n;
  faction: string | null;
  factions: readonly string[];
}

export default function FactionBadge({ i18n, faction, factions }: Props) {
  const { t } = i18n;
  if (faction === null) {
    const label = t('killfeed.faction.unknownLabel');
    return (
      <span className="faction-badge" data-faction="unknown" title={label}>
        <span aria-hidden="true">{t('killfeed.faction.unknown')}</span>
        <span className="visually-hidden">{label}</span>
      </span>
    );
  }
  const idx = factionIndex(factions, faction);
  const slot = idx === null || idx > 2 ? 'other' : String(idx + 1);
  return (
    <span className="faction-badge" data-faction={slot} title={faction}>
      <span aria-hidden="true">{factionInitials(faction)}</span>
      <span className="visually-hidden">{faction}</span>
    </span>
  );
}
