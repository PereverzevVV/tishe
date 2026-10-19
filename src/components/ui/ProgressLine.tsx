import React from "react";

/**
 * Progress (§12.24): 4 px track, solid accent fill. The percentage is always
 * written as text next to it by the caller.
 */
export const ProgressLine: React.FC<{
  /** 0–100; null draws the indeterminate bar. */
  value: number | null;
  label?: string;
  className?: string;
}> = ({ value, label, className = "" }) =>
  value === null ? (
    <div
      className={`t-progress t-progress-indeterminate ${className}`}
      role="progressbar"
      aria-label={label}
    >
      <i />
    </div>
  ) : (
    <div
      className={`t-progress ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
