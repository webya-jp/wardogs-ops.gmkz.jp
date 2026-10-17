// 距離の分布(docs/ARCHITECTURE.md 17.10.7 の 8)。6 階級の横棒 + 数値のラベルと平均。距離が分からないキルは含めない。
// 各行は「階級の名前 | 棒(SVG。viewBox で幅 100%、文字は SVG の外に置くので縮まない)| 件数」の grid(ops.css の .kill-distance)。
import type { KillfeedSummary } from '../types/api';
import type { I18n } from './lib/hooks';
import { meters } from './lib/killfmt';

interface Props {
  i18n: I18n;
  summary: KillfeedSummary;
}

export default function KillDistanceChart({ i18n, summary }: Props) {
  const { t, num } = i18n;
  const bins = summary.distance;
  const max = Math.max(0, ...bins.map((b) => b.kills));
  const label = (minM: number, maxM: number | null, first: boolean) => {
    if (maxM === null) return t('killfeed.distance.binLast', { min: num(minM) });
    if (first) return t('killfeed.distance.binFirst', { max: num(maxM) });
    return t('killfeed.distance.bin', { min: num(minM), max: num(maxM) });
  };

  if (summary.totals.withDistance === 0) return <p className="muted">{t('killfeed.distance.none')}</p>;

  return (
    <div className="kill-distance-wrap">
      <ul className="kill-distance">
        {bins.map((b, i) => {
          const pctWidth = max === 0 ? 0 : (b.kills / max) * 100;
          return (
            <li key={b.minM}>
              <span className="kd-label">{label(b.minM, b.maxM, i === 0)}</span>
              <svg className="kd-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                <rect className="kd-track" x="0" y="0" width="100" height="10" />
                {b.kills > 0 && <rect className="kd-fill" x="0" y="0" width={Math.max(1, pctWidth)} height="10" />}
              </svg>
              <span className="kd-value">{num(b.kills)}</span>
            </li>
          );
        })}
      </ul>
      {summary.averageDistanceM !== null && (
        <p>
          {t('killfeed.distance.average', {
            distance: meters(i18n, summary.averageDistanceM),
            count: num(summary.totals.withDistance),
          })}
        </p>
      )}
      <p className="muted">{t('killfeed.distance.excluded')}</p>
    </div>
  );
}
