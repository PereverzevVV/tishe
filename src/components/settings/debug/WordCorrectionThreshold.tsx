import React from "react";
import { useTranslation } from "react-i18next";
import { NumberField } from "../../ui/NumberField";
import { useSettings } from "../../../hooks/useSettings";
import { useSettingsStore } from "../../../stores/settingsStore";

interface WordCorrectionThresholdProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
  dependent?: boolean;
}

/** How close a word must be to one of «Свои слова» to be replaced (0–1). */
export const WordCorrectionThreshold: React.FC<
  WordCorrectionThresholdProps
> = ({ dependent }) => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const defaults = useSettingsStore((s) => s.defaultSettings);
  return (
    <NumberField
      dependent={dependent}
      label={t("settings.debug.wordCorrectionThreshold.title")}
      description={t("settings.debug.wordCorrectionThreshold.description")}
      value={settings?.word_correction_threshold ?? 0.18}
      onChange={(v) =>
        updateSetting("word_correction_threshold", Math.round(v * 100) / 100)
      }
      min={0}
      max={1}
      step={0.01}
      defaultValue={defaults?.word_correction_threshold ?? undefined}
    />
  );
};
