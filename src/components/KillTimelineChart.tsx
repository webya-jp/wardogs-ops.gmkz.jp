// 時間帯別のキル(外部ライブラリ無しの SVG。docs/ARCHITECTURE.md 17.10.7 の 5)。
// - キルの棒にヘッドショットを重ねた積み上げ。ヘッドショットは塗り + 斜線の模様(色だけで区別させない)。凡例に名前を書く
// - 棒は <g role="button" tabindex="0" aria-pressed>。クリック・Enter・Space で選択 / 解除し、キルログを絞り込む
// - 横軸は時刻(locale・タイムゾーン指定の時:分)、目盛り 4〜6 本。SVG は描画領域の幅に合わせて viewBox を作り直す(幅 100%)
// - 下に表(折りたたみ)
import { useCallback, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { KillfeedSummary } from '../types/api';
import type { I18n } from './lib/hooks';
import { hm } from './lib/killfmt';
import { bucketRange } from './lib/killstats';
import type { TimeRange } from './lib/killstats';

interface Props {
  i18n: I18n;
  timeline: KillfeedSummary['timeline'];
  selected: TimeRange | null;
  onSelect: (range: TimeRange | null) => void;
}

const HEIGHT = 180;
const DEFAULT_WIDTH = 640;
const MARGIN = { top: 12, right: 8, bottom: 26 } as const;
const FONT_SIZE = 12;
/** 横軸の目盛りの最大数 */
const X_TICKS_MAX = 6;

/** 0 から max を含む整数の目盛り(4〜5 本程度) */
function yTicks(max: number): { ticks: number[]; top: number } {
  const safe = Math.max(1, max);
  const raw = safe / 4;
  const base = 10 ** Math.floor(Math.log10(raw));
  let step = 10 * base;
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= raw) {
      step = m * base;
      break;
    }
  }
  step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(safe / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { ticks, top };
}

export default function KillTimelineChart({ i18n, timeline, selected, onSelect }: Props) {
  const { t, num } = i18n;
  const { buckets, bucketMinutes } = timeline;
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const patternId = `kt-hs-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const observer = useRef<ResizeObserver | null>(null);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth(w);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    observer.current = ro;
  }, []);

  if (buckets.length === 0) return <p className="muted">{t('killfeed.log.noKills')}</p>;

  const maxKills = Math.max(0, ...buckets.map((b) => b.kills));
  const y = yTicks(maxKills);
  const yLabels = y.ticks.map((v) => num(v));
  const left = 8 + Math.max(...yLabels.map((s) => s.length), 1) * 7.5;
  const plotW = Math.max(40, width - left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotW / buckets.length;
  const barW = Math.max(1, band * 0.8);
  const sy = (v: number) => MARGIN.top + plotH - (v / y.top) * plotH;
  // 目盛りのラベルは 1 本あたり約 48px。幅と本数の両方で間引く
  const maxTicks = Math.max(2, Math.min(X_TICKS_MAX, Math.floor(plotW / 48)));
  const tickStep = Math.max(1, Math.ceil(buckets.length / maxTicks));

  const peak = buckets.reduce((best, b) => (b.kills > best.kills ? b : best), buckets[0]!);
  const ariaLabel = t('killfeed.timeline.ariaLabel', { start: hm(i18n, peak.start), kills: num(peak.kills) });

  const isSelected = (start: number) => selected !== null && selected.start === start;
  const toggle = (start: number) => onSelect(isSelected(start) ? null : bucketRange({ start }, bucketMinutes));
  const onKey = (e: KeyboardEvent<SVGGElement>, start: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(start);
    }
  };

  return (
    <div className="kill-timeline">
      <div ref={boxRef} className="chart-box">
        <svg className="chart-svg" role="group" aria-label={ariaLabel} viewBox={`0 0 ${width} ${HEIGHT}`} width="100%" height={HEIGHT}>
          <defs>
            <pattern id={patternId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect className="kt-hs-bg" width="6" height="6" />
              <line className="kt-hs-line" x1="0" y1="0" x2="0" y2="6" />
            </pattern>
          </defs>
          {y.ticks.map((v, i) => (
            <g key={`y${v}`} aria-hidden="true">
              <line className="chart-grid" x1={left} x2={left + plotW} y1={sy(v)} y2={sy(v)} />
              <text className="chart-tick" x={left - 6} y={sy(v)} dy="0.35em" textAnchor="end" fontSize={FONT_SIZE}>
                {yLabels[i]}
              </text>
            </g>
          ))}
          {buckets.map((b, i) =>
            i % tickStep === 0 ? (
              <text
                key={`x${b.start}`}
                aria-hidden="true"
                className="chart-tick"
                x={i === 0 ? left : left + i * band + band / 2}
                y={MARGIN.top + plotH + 18}
                textAnchor={i === 0 ? 'start' : 'middle'}
                fontSize={FONT_SIZE}
              >
                {hm(i18n, b.start)}
              </text>
            ) : null,
          )}
          <line className="chart-axis" x1={left} x2={left + plotW} y1={sy(0)} y2={sy(0)} aria-hidden="true" />
          {buckets.map((b, i) => {
            const x = left + i * band + (band - barW) / 2;
            const sel = isSelected(b.start);
            const dim = selected !== null && !sel;
            const other = b.kills - b.headshots;
            const label = t('killfeed.timeline.bar', { start: hm(i18n, b.start), kills: num(b.kills), headshots: num(b.headshots) });
            return (
              <g
                key={b.start}
                role="button"
                tabIndex={0}
                aria-pressed={sel}
                aria-label={label}
                className={`kt-bar${sel ? ' is-selected' : ''}${dim ? ' is-dim' : ''}`}
                onClick={() => toggle(b.start)}
                onKeyDown={(e) => onKey(e, b.start)}
              >
                <title>{label}</title>
                <rect className="kt-hit" x={left + i * band} y={MARGIN.top} width={band} height={plotH} />
                {b.headshots > 0 && (
                  <rect x={x} y={sy(b.headshots)} width={barW} height={sy(0) - sy(b.headshots)} fill={`url(#${patternId})`} />
                )}
                {other > 0 && <rect className="kt-bar-kill" x={x} y={sy(b.kills)} width={barW} height={sy(b.headshots) - sy(b.kills)} />}
                {sel && (
                  <rect className="kt-bar-outline" x={x - 1} y={sy(b.kills) - 1} width={barW + 2} height={sy(0) - sy(b.kills) + 1} />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <ul className="chart-legend">
        <li>
          <svg className="chart-legend-swatch" viewBox="0 0 16 12" width="16" height="12" aria-hidden="true" focusable="false">
            <rect className="kt-bar-kill" x="0" y="0" width="16" height="12" />
          </svg>
          <span>{t('killfeed.timeline.kills')}</span>
        </li>
        <li>
          <svg className="chart-legend-swatch" viewBox="0 0 16 12" width="16" height="12" aria-hidden="true" focusable="false">
            <rect x="0" y="0" width="16" height="12" fill={`url(#${patternId})`} />
          </svg>
          <span>{t('killfeed.timeline.headshots')}</span>
        </li>
      </ul>

      <div aria-live="polite">
        {selected && (
          <div className="alert kill-timeline-selected">
            <p>{t('killfeed.timeline.selected', { start: hm(i18n, selected.start), end: hm(i18n, selected.end) })}</p>
            <button type="button" className="button-small" onClick={() => onSelect(null)}>
              {t('killfeed.timeline.clear')}
            </button>
          </div>
        )}
      </div>

      <details className="chart-details">
        <summary>{t('killfeed.timeline.table')}</summary>
        <div className="table-wrap">
          <table className="chart-table">
            <thead>
              <tr>
                <th scope="col">{t('killfeed.timeline.colStart')}</th>
                <th scope="col">{t('killfeed.timeline.kills')}</th>
                <th scope="col">{t('killfeed.timeline.headshots')}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.start}>
                  <td className="num">{hm(i18n, b.start)}</td>
                  <td className="num">{num(b.kills)}</td>
                  <td className="num">{num(b.headshots)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
