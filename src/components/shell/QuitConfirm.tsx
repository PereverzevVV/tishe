import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { fileName } from "@/lib/utils/humanize";

/**
 * «Выход» in the tray while a transcription runs (UX_INTERACTION_ARCHITECTURE,
 * Destructive Actions): the tray shows the window and asks here. Focus is on
 * «Остаться»; «Выйти» stops the transcription and quits. Finished documents
 * are on disk already.
 */
export const QuitConfirm: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = useFileTranscriptionStore((s) => s.items);
  const progress = useFileTranscriptionStore((s) => s.progress);
  const running = useFileTranscriptionStore((s) => s.running);
  const cancel = useFileTranscriptionStore((s) => s.cancel);

  useEffect(() => {
    const unlisten = listen("confirm-quit", () => setOpen(true));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const current = items.find((i) => i.status === "running");

  const quit = async () => {
    setOpen(false);
    if (running) await cancel().catch(() => {});
    await exit(0);
  };

  return (
    <ConfirmDialog
      open={open}
      title={t("app.quit.title")}
      confirmLabel={t("app.quit.confirm")}
      cancelLabel={t("app.quit.stay")}
      onConfirm={() => void quit()}
      onCancel={() => setOpen(false)}
    >
      {current
        ? t("app.quit.body", {
            name: fileName(current.inputPath),
            pct: Math.round((progress?.fraction ?? 0) * 100),
          })
        : t("app.quit.bodyIdle")}
    </ConfirmDialog>
  );
};
