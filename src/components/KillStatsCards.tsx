// 統計カード 5 枚(docs/ARCHITECTURE.md 17.10.6・17.10.7): キル(デス・自殺)、ヘッドショット率、最長キル、関わったプレイヤー、チームキル。
// 値は絞り込み前の全件の集計(summarizeKills)。幅 768px 以上は 5 列、未満は 2 列(5 枚目は全幅。ops.css の .kill-stats)。
import type { KillfeedSummary } from '../types/api';
import type { I18n } from './lib/hooks';
import { meters, pct } from './lib/killfmt';

interface Props {
  i18n: I18n;
  summary: KillfeedSummary;
}

export default function KillStatsCards({ i18n, summary }: Props) {
  const { t, num } = i18n;
  const { totals } = summary;
  const longest = summary.longest?.distanceM ?? null;
  const cards: { key: string; label: string; value: string; sub: string }[] = [
    {
      key: 'kills',
      label: t('killfeed.stats.kills'),
      value: num(totals.kills),
      sub: t('killfeed.stats.killsSub', { deaths: num(totals.deaths), suicides: num(totals.suicides) }),
    },
    {
      key: 'hs',
      label: t('killfeed.stats.headshotRate'),
      value: pct(i18n, summary.headshotRate),
      sub: t('killfeed.stats.headshotSub', { count: num(totals.headshots) }),
    },
    {
      key: 'longest',
      label: t('killfeed.stats.longest'),
      value: longest === null ? t('common.none') : t('killfeed.stats.longestValue', { distance: meters(i18n, longest) }),
      sub: t('killfeed.stats.longestSub', { count: num(totals.withDistance) }),
    },
    {
      key: 'players',
      label: t('killfeed.stats.players'),
      value: num(totals.playersInvolved),
      sub: t('killfeed.stats.playersSub'),
    },
    {
      key: 'teamkills',
      label: t('killfeed.stats.teamkills'),
      value: num(totals.teamkills),
      sub: t('killfeed.stats.teamkillsSub', { unknown: num(totals.teamkillUnknown) }),
    },
  ];
  return (
    <ul className="kill-stats" aria-label={t('killfeed.stats.label')}>
      {cards.map((c) => (
        <li key={c.key} className="kill-stat">
          <span className="kill-stat-label">{c.label}</span>
          <span className="kill-stat-value">{c.value}</span>
          <span className="kill-stat-sub">{c.sub}</span>
        </li>
      ))}
    </ul>
  );
}
