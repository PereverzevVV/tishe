import React from "react";
import { useTranslation } from "react-i18next";
import { NumberField } from "../../ui/NumberField";
import { useSettings } from "../../../hooks/useSettings";
import { useSettingsStore } from "../../../stores/settingsStore";

type PasteDelayKey = "paste_delay_ms" | "paste_delay_after_ms";

interface PasteDelayProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
  settingKey?: PasteDelayKey;
  labelKey?: string;
  descriptionKey?: string;
}

/** Paste delay before or after the paste key, in ms (VD-81: a number field). */
export const PasteDelay: React.FC<PasteDelayProps> = ({
  settingKey = "paste_delay_ms",
  labelKey = "settings.debug.pasteDelay.title",
  descriptionKey = "settings.debug.pasteDelay.description",
}) => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const defaults = useSettingsStore((s) => s.defaultSettings);
  return (
    <NumberField
      label={t(labelKey)}
      description={t(descriptionKey)}
      value={settings?.[settingKey] ?? 60}
      onChange={(v) => updateSetting(settingKey, Math.round(v))}
      min={10}
      max={5000}
      step={10}
      unit={t("ui.units.ms")}
      defaultValue={defaults?.[settingKey] ?? undefined}
    />
  );
};
