import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingContainer } from "../ui/SettingContainer";
import { Dropdown } from "../ui/Dropdown";
import { ResetButton } from "../ui/ResetButton";
import { useSettings } from "../../hooks/useSettings";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  LANGUAGES,
  recognitionLanguage,
  supportsLanguageCode,
} from "../../lib/constants/languages";
import { languageName } from "../../lib/utils/humanize";

interface LanguageSelectorProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  supportedLanguages?: string[];
  // Whether the model can auto-detect language. Gates the "Auto" option:
  // must-pick models (no detection) omit it and force a concrete choice.
  supportsLanguageDetection?: boolean;
  disabled?: boolean;
  /** Why it is disabled, shown as visible text (no tooltip). */
  disabledReason?: string;
}

// Mirrors the matching logic of `effective_language` in
// src-tauri/src/managers/model.rs. The Rust function is authoritative for the
// *concrete* code the engine receives (e.g. `nb`); this resolves the canonical
// picker intent (e.g. `no`) so model switches preserve the user's language.
// Model codes such as `en-US` and `nb` resolve to their `en` / `no` entry.
const effectiveLanguage = (
  intent: string,
  supported: string[],
  supportsDetection: boolean,
): string => {
  if (supported.length === 0) return recognitionLanguage(intent);
  if (intent !== "auto" && supportsLanguageCode(supported, intent))
    return recognitionLanguage(intent);
  if (supportsDetection) return "auto";
  if (supportsLanguageCode(supported, "en")) return "en";
  return recognitionLanguage(supported[0]);
};

/** «Язык распознавания» on «Модели»: one list with search (§12.3). */
export const LanguageSelector: React.FC<LanguageSelectorProps> = ({
  grouped = true,
  supportedLanguages,
  supportsLanguageDetection = true,
  disabled = false,
  disabledReason,
}) => {
  const { t, i18n } = useTranslation();
  const { getSetting, updateSetting, resetSetting, isUpdating } = useSettings();
  const defaults = useSettingsStore((s) => s.defaultSettings);

  // The persisted *intent* (auto | code). What's actually used/shown is the
  // effective value resolved against the current model's capabilities.
  const intent = getSetting("selected_language") || "auto";
  const selectedLanguage = effectiveLanguage(
    intent,
    supportedLanguages ?? [],
    supportsLanguageDetection,
  );

  const options = useMemo(() => {
    const available =
      !supportedLanguages || supportedLanguages.length === 0
        ? LANGUAGES
        : LANGUAGES.filter((lang) =>
            lang.value === "auto"
              ? supportsLanguageDetection
              : supportsLanguageCode(supportedLanguages, lang.value),
          );
    return available.map((lang) => ({
      value: lang.value,
      label:
        lang.value === "auto"
          ? t("settings.general.language.auto")
          : capitalize(languageName(lang.value, i18n.language)),
    }));
  }, [supportedLanguages, supportsLanguageDetection, t, i18n.language]);

  const busy = isUpdating("selected_language");
  const changed = defaults
    ? intent !== (defaults.selected_language ?? "auto")
    : false;

  return (
    <SettingContainer
      title={t("settings.general.language.title")}
      description={disabledReason ?? t("settings.general.language.description")}
      grouped={grouped}
      disabled={disabled}
    >
      <Dropdown
        ariaLabel={t("settings.general.language.title")}
        options={options}
        selectedValue={selectedLanguage}
        onSelect={(code) => void updateSetting("selected_language", code)}
        disabled={busy || disabled}
      />
      {changed && (
        <ResetButton
          onClick={() => void resetSetting("selected_language")}
          disabled={busy || disabled}
        />
      )}
    </SettingContainer>
  );
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
