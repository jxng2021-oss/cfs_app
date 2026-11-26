import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { StatusCount } from './api.js';
import { percent, statusText, tone } from './ui.js';

/** Flips to true on the frame after mount so CSS transitions animate marks growing from zero. */
function useGrow() {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return grown;
}

export function ChartEmpty({ children = 'No data for this selection.' }: { children?: ReactNode }) {
  return <p className="chart-empty">{children}</p>;
}

/**
 * One series over time as columns (submissions per week or month). Single hue, no legend; the title names the series.
 * Only every few period labels are printed so they never collide; every column has a hover/focus tooltip.
 */
export function ColumnSeries({ points, period, label }: { points: { period: string; count: number }[]; period: 'week' | 'month'; label: string }) {
  const grown = useGrow();
  if (!points.some(point => point.count)) return <ChartEmpty>No submissions in this period.</ChartEmpty>;
  const max = Math.max(1, ...points.map(point => point.count));
  const every = Math.ceil(points.length / 8);
  const name = (value: string) => new Intl.DateTimeFormat('en-SG', { timeZone: 'UTC', ...(period === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' }) })
    .format(new Date(value + 'T00:00:00Z'));
  return <figure className="chart">
    <div className="series-chart" role="img" aria-label={label + ': ' + points.map(point => name(point.period) + ' ' + point.count).join(', ')}
      style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
      {points.map((point, index) => <div className="series-column" key={point.period}>
        <span className="series-bar" tabIndex={0} style={{ height: grown ? Math.max(point.count ? 3 : 0, (point.count / max) * 100) + '%' : 0, transitionDelay: index * 25 + 'ms' }}>
          <span className="chart-tip" role="tooltip">{(period === 'week' ? 'Week of ' : '') + name(point.period)}: {point.count}</span>
        </span>
        <span className="series-label" aria-hidden="true">{index % every === 0 ? name(point.period) : ''}</span>
      </div>)}
    </div>
    <figcaption>Peak {max} per {period}</figcaption>
  </figure>;
}

/** Ranked categories as horizontal bars with direct value labels. Bars link to a filtered view when `href` is given. */
export function BarList({ items, total, href, emptyText }: { items: { key: string; label: string; count: number }[]; total?: number; href?: (key: string) => string; emptyText?: string }) {
  const grown = useGrow();
  if (!items.length) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const max = Math.max(1, ...items.map(item => item.count));
  return <ol className="bar-list">
    {items.map((item, index) => {
      const content = <>
        <span className="bar-label">{item.label}</span>
        <span className="bar-track"><span className="bar-fill" style={{ width: grown ? (item.count / max) * 100 + '%' : 0, transitionDelay: index * 40 + 'ms' }} /></span>
        <span className="bar-value">{item.count}{total ? <small> · {Math.round((item.count / total) * 100)}%</small> : null}</span>
      </>;
      return <li key={item.key}>{href ? <Link to={href(item.key)} className="bar-row">{content}</Link> : <div className="bar-row">{content}</div>}</li>;
    })}
  </ol>;
}

/** Application status distribution: one stacked bar coloured by status meaning, plus a labelled legend (identity is never colour alone). */
export function StatusStack({ statuses, href }: { statuses: StatusCount[]; href?: (status: string) => string }) {
  const grown = useGrow();
  const shown = statuses.filter(item => item.count);
  const total = shown.reduce((sum, item) => sum + item.count, 0);
  if (!total) return <ChartEmpty>No applications yet.</ChartEmpty>;
  return <figure className="chart">
    <div className="stack-bar" role="img" aria-label={shown.map(item => statusText(item.status) + ' ' + item.count).join(', ')}>
      {shown.map(item => <span key={item.status} tabIndex={0} className="stack-segment" data-tone={tone(item.status)} data-status={item.status}
        style={{ flexGrow: grown ? item.count : 0 }}>
        <span className="chart-tip" role="tooltip">{statusText(item.status)}: {item.count} ({Math.round((item.count / total) * 100)}%)</span>
      </span>)}
    </div>
    <ul className="status-legend">
      {shown.map(item => {
        const body = <><span className="legend-swatch" data-tone={tone(item.status)} data-status={item.status} aria-hidden="true" /><span>{statusText(item.status)}</span><strong>{item.count}</strong></>;
        return <li key={item.status}>{href ? <Link to={href(item.status)}>{body}</Link> : body}</li>;
      })}
    </ul>
  </figure>;
}

/** A rate with its definition; null renders as "—" with an explanation instead of a misleading 0%. */
export function RateMeter({ label, value, numerator, denominator, definition }: { label: string; value: number | null; numerator: number; denominator: number; definition: string }) {
  const grown = useGrow();
  return <div className="rate">
    <div className="rate-head"><span>{label}</span><strong>{percent(value)}</strong></div>
    <span className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
      <span style={{ width: grown && value !== null ? Math.min(100, value) + '%' : 0 }} />
    </span>
    <small>{denominator ? `${numerator} of ${denominator} · ${definition}` : `No data yet · ${definition}`}</small>
  </div>;
}

/** Enrolled seats against capacity, with accepted offers shown as a lighter pending segment. */
export function CapacityBar({ capacity, enrolled, accepted = 0, compact = false }: { capacity: number; enrolled: number; accepted?: number; compact?: boolean }) {
  const grown = useGrow();
  const filled = Math.min(100, (enrolled / capacity) * 100);
  const pending = Math.min(100 - filled, (accepted / capacity) * 100);
  const full = enrolled >= capacity;
  return <span className={'capacity' + (compact ? ' compact' : '')} data-full={full || undefined}>
    <span className="capacity-track" role="meter" aria-label="Enrolment capacity used" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={enrolled}>
      <span className="capacity-enrolled" style={{ width: grown ? filled + '%' : 0 }} />
      {accepted > 0 && <span className="capacity-accepted" style={{ width: grown ? pending + '%' : 0 }} />}
    </span>
    <small>{enrolled}/{capacity} enrolled{accepted ? ` · ${accepted} accepted` : ''}</small>
  </span>;
}
