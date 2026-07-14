import type { ReactElement, ReactNode } from "react";

interface BarProps {
  label: string;
  value: number;
  max: number;
  fillClass: string;
  /** 14px stroked glyph in the row's leading column. */
  icon?: ReactNode;
  /** Cosmetic segment ticks over the fill. */
  ticks?: boolean;
  /** Trailing readout. `null` drops the cell — the cast bar puts its numbers
   * under the track instead. */
  valueText?: string | null;
}

/** The shared bar primitive: [icon] [label] [track] [value]. Vitals, the cast
 * bar and the vehicle meters all compose it. */
export function Bar({
  label,
  value,
  max,
  fillClass,
  icon,
  ticks = false,
  valueText,
}: BarProps): ReactElement {
  // Guard the denominator: vitals pass positive constant caps, but the cast bar
  // feeds wire-derived totalS — a zero/negative max would make value/max
  // NaN/Infinity and break the fill width. Empty bar is the safe fallback.
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar">
      {icon}
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className={`bar-fill ${fillClass}`} style={{ width: `${pct}%` }} />
        {ticks && <span className="bar-ticks" />}
      </span>
      {valueText !== null && (
        <span className="bar-value">{valueText ?? Math.round(value)}</span>
      )}
    </div>
  );
}
