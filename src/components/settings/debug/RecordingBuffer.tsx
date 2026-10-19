import React from "react";
import { useTranslation } from "react-i18next";
import { NumberField } from "../../ui/NumberField";
import { useSettings } from "../../../hooks/useSettings";
import { useSettingsStore } from "../../../stores/settingsStore";

interface RecordingBufferProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

/** Extra recording after the key is released, in ms (VD-81: a number field). */
export const RecordingBuffer: React.FC<RecordingBufferProps> = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const defaults = useSettingsStore((s) => s.defaultSettings);
  return (
    <NumberField
      label={t("settings.debug.recordingBuffer.title")}
      description={t("settings.debug.recordingBuffer.description")}
      value={settings?.extra_recording_buffer_ms ?? 0}
      onChange={(v) =>
        updateSetting("extra_recording_buffer_ms", Math.round(v))
      }
      min={0}
      max={1500}
      step={50}
      unit={t("ui.units.ms")}
      defaultValue={defaults?.extra_recording_buffer_ms ?? undefined}
    />
  );
};
