import type { TFunction } from "i18next";

/**
 * File transcription errors come from the backend as English text (they also
 * go to the log and to event scripts as is). The ones a person can run into
 * get a translated message here; anything else is shown as it came. Order
 * matters: the first match wins.
 */
const RULES: [RegExp, string][] = [
  [/ffmpeg not found/i, "fileTranscription.ffmpegMissing"],
  [/input file not found/i, "fileErrors.notFound"],
  // Disk and lock problems first: ffmpeg reports them inside its own error.
  [
    /os error 112|os error 28\b|not enough space|no space left/i,
    "fileErrors.noSpace",
  ],
  [/os error 32\b|used by another process/i, "fileErrors.fileInUse"],
  [/has no audio track|audio track is empty/i, "fileErrors.noAudio"],
  [/ffmpeg failed to extract audio/i, "fileErrors.unreadable"],
  [/no local model is selected/i, "fileErrors.noModel"],
  [/speaker model is not downloaded/i, "fileErrors.noSpeakerModel"],
  [/local LLM model .* is not downloaded/i, "fileErrors.noLlmModel"],
  [/llama-server\) is missing/i, "fileErrors.noLlmRuntime"],
  [/needs an API key/i, "fileErrors.cloudKey"],
  [/needs an API URL|selected but not configured/i, "fileErrors.cloudConfig"],
  [/already running/i, "fileErrors.busy"],
  [
    /os error 5\b|os error 13\b|access is denied|permission denied/i,
    "fileErrors.accessDenied",
  ],
];

export const localizeFileError = (raw: string, t: TFunction): string => {
  for (const [pattern, key] of RULES) {
    if (pattern.test(raw)) return t(key);
  }
  return raw;
};
