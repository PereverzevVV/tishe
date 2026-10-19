import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { useSettingsStore } from "../../stores/settingsStore";
import { SettingContainer } from "../ui/SettingContainer";
import { Segments } from "../ui/Segments";

/**
 * Feedback volume as three steps (VD-81): «Тихо | Средне | Громко» =
 * 0.3 / 0.6 / 1.0. A stored value in between is shown as the nearest step and
 * is not rewritten until the person picks one. Picking plays the sound once.
 */
const LEVELS = [
  { value: "quiet", volume: 0.3 },
  { value: "medium", volume: 0.6 },
  { value: "loud", volume: 1.0 },
] as const;

const nearest = (volume: number): string =>
  LEVELS.reduce<(typeof LEVELS)[number]>(
    (best, l) =>
      Math.abs(l.volume - volume) < Math.abs(best.volume - volume) ? l : best,
    LEVELS[2],
  ).value;

export const VolumeSlider: React.FC<{
  disabled?: boolean;
  dependent?: boolean;
}> = ({ disabled = false, dependent }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const playTestSound = useSettingsStore((s) => s.playTestSound);
  const volume = getSetting("audio_feedback_volume") ?? 1.0;

  return (
    <SettingContainer
      title={t("settings.sound.volume.title")}
      dependent={dependent}
    >
      <Segments
        ariaLabel={t("settings.sound.volume.title")}
        value={nearest(volume)}
        disabled={disabled}
        onChange={async (value) => {
          const level = LEVELS.find((l) => l.value === value);
          if (!level) return;
          await updateSetting("audio_feedback_volume", level.volume);
          void playTestSound("start");
        }}
        options={LEVELS.map((l) => ({
          value: l.value,
          label: t(`settings.sound.volume.levels.${l.value}`),
        }))}
      />
    </SettingContainer>
  );
};
