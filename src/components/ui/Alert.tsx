import React from "react";
import { AlertTriangle, Check, CircleAlert, Info } from "lucide-react";

/**
 * Inline warning (VISUAL_DESIGN_SYSTEM §12.21): neutral group surface, the
 * colour lives only in the 16 px icon — red when work is impossible, amber
 * when it is possible with a caveat. Text is always primary/secondary.
 */
type AlertVariant = "error" | "warning" | "info" | "success";

interface AlertProps {
  variant?: AlertVariant;
  /** Drawn inside another container (a group row, a dialog): no surface. */
  contained?: boolean;
  /** Bold first line; children become the secondary text under it. */
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Buttons or links under the text. */
  actions?: React.ReactNode;
  className?: string;
}

const ICON: Record<AlertVariant, React.ElementType> = {
  error: CircleAlert,
  warning: AlertTriangle,
  info: Info,
  success: Check,
};

const ICON_CLASS: Record<AlertVariant, string> = {
  error: "t-icon-danger",
  warning: "t-icon-warning",
  info: "t-icon-secondary",
  success: "t-icon-secondary",
};

export const Alert: React.FC<AlertProps> = ({
  variant = "error",
  contained = false,
  title,
  children,
  actions,
  className = "",
}) => {
  const Icon = ICON[variant];
  return (
    <div
      className={`t-alert ${contained ? "t-alert-inset" : ""} ${className}`}
      role={variant === "error" ? "alert" : "status"}
    >
      <Icon className={ICON_CLASS[variant]} aria-hidden="true" />
      <div className="t-alert-body">
        {title ? (
          <>
            <div className={children ? "t-alert-title" : ""}>{title}</div>
            {children && <div className="t-alert-text">{children}</div>}
          </>
        ) : (
          <div>{children}</div>
        )}
        {actions && <div className="t-alert-actions">{actions}</div>}
      </div>
    </div>
  );
};
