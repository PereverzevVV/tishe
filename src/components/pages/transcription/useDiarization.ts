import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type DiarizationModelInfo } from "@/bindings";

/** Speaker models (Говорящие): catalog, download progress, actions. */

// Per-model presentation; the catalog itself lives in the backend.
export const SPEAKER_MODEL_LOOK: Record<
  string,
  { key: string; recommended?: boolean }
> = {
  "wespeaker-resnet34": { key: "wespeaker_resnet34", recommended: true },
  "3dspeaker-eres2net": { key: "eres2net" },
};

export const RECOMMENDED_SPEAKER_MODEL = "wespeaker-resnet34";

/** The model to use: the chosen one if downloaded, else any downloaded one. */
const pickDiarizationModel = (
  models: DiarizationModelInfo[],
  chosen: string | null,
): string | null =>
  models.find((m) => m.downloaded && m.id === chosen)?.id ??
  models.find((m) => m.downloaded)?.id ??
  null;

export const useDiarization = (
  chosen: string | null,
  onDownloaded: (id: string) => void,
) => {
  const [models, setModels] = useState<DiarizationModelInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setModels(await commands.diarizationListModels());
  }, []);

  useEffect(() => {
    void reload();
    const unlisten = listen<{ model_id: string; percentage: number }>(
      "diarization-download-progress",
      (e) =>
        setProgress((p) => ({
          ...p,
          [e.payload.model_id]: e.payload.percentage,
        })),
    );
    return () => void unlisten.then((f) => f());
  }, [reload]);

  const ready = pickDiarizationModel(models, chosen);

  const download = async (id: string) => {
    setError(null);
    setProgress((p) => ({ ...p, [id]: 0 }));
    setModels((ms) =>
      ms.map((m) => (m.id === id ? { ...m, downloading: true } : m)),
    );
    const res = await commands.diarizationDownloadModel(id);
    if (res.status === "error") setError(res.error);
    else if (res.data && !ready) onDownloaded(id);
    setProgress((p) => {
      const { [id]: _, ...rest } = p;
      return rest;
    });
    await reload();
  };

  const cancel = (id: string) => commands.diarizationCancelDownload(id);

  const remove = async (id: string) => {
    setError(null);
    const res = await commands.diarizationDeleteModel(id);
    if (res.status === "error") setError(res.error);
    await reload();
  };

  return { models, progress, error, ready, download, cancel, remove };
};
