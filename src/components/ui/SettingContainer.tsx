import React, { useContext, useId } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@/bindings";
import { useSettingChange } from "@/hooks/useSettingChange";
import { InFoldContext } from "./Fold";
import { ResetButton } from "./ResetButton";

/**
 * Setting row (VISUAL_DESIGN_SYSTEM §12.14): label and description on the
 * left, the control on the right; a wide control goes under the label
 * (`layout="stacked"`).
 *
 * The description is always visible text (§2, principle 4; debt A10): the old
 * ⓘ tooltip mode is ignored, `descriptionMode` stays only so callers compile.
 *
 * Inside a fold a row whose value differs from the default shows the tag
 * «изменено» after its label and a reset before its control
 * (UX_INTERACTION_ARCHITECTURE, Progressive Disclosure, rule 3).
 */
interface SettingContainerProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  descriptionMode?: "inline" | "tooltip";
  /** Kept for callers; a row is always drawn inside a group. */
  grouped?: boolean;
  layout?: "horizontal" | "stacked";
  disabled?: boolean;
  tooltipPosition?: "top" | "bottom";
  /** Service lines under the description: consequence, readiness, echo. */
  extra?: React.ReactNode;
  /** A setting that depends on the row above: indented, no separator. */
  dependent?: boolean;
  /** Deep-link target id (navigation store). */
  anchor?: string;
  /** id of the control, so the label can point at it. */
  controlId?: string;
  className?: string;
  /** App setting behind the row: «изменено» and reset inside a fold. */
  settingKey?: keyof AppSettings;
  /** Explicit «changed» for values that are not app settings. */
  changed?: boolean;
  /** Explicit reset for values that are not app settings. */
  onReset?: () => void;
  /** The control has its own reset (number fields): only the tag. */
  ownReset?: boolean;
}

export const SettingContainer: React.FC<SettingContainerProps> = ({
  title,
  description,
  children,
  grouped = true,
  layout = "horizontal",
  disabled = false,
  extra,
  dependent = false,
  anchor,
  controlId,
  className = "",
  settingKey,
  changed: changedProp,
  onReset,
  ownReset = false,
}) => {
  const { t } = useTranslation();
  const labelId = useId();
  const inFold = useContext(InFoldContext);
  const setting = useSettingChange(inFold ? settingKey : undefined);
  const changed = inFold && (changedProp ?? setting.changed);
  const reset = ownReset ? undefined : (onReset ?? setting.reset);
  const tag = changed ? (
    <span className="t-tag t-row-changed">{t("ui.changed")}</span>
  ) : null;
  const resetButton =
    changed && reset ? (
      <ResetButton onClick={reset} disabled={disabled} />
    ) : null;
  const classes = [
    layout === "stacked" ? "t-row-stacked" : "t-row",
    dependent ? "t-row-dependent" : "",
    disabled ? "t-row-disabled" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const label = controlId ? (
    <label className="t-row-label" id={labelId} htmlFor={controlId}>
      {title}
    </label>
  ) : (
    <span className="t-row-label" id={labelId}>
      {title}
    </span>
  );

  const text = (
    <div className="t-row-text">
      {tag ? (
        <div className="t-row-title">
          {label}
          {tag}
        </div>
      ) : (
        label
      )}
      {description ? <div className="t-row-desc">{description}</div> : null}
      {extra}
    </div>
  );

  const row =
    layout === "stacked" ? (
      <div
        className={classes}
        data-anchor={anchor}
        role="group"
        aria-labelledby={labelId}
      >
        {text}
        {children || resetButton ? (
          <div className="t-row-body">
            {resetButton}
            {children}
          </div>
        ) : null}
      </div>
    ) : (
      <div
        className={classes}
        data-anchor={anchor}
        role="group"
        aria-labelledby={labelId}
      >
        {text}
        {children || resetButton ? (
          <div className="t-row-control">
            {resetButton}
            {children}
          </div>
        ) : null}
      </div>
    );

  // A row used on its own (outside SettingsGroup) gets its own container.
  return grouped ? row : <div className="t-group">{row}</div>;
};
