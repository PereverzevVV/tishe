import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface AudioFeedbackProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/** «Звуковой отклик»: theme, output device and volume appear under it when on. */
export const AudioFeedback: React.FC<AudioFeedbackProps> = React.memo(
  ({ grouped = true }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const audioFeedbackEnabled = getSetting("audio_feedback") || false;

    return (
      <ToggleSwitch
        checked={audioFeedbackEnabled}
        onChange={(enabled) => updateSetting("audio_feedback", enabled)}
        isUpdating={isUpdating("audio_feedback")}
        label={t("settings.sound.audioFeedback.label")}
        description={t("settings.sound.audioFeedback.description")}
        grouped={grouped}
      />
    );
  },
);
