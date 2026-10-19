import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelStore } from "@/stores/modelStore";
import { formatBytes } from "@/lib/utils/humanize";

export type ModelDownloadState =
  | "idle"
  | "downloading"
  | "preparing"
  | "done"
  | "failed";

/**
 * Download state of one speech model for the setup screens: what to draw
 * (progress, «Готовлю модель…», a failed download) and the two actions. The
 * download itself lives in the model store, so it keeps going when the
 * screen that started it closes.
 */
export const useModelDownload = (modelId: string | undefined) => {
  const { t, i18n } = useTranslation();
  const {
    models,
    downloadingModels,
    verifyingModels,
    extractingModels,
    downloadProgress,
    downloadStats,
    downloadModel,
    cancelDownload,
  } = useModelStore();
  const [failedId, setFailedId] = useState<string | null>(null);
  const cancelled = useRef(false);
  const model = models.find((m) => m.id === modelId);
  const id = modelId ?? "";
  const progress = downloadProgress[id];
  const speed = downloadStats[id]?.speed;
  const preparing = id in verifyingModels || id in extractingModels;

  let state: ModelDownloadState = "idle";
  if (preparing) state = "preparing";
  else if (model?.is_downloaded) state = "done";
  else if (id in downloadingModels) state = "downloading";
  else if (id && failedId === id) state = "failed";

  const amount =
    progress && progress.total > 0
      ? t("onboarding.download.amount", {
          done: formatBytes(progress.downloaded, t, i18n.language),
          total: formatBytes(progress.total, t, i18n.language),
        })
      : t("onboarding.download.starting");
  const speedText = speed
    ? t("onboarding.download.speed", {
        n: speed.toLocaleString(i18n.language, { maximumFractionDigits: 1 }),
      })
    : "";

  const start = async () => {
    if (!modelId) return false;
    cancelled.current = false;
    setFailedId(null);
    const ok = await downloadModel(modelId);
    if (!ok && !cancelled.current) setFailedId(modelId);
    return ok;
  };

  const cancel = async () => {
    if (!modelId) return;
    cancelled.current = true;
    await cancelDownload(modelId);
  };

  return {
    model,
    state,
    percent: progress?.percentage ?? 0,
    /** «110 МБ из 241 МБ · 5,2 МБ/с» or «Подключаюсь…». */
    detail: [amount, speedText].filter(Boolean).join(" · "),
    start,
    cancel,
  };
};
