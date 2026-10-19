import type { ModelInfo } from "@/bindings";
import { isLegacySource } from "@/components/onboarding/ModelCard";

/**
 * The first speech model for someone who knows the language of their
 * recordings, not model names (DD-29, owner 2026-10-13). Shared by the
 * first-run screen and the «Быстрый старт» card in the main window.
 */

export type Lang = "ru" | "en" | "eu" | "other";

/** Parakeet Ultra's languages besides Russian and English. */
const EU_LANGS =
  "bg hr cs da nl et fi fr de el hu it lv lt mt pl pt ro sk sl es sv uk".split(
    " ",
  );
/** Qwen3-ASR's languages that Parakeet Ultra lacks. */
const QWEN_LANGS = "zh yue ja ko th vi id ms fil tl ar tr hi fa mk".split(" ");

/** The Windows display language: picks the first card and the model for
 * «Другой язык». */
const windowsLanguage = (navigator.language || "").toLowerCase().split("-")[0];

/** Other languages go to Qwen3-ASR 0.6B; Whisper Large v3 only when Windows
 * speaks a language Qwen3-ASR does not know (Hebrew, Kazakh, …). */
export const otherIsWhisper = ![
  "ru",
  "en",
  ...EU_LANGS,
  ...QWEN_LANGS,
].includes(windowsLanguage);

/** Catalog repositories recommended per language. */
const LANG_REPO: Record<Lang, string> = {
  ru: "handy-computer/gigaam-v3-e2e-ctc-gguf/",
  en: "handy-computer/parakeet-unified-en-0.6b-gguf/",
  eu: "handy-computer/parakeet-ultra-gguf/",
  other: otherIsWhisper
    ? "handy-computer/whisper-large-v3-gguf/"
    : "handy-computer/Qwen3-ASR-0.6B-gguf/",
};

export const systemLanguage = (): Lang => {
  if (windowsLanguage === "ru") return "ru";
  if (windowsLanguage === "en") return "en";
  if (EU_LANGS.includes(windowsLanguage)) return "eu";
  return "other";
};

/** The card for the Windows language comes first; Russian goes last on a
 * non-Russian Windows, where it is the least likely answer. */
export const LANGS: Lang[] = [
  systemLanguage(),
  ...(["en", "eu", "other", "ru"] as Lang[]).filter(
    (lang) => lang !== systemLanguage(),
  ),
];

/** The recommended model for a language, if the catalog has it (models from
 * the old download server are not offered). */
export const langModel = (
  models: ModelInfo[],
  lang: Lang,
): ModelInfo | undefined =>
  models.find((m) => m.id.startsWith(LANG_REPO[lang]) && !isLegacySource(m));

/** i18n key of the short limit line under a language card. */
export const langLimitKey = (lang: Lang) =>
  lang === "other" && otherIsWhisper
    ? "onboarding.language.other.limitWhisper"
    : `onboarding.language.${lang}.limit`;
