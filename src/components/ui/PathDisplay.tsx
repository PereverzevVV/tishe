import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

/** A read-only path (§12.2 "только чтение"): selectable text and «Открыть». */
interface PathDisplayProps {
  path: string;
  onOpen: () => void;
  disabled?: boolean;
}

export const PathDisplay: React.FC<PathDisplayProps> = ({
  path,
  onOpen,
  disabled = false,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <div className="t-type-caption t-text-secondary t-selectable min-w-0 flex-1 break-all">
        {path}
      </div>
      <Button
        onClick={onOpen}
        variant="secondary"
        size="sm"
        disabled={disabled}
      >
        {t("common.open")}
      </Button>
    </div>
  );
};
