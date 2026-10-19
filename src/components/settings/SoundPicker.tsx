import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PlayIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Dropdown, DropdownOption } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSettings } from "../../hooks/useSettings";

interface SoundPickerProps {
  label: string;
  description?: string;
  dependent?: boolean;
}

/** Sound theme of the feedback, with ▶ to hear start and stop. */
export const SoundPicker: React.FC<SoundPickerProps> = ({
  label,
  description,
  dependent,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const playTestSound = useSettingsStore((state) => state.playTestSound);
  const customSounds = useSettingsStore((state) => state.customSounds);
  const checkCustomSounds = useSettingsStore(
    (state) => state.checkCustomSounds,
  );

  const selectedTheme = getSetting("sound_theme") ?? "marimba";

  useEffect(() => {
    checkCustomSounds();
  }, [checkCustomSounds]);

  const options: DropdownOption[] = [
    { value: "marimba", label: t("settings.sound.theme.marimba") },
    { value: "pop", label: t("settings.sound.theme.pop") },
  ];

  // Only add Custom option if both custom sound files exist
  if (customSounds.start && customSounds.stop) {
    options.push({ value: "custom", label: t("settings.sound.theme.custom") });
  }

  const handlePlayBothSounds = async () => {
    await playTestSound("start");
    await playTestSound("stop");
  };

  return (
    <SettingContainer
      title={label}
      description={description}
      dependent={dependent}
    >
      <Dropdown
        selectedValue={selectedTheme}
        onSelect={(value) =>
          updateSetting("sound_theme", value as "marimba" | "pop" | "custom")
        }
        options={options}
        onOpen={checkCustomSounds}
        ariaLabel={label}
      />
      <Button
        variant="quiet"
        icon
        onClick={handlePlayBothSounds}
        aria-label={t("settings.sound.theme.preview")}
        title={t("settings.sound.theme.preview")}
      >
        <PlayIcon aria-hidden="true" />
      </Button>
    </SettingContainer>
  );
};
