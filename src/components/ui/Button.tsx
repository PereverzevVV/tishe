import React from "react";
import { Spinner } from "./Spinner";

/**
 * Button (VISUAL_DESIGN_SYSTEM §12.1).
 *
 * primary   — the one main action of the screen (graphite fill);
 * secondary — a secondary action with a consequence (grey fill);
 * quiet     — an action in place: rows, "Показать все", "Убрать";
 * danger    — only the last confirm button of an irreversible-action dialog.
 *
 * The old Handy variants are kept as aliases so existing callers keep working:
 * ghost and danger-ghost are quiet, primary-soft and warning are secondary.
 */
export type ButtonVariant =
  | "primary"
  | "secondary"
  | "quiet"
  | "danger"
  | "ghost"
  | "primary-soft"
  | "warning"
  | "danger-ghost";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  /** Square icon-only button; needs an aria-label. */
  icon?: boolean;
  /** Shows a spinner on the left and blocks repeated presses. */
  loading?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "t-btn-primary",
  secondary: "t-btn-secondary",
  quiet: "t-btn-quiet",
  danger: "t-btn-danger",
  ghost: "t-btn-quiet",
  "primary-soft": "t-btn-secondary",
  warning: "t-btn-secondary",
  "danger-ghost": "t-btn-quiet",
};

const SIZE_CLASS = { sm: "t-btn-sm", md: "", lg: "t-btn-lg" } as const;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className = "",
      variant = "primary",
      size = "md",
      icon = false,
      loading = false,
      disabled,
      type = "button",
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={[
        "t-btn",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        icon ? "t-btn-icon" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
