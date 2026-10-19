import React from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";

/** Reset to the default value: a quiet 24 icon button (§12.1). */
interface ResetButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export const ResetButton: React.FC<ResetButtonProps> = React.memo(
  ({ onClick, disabled = false, className = "", ariaLabel, children }) => {
    const { t } = useTranslation();
    const label = ariaLabel ?? t("common.reset");
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        className={`t-btn t-btn-quiet t-btn-sm t-btn-icon ${className}`}
        onClick={onClick}
        disabled={disabled}
      >
        {children ?? <RotateCcw aria-hidden="true" />}
      </button>
    );
  },
);
