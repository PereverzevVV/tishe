import React from "react";

/**
 * Segments (VISUAL_DESIGN_SYSTEM §12.7): 2–3 short equal values of one
 * property. Width is reserved for the 600 weight so selection does not shift.
 * A setting is a radiogroup; a view switch is a group of pressed buttons.
 */
export interface SegmentOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SegmentsProps {
  options: SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  size?: "sm" | "md";
  mode?: "radio" | "pressed";
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Stretch to the row width (when it goes under the label). */
  wide?: boolean;
  id?: string;
}

export const Segments: React.FC<SegmentsProps> = ({
  options,
  value,
  onChange,
  size = "md",
  mode = "radio",
  disabled = false,
  ariaLabel,
  ariaLabelledBy,
  wide = false,
  id,
}) => {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (mode !== "radio") return;
    const enabled = options.filter((o) => !o.disabled && !disabled);
    const index = enabled.findIndex((o) => o.value === value);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(enabled[(index + 1) % enabled.length].value);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(enabled[(index - 1 + enabled.length) % enabled.length].value);
    }
  };
  return (
    <div
      id={id}
      className={`t-seg ${size === "sm" ? "t-seg-sm" : ""} ${wide ? "t-seg-wide" : ""}`}
      role={mode === "radio" ? "radiogroup" : "group"}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-l={o.label}
            disabled={disabled || o.disabled}
            role={mode === "radio" ? "radio" : undefined}
            aria-checked={mode === "radio" ? on : undefined}
            aria-pressed={mode === "pressed" ? on : undefined}
            tabIndex={mode === "radio" ? (on ? 0 : -1) : undefined}
            onClick={() => !on && onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
};
