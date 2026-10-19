import React from "react";
import { useTranslation } from "react-i18next";
import { NumberField } from "../../ui/NumberField";
import { useSettings } from "../../../hooks/useSettings";
import { useSettingsStore } from "../../../stores/settingsStore";

interface HoldThresholdProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

/**
 * Hold-or-toggle only: how long the transcribe key must be held before the
 * press counts as push-to-talk instead of a tap.
 */
export const HoldThreshold: React.FC<HoldThresholdProps> = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const defaults = useSettingsStore((s) => s.defaultSettings);
  return (
    <NumberField
      label={t("settings.debug.holdThreshold.title")}
      description={t("settings.debug.holdThreshold.description")}
      value={settings?.hold_threshold_ms ?? 300}
      onChange={(v) => updateSetting("hold_threshold_ms", Math.round(v))}
      min={100}
      max={1000}
      step={50}
      unit={t("ui.units.ms")}
      defaultValue={defaults?.hold_threshold_ms ?? undefined}
    />
  );
};
