// スコア / cash の推移のグラフ(外部ライブラリ無しの SVG。docs/ARCHITECTURE.md 17.9)。
// - 表示の切り替え: スコア(陣営ごとの折れ線 + 上限の横線)/ cash(全員の合計 + 陣営ごとの合計)。ボタン 2 つ(aria-pressed)
// - 横軸は開始からの経過分、縦軸は 0〜最大値(スコアは上限と最大値の大きい方)。目盛りは 4〜5 本
// - 色は ops.css のトークン(--chart-*)に線の種類(実線・破線・点線・一点鎖線)を組み合わせ、凡例に名前を書く(色だけで区別させない)
// - SVG は描画領域の幅に合わせて viewBox を作り直す(幅 100%。375px でも横スクロールを出さず、文字が縮まない)
// - role="img" と aria-label(各系列の最後の値)。グラフの下に最後の記録の表と、全記録の表(折りたたみ)を置く
// 陣営名は RCON の生データ(翻訳しない)。「cash」はゲームの生データの名前なのでそのまま表示する。
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { MatchSample, MatchSummary } from '../types/api';
import type { I18n } from './lib/hooks';
import { factionLabel } from './lib/matches';

type View = 'score' | 'cash';
const VIEWS: readonly View[] = ['score', 'cash'];

interface Series {
  key: string;
  label: string;
  values: (number | null)[];
  color: string;
  dash: string;
  width: number;
}

const FACTION_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'] as const;
const OTHER_COLOR = 'var(--chart-other)';
const TOTAL_COLOR = 'var(--chart-total)';
/** 実線・破線・点線・一点鎖線 */
const DASHES = ['', '8 4', '2 4', '10 4 2 4'] as const;

const HEIGHT = 240;
const DEFAULT_WIDTH = 640;
const MARGIN = { top: 16, right: 16, bottom: 28 } as const;
const FONT_SIZE = 12;

function factionStyle(index: number, dashOffset = 0): Pick<Series, 'color' | 'dash' | 'width'> {
  return {
    color: FACTION_COLORS[index] ?? OTHER_COLOR,
    dash: DASHES[(index + dashOffset) % DASHES.length] ?? '',
    width: 2,
  };
}

/** 1・2・2.5・5 × 10^k のうち、raw 以上で最小の値 */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= raw) return m * base;
  }
  return 10 * base;
}

/** 0 から max を含む目盛り(4〜5 本程度) */
function ticksFor(max: number, integer: boolean): { ticks: number[]; top: number } {
  const safeMax = max > 0 ? max : 1;
  let step = niceStep(safeMax / 4);
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(safeMax / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { ticks, top };
}

/** 系列の値を null で区切った折れ線のパスと、前後が null の孤立点 */
function toPaths(values: (number | null)[], xs: number[], sx: (v: number) => number, sy: (v: number) => number) {
  const paths: string[] = [];
  const dots: { x: number; y: number }[] = [];
  let current: { x: number; y: number }[] = [];
  const flush = () => {
    if (current.length === 1 && current[0]) dots.push(current[0]);
    else if (current.length > 1) paths.push(current.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '));
    current = [];
  };
  values.forEach((v, i) => {
    const x = xs[i];
    if (v === null || x === undefined) {
      flush();
      return;
    }
    current.push({ x: sx(x), y: sy(v) });
  });
  flush();
  return { paths, dots };
}

function lastValue(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** 陣営ごとの値を、陣営(名前、無ければ位置)を鍵にして系列にまとめる */
function collect(
  samples: readonly MatchSample[],
  pick: (s: MatchSample) => { faction: string | null; value: number | null }[],
  i18n: I18n,
  dashOffset: number,
): Series[] {
  const order: string[] = [];
  const labels = new Map<string, string>();
  const rows = samples.map((s) => {
    const row = new Map<string, number | null>();
    pick(s).forEach((f, i) => {
      const key = f.faction ?? `#${i}`;
      if (!labels.has(key)) {
        labels.set(key, factionLabel(f.faction, i, i18n));
        order.push(key);
      }
      row.set(key, typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : null);
    });
    return row;
  });
  return order.map((key, index) => ({
    key,
    label: labels.get(key) ?? key,
    values: rows.map((r) => r.get(key) ?? null),
    ...factionStyle(index, dashOffset),
  }));
}

interface Props {
  i18n: I18n;
  match: MatchSummary;
  /** 古い順 */
  samples: readonly MatchSample[];
}

export default function ScoreChart({ i18n, match, samples }: Props) {
  const { t, num, time } = i18n;
  const [view, setView] = useState<View>('score');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const titleId = useId();
  // 描画領域の幅を測って viewBox の幅にする(グラフが表示されたとき・切り替えで作り直されたときに測り直す)
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

  const xs = useMemo(() => samples.map((s) => Math.max(0, (s.at - match.startedAt) / 60_000)), [samples, match.startedAt]);

  const series = useMemo<Series[]>(() => {
    if (view === 'score') {
      return collect(samples, (s) => s.factionScores.map((f) => ({ faction: f.faction, value: f.score })), i18n, 0);
    }
    const total: Series = {
      key: '__total',
      label: t('chart.cashTotal'),
      values: samples.map((s) => (typeof s.cashTotal === 'number' && Number.isFinite(s.cashTotal) ? s.cashTotal : null)),
      color: TOTAL_COLOR,
      dash: '',
      width: 3,
    };
    // 陣営の線は合計(実線)と区別できるよう、破線から割り当てる
    const factions = collect(samples, (s) => s.factions.map((f) => ({ faction: f.faction, value: f.cash })), i18n, 1);
    return [total, ...factions];
  }, [view, samples, i18n, t]);

  const visible = series.filter((s) => s.values.some((v) => v !== null));
  const cap = view === 'score' ? match.scoreCap : null;
  const maxValue = Math.max(0, cap ?? 0, ...visible.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const y = ticksFor(maxValue, view === 'score');
  const x = ticksFor(Math.max(1, xs[xs.length - 1] ?? 0), true);

  const yLabels = y.ticks.map((v) => num(v));
  const left = 10 + Math.max(...yLabels.map((s) => s.length), 1) * 7.5;
  const plotW = Math.max(40, width - left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const sx = (v: number) => left + (v / x.top) * plotW;
  const sy = (v: number) => MARGIN.top + plotH - (v / y.top) * plotH;

  const chartTitle = view === 'score' ? t('chart.titleScore') : t('chart.titleCash');
  const lastValues = visible.map((s) => ({ s, v: lastValue(s.values) }));
  const ariaValues = lastValues.length
    ? lastValues.map(({ s, v }) => t('chart.ariaValue', { name: s.label, value: num(v) })).join(t('chart.ariaSeparator'))
    : t('chart.ariaNoValues');
  const ariaParts = cap !== null ? `${ariaValues}${t('chart.ariaSeparator')}${t('chart.cap', { cap: num(cap) })}` : ariaValues;
  const ariaLabel = t('chart.ariaLabel', { title: chartTitle, values: ariaParts });
  const lastSample = samples[samples.length - 1] ?? null;

  if (samples.length === 0) return <p className="muted">{t('chart.empty')}</p>;

  return (
    <div className="score-chart">
      <div className="segmented" role="group" aria-label={t('chart.view.label')}>
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            className={v === view ? 'button-small is-active' : 'button-small'}
            aria-pressed={v === view}
            onClick={() => setView(v)}
          >
            {t(`chart.view.${v}`)}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="muted">{view === 'score' ? t('chart.noScores') : t('chart.noCash')}</p>
      ) : (
        <>
          <p className="chart-axis-title muted">{view === 'score' ? t('chart.axis.yScore') : t('chart.axis.yCash')}</p>
          <div ref={boxRef} className="chart-box">
            <svg
              className="chart-svg"
              role="img"
              aria-label={ariaLabel}
              viewBox={`0 0 ${width} ${HEIGHT}`}
              width="100%"
              height={HEIGHT}
              focusable="false"
            >
              <title id={titleId}>{chartTitle}</title>
              {y.ticks.map((v, i) => (
                <g key={`y${v}`}>
                  <line className="chart-grid" x1={left} x2={left + plotW} y1={sy(v)} y2={sy(v)} />
                  <text className="chart-tick" x={left - 6} y={sy(v)} dy="0.35em" textAnchor="end" fontSize={FONT_SIZE}>
                    {yLabels[i]}
                  </text>
                </g>
              ))}
              {x.ticks.map((v) => (
                <text
                  key={`x${v}`}
                  className="chart-tick"
                  x={sx(v)}
                  y={MARGIN.top + plotH + 18}
                  textAnchor="middle"
                  fontSize={FONT_SIZE}
                >
                  {num(v)}
                </text>
              ))}
              <line className="chart-axis" x1={left} x2={left + plotW} y1={sy(0)} y2={sy(0)} />
              {cap !== null && (
                <g>
                  <line className="chart-cap" x1={left} x2={left + plotW} y1={sy(cap)} y2={sy(cap)} />
                  <text className="chart-cap-label" x={left + plotW} y={sy(cap) - 4} textAnchor="end" fontSize={FONT_SIZE}>
                    {t('chart.cap', { cap: num(cap) })}
                  </text>
                </g>
              )}
              {visible.map((s) => {
                const { paths, dots } = toPaths(s.values, xs, sx, sy);
                return (
                  <g key={s.key} stroke={s.color} fill={s.color}>
                    {paths.map((d, i) => (
                      <path
                        key={i}
                        d={d}
                        fill="none"
                        strokeWidth={s.width}
                        strokeDasharray={s.dash || undefined}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ))}
                    {dots.map((p, i) => (
                      <circle key={i} cx={p.x} cy={p.y} r={3} stroke="none" />
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="chart-axis-title chart-axis-x muted">{t('chart.axis.x')}</p>

          <ul className="chart-legend" aria-label={t('chart.legend')}>
            {lastValues.map(({ s, v }) => (
              <li key={s.key}>
                <svg className="chart-legend-swatch" viewBox="0 0 32 12" width="32" height="12" aria-hidden="true" focusable="false">
                  <line x1="2" x2="30" y1="6" y2="6" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash || undefined} />
                </svg>
                <span>{s.label}</span>
                <span className="chart-legend-value">{num(v)}</span>
              </li>
            ))}
            {cap !== null && (
              <li>
                <svg className="chart-legend-swatch" viewBox="0 0 32 12" width="32" height="12" aria-hidden="true" focusable="false">
                  <line className="chart-cap" x1="2" x2="30" y1="6" y2="6" />
                </svg>
                <span>{t('chart.cap', { cap: num(cap) })}</span>
              </li>
            )}
          </ul>
          {view === 'cash' && <p className="muted">{t('chart.cashNote')}</p>}
        </>
      )}

      {lastSample && (
        <>
          <h3>{t('chart.latest.title', { time: time(lastSample.at) })}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('chart.col.series')}</th>
                  <th scope="col">{t('chart.col.value')}</th>
                </tr>
              </thead>
              <tbody>
                {lastValues.map(({ s }) => (
                  <tr key={s.key}>
                    <th scope="row">{s.label}</th>
                    <td className="num">{num(s.values[s.values.length - 1] ?? null)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">{t('chart.col.players')}</th>
                  <td className="num">
                    {t('status.playersValue', { current: num(lastSample.players.current), max: num(lastSample.players.max) })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <details className="chart-details">
            <summary>{t('chart.table.toggle', { count: num(samples.length) })}</summary>
            <div className="table-wrap">
              <table className="chart-table">
                <thead>
                  <tr>
                    <th scope="col">{t('chart.col.elapsed')}</th>
                    <th scope="col">{t('chart.col.time')}</th>
                    <th scope="col">{t('chart.col.players')}</th>
                    {visible.map((s) => (
                      <th key={s.key} scope="col">
                        {s.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {samples.map((sample, i) => (
                    <tr key={sample.at}>
                      <td className="num">{num(Math.floor(xs[i] ?? 0))}</td>
                      <td className="num">{time(sample.at)}</td>
                      <td className="num">
                        {t('status.playersValue', { current: num(sample.players.current), max: num(sample.players.max) })}
                      </td>
                      {visible.map((s) => (
                        <td key={s.key} className="num">
                          {num(s.values[i] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
