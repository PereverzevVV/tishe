import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CircleAlert, X } from "lucide-react";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { SettingContainer } from "../ui/SettingContainer";

interface CustomWordsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const normalizeCustomWord = (word: string) =>
  word
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * «Свои слова» (SF19): a field with «Добавить», the words as tags with ×. A
 * duplicate is an error under the field, not a toast; removing a word is
 * reversible with «Вернуть».
 */
export const CustomWords: React.FC<CustomWordsProps> = React.memo(
  ({ grouped = true }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const [newWord, setNewWord] = useState("");
    const customWords = getSetting("custom_words") || [];
    const normalizedWord = normalizeCustomWord(newWord);
    const duplicate =
      normalizedWord !== "" && customWords.includes(normalizedWord);
    const busy = isUpdating("custom_words");

    const handleAddWord = () => {
      if (!normalizedWord || normalizedWord.length > 50 || duplicate) return;
      updateSetting("custom_words", [...customWords, normalizedWord]);
      setNewWord("");
    };

    const handleRemoveWord = (word: string) => {
      const before = customWords;
      updateSetting(
        "custom_words",
        customWords.filter((w) => w !== word),
      );
      toast(t("settings.advanced.customWords.removed", { word }), {
        duration: 6000,
        action: {
          label: t("ui.undo"),
          onClick: () => updateSetting("custom_words", before),
        },
      });
    };

    return (
      <SettingContainer
        settingKey="custom_words"
        ownReset
        title={t("settings.advanced.customWords.title")}
        description={t("settings.advanced.customWords.description")}
        grouped={grouped}
        layout="stacked"
        extra={
          duplicate ? (
            <div className="t-field-error">
              <CircleAlert width={14} height={14} aria-hidden="true" />
              {t("settings.advanced.customWords.duplicate", {
                word: normalizedWord,
              })}
            </div>
          ) : undefined
        }
      >
        <div className="flex items-center gap-2">
          <Input
            type="text"
            className="min-w-0 flex-1"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddWord();
              }
            }}
            placeholder={t("settings.advanced.customWords.placeholder")}
            aria-label={t("settings.advanced.customWords.placeholder")}
            invalid={duplicate}
            disabled={busy}
          />
          <Button
            onClick={handleAddWord}
            disabled={
              !normalizedWord || normalizedWord.length > 50 || duplicate || busy
            }
            variant="secondary"
          >
            {t("settings.advanced.customWords.add")}
          </Button>
        </div>
        {customWords.length > 0 && (
          <ul
            className="mt-2 flex flex-wrap gap-1"
            aria-label={t("settings.advanced.customWords.title")}
          >
            {customWords.map((word) => (
              <li key={word} className="t-tag pe-1">
                <span>{word}</span>
                <button
                  type="button"
                  className="t-tag-remove"
                  onClick={() => handleRemoveWord(word)}
                  disabled={busy}
                  aria-label={t("settings.advanced.customWords.remove", {
                    word,
                  })}
                  title={t("settings.advanced.customWords.remove", { word })}
                >
                  <X width={12} height={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingContainer>
    );
  },
);
