import { listen } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import { commands, type OverlayMessageKind } from "@/bindings";
import {
  useFileTranscriptionStore,
  type QueueItem,
} from "@/stores/fileTranscriptionStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { fileName } from "@/lib/utils/humanize";

/**
 * What the transcription queue tells the world outside the window
 * (UX_INTERACTION_ARCHITECTURE: Трей, Уведомления Windows, CF6):
 * - the tray tooltip line, «Расшифровка: файл 2 из 3 · 47 %» while it runs
 *   and «Расшифровка готова: 3 файла» until the results are seen;
 * - one Windows notification when a run ends (shown by Rust only if the
 *   window is hidden or not in focus); a click reveals the row.
 */

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options) as string;

/** Anchor of a queue row (FileList). */
export const rowAnchor = (item: QueueItem) => `file-${item.id}`;

const tooltipLine = (): string | null => {
  const s = useFileTranscriptionStore.getState();
  if (s.running) {
    const current = s.items.find((i) => i.status === "running");
    const index = current ? s.runIds.indexOf(current.id) + 1 : 1;
    return t("transcription.tray.running", {
      current: Math.max(index, 1),
      total: Math.max(s.runIds.length, 1),
      pct: Math.round((s.progress?.fraction ?? 0) * 100),
    });
  }
  if (useNavigationStore.getState().unseenResults) {
    const done = s.items.filter(
      (i) => s.runIds.includes(i.id) && i.status === "done",
    ).length;
    if (done) return t("transcription.tray.ready", { count: done });
  }
  return null;
};

let lastTip: string | null | undefined;
const syncTooltip = () => {
  const line = tooltipLine();
  if (line === lastTip) return;
  lastTip = line;
  void commands.setFileQueueTooltip(line).catch(() => {});
};

const shortReason = (error: string | null): string => {
  const line = (error ?? "").split("\n")[0].trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

const notifyRunEnd = (runIds: string[], stopped: boolean) => {
  if (stopped) return;
  const items = useFileTranscriptionStore.getState().items;
  const ran = runIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is QueueItem => Boolean(i));
  const ok = ran.filter((i) => i.status === "done" && i.result);
  const failed = ran.filter((i) => i.status === "error");
  if (!ok.length && !failed.length) return;

  let title: string;
  let body: string;
  let openPath: string | null = null;
  let target: QueueItem;
  if (!failed.length) {
    target = ok[0];
    if (ok.length === 1) {
      title = t("transcription.notify.readyOne");
      body = fileName(ok[0].result!.output_path);
      openPath = ok[0].result!.output_path;
    } else {
      title = t("transcription.notify.readyMany", { count: ok.length });
      const names = ok.slice(0, 3).map((i) => fileName(i.inputPath));
      body = names.join(", ") + (ok.length > 3 ? "…" : "");
    }
  } else if (!ok.length) {
    target = failed[0];
    const reasons = new Set(failed.map((i) => shortReason(i.error)));
    if (failed.length === 1) {
      title = t("transcription.notify.failedOne");
      body = `${fileName(failed[0].inputPath)} · ${shortReason(failed[0].error)}`;
    } else {
      title = t("transcription.notify.failedMany", { count: failed.length });
      body =
        reasons.size === 1
          ? [...reasons][0]
          : `${fileName(failed[0].inputPath)} · ${shortReason(failed[0].error)}`;
    }
  } else {
    target = failed[0];
    title = t("transcription.notify.partial", {
      ok: ok.length,
      total: ok.length + failed.length,
      errors: t("transcription.notify.errors", { count: failed.length }),
    });
    body = t("transcription.notify.failedFile", {
      name: fileName(failed[0].inputPath),
      reason: shortReason(failed[0].error),
    });
  }

  void commands
    .notifyFileQueue(
      title,
      body,
      openPath,
      openPath ? t("transcription.notify.open") : null,
      rowAnchor(target),
    )
    .catch(() => {});
};

let started = false;

/** Called once from App. */
export const startQueueSignals = () => {
  if (started) return;
  started = true;
  useFileTranscriptionStore.subscribe((state, prev) => {
    syncTooltip();
    if (prev.running && !state.running)
      notifyRunEnd(state.runIds, state.lastRunStopped);
  });
  useNavigationStore.subscribe((state, prev) => {
    if (state.unseenResults !== prev.unseenResults) syncTooltip();
  });
  i18n.on("languageChanged", () => {
    lastTip = undefined;
    syncTooltip();
  });
  void listen<{ target: string | null }>("notification-activated", (event) => {
    useNavigationStore
      .getState()
      .reveal("transcription", event.payload.target ?? undefined);
  });
  // «Что делать» in an overlay message (S15): the help for that failure.
  void listen<OverlayMessageKind>("open-help", (event) => {
    const nav = useNavigationStore.getState();
    switch (event.payload) {
      case "paste_failed":
        nav.reveal("dictation", "dictation-fix-paste", "dictation-fix");
        break;
      case "editing_skipped":
        nav.reveal("llm", "llm-status");
        break;
      case "no_microphone":
      case "microphone_denied":
        nav.reveal("dictation", "dictation-sound");
        break;
    }
  });
};
