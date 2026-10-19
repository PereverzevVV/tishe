import React from "react";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  CloudUpload,
  Download,
} from "lucide-react";
import { Spinner } from "./Spinner";

/**
 * Service line under a setting (VISUAL_DESIGN_SYSTEM §12.14): consequence,
 * readiness or echo. One caption line, an optional 14 px icon and an action.
 *
 * cloud    — data leaves the computer: amber cloud, primary text;
 * missing  — something must be downloaded first: ↓ secondary, primary text;
 * busy     — downloading or preparing: spinner, secondary text;
 * ready    — was in question and is ready now: grey check, secondary text;
 * caveat   — works with a caveat: amber ⚠, primary text;
 * error    — does not work: red «!», primary text;
 * neutral  — neutral consequence or echo: no icon, secondary text.
 */
export type ServiceKind =
  | "cloud"
  | "missing"
  | "busy"
  | "ready"
  | "caveat"
  | "error"
  | "neutral";

const STRONG: Record<ServiceKind, boolean> = {
  cloud: true,
  missing: true,
  busy: false,
  ready: false,
  caveat: true,
  error: true,
  neutral: false,
};

export const ServiceLine: React.FC<{
  kind?: ServiceKind;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}> = ({ kind = "neutral", children, action, className = "" }) => {
  const icon = {
    cloud: <CloudUpload className="t-icon-warning" aria-hidden="true" />,
    missing: <Download className="t-icon-secondary" aria-hidden="true" />,
    busy: <Spinner size={14} />,
    ready: <Check className="t-icon-secondary" aria-hidden="true" />,
    caveat: <AlertTriangle className="t-icon-warning" aria-hidden="true" />,
    error: <CircleAlert className="t-icon-danger" aria-hidden="true" />,
    neutral: null,
  }[kind];
  return (
    <div className={`t-svc ${className}`}>
      {icon}
      <span className="t-svc-body">
        <span className={STRONG[kind] ? "t-svc-strong" : ""}>{children}</span>
        {action}
      </span>
    </div>
  );
};
