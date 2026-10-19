import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  commands,
  type FileTranscriptionRequest,
  type FileTranscriptionResult,
} from "@/bindings";
import { useNavigationStore } from "./navigationStore";

export type FileTranscriptionStage =
  | "extracting"
  | "diarizing"
  | "splitting"
  | "transcribing"
  | "post_processing"
  | "writing";

export interface FileTranscriptionProgress {
  stage: FileTranscriptionStage;
  part: number;
  total_parts: number;
  fraction: number;
}

export type QueueStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

/** What the file was transcribed with, shown in the result row. */
export interface QueueRecipe {
  speakers: boolean;
  editing: boolean;
  cloud: boolean;
}

export interface QueueItem {
  id: string;
  inputPath: string;
  status: QueueStatus;
  result: FileTranscriptionResult | null;
  error: string | null;
  /** When the file finished (done, error or cancelled). */
  finishedAt: number | null;
  recipe: QueueRecipe | null;
  /** The document of a finished file is no longer on disk (CF7). */
  missing?: boolean;
}

/**
 * Finished documents are kept between runs of the program (owner decision,
 * second stage; CF7), up to this many. Older ones drop out of the list; the
 * documents on disk are never touched.
 */
export const RESULTS_KEPT = 50;

/** Builds the backend request for one queued file. */
export type RequestBuilder = (
  inputPath: string,
) => Promise<FileTranscriptionRequest>;

// Queue state lives outside the settings page so a running queue keeps its
// progress when the user switches to another section and back.
//
// Each file is a separate backend job: nothing (text, prompt context, LLM
// history) is carried from one file to the next.
interface FileTranscriptionStore {
  items: QueueItem[];
  running: boolean;
  /** When the current file started. */
  startedAt: number;
  progress: FileTranscriptionProgress | null;
  /** The last run was stopped by the person («Отменить», quit). */
  lastRunStopped: boolean;
  /** Files of the current run, in order («файл 2 из 3»). */
  runIds: string[];
  addFiles: (paths: string[]) => void;
  removeItem: (id: string) => void;
  clearFinished: () => void;
  /** Put removed rows back («Вернуть» in the toast). */
  restoreItems: (items: QueueItem[]) => void;
  /** Process every file that isn't done yet, one after another. */
  startQueue: (build: RequestBuilder, recipe?: QueueRecipe) => Promise<void>;
  /** Stop the current file and the rest of the queue. */
  cancel: () => Promise<void>;
  /** Read the results kept from earlier runs (once, at start). */
  loadResults: () => Promise<void>;
  /** Mark results whose document was moved or deleted («Файл не найден»). */
  checkResults: () => Promise<void>;
}

let nextId = 0;
let stopRequested = false;
// Ids stay unique across runs: results from earlier runs keep theirs.
const newId = () => `f${Date.now().toString(36)}${(++nextId).toString(36)}`;

const disk = new LazyStore("file_results.json");
const RESULTS_STORE_KEY = "results";
let resultsLoaded = false;

/** Finished documents, newest first, without the per-run «missing» flag. */
const keptResults = (items: QueueItem[]): QueueItem[] =>
  items
    .filter((i) => i.status === "done" && i.result)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, RESULTS_KEPT)
    .map(({ missing: _missing, ...rest }) => rest);

let lastSaved = "";
const saveResults = (items: QueueItem[]) => {
  if (!resultsLoaded) return;
  const kept = keptResults(items);
  const json = JSON.stringify(kept);
  if (json === lastSaved) return;
  lastSaved = json;
  disk
    .set(RESULTS_STORE_KEY, kept)
    .then(() => disk.save())
    .catch((e) => console.warn("Failed to save transcription results", e));
};

const patchItem = (
  items: QueueItem[],
  id: string,
  patch: Partial<QueueItem>,
): QueueItem[] => items.map((i) => (i.id === id ? { ...i, ...patch } : i));

export const useFileTranscriptionStore = create<FileTranscriptionStore>()(
  (set, get) => ({
    items: [],
    running: false,
    startedAt: 0,
    progress: null,
    runIds: [],
    lastRunStopped: false,

    addFiles: (paths) => {
      const queued = new Set(
        get()
          .items.filter((i) => i.status === "pending" || i.status === "running")
          .map((i) => i.inputPath),
      );
      const added = paths
        .filter((p) => !queued.has(p))
        .map<QueueItem>((inputPath) => ({
          id: newId(),
          inputPath,
          status: "pending",
          result: null,
          error: null,
          finishedAt: null,
          recipe: null,
        }));
      if (!added.length) return;
      set({
        items: [...get().items, ...added],
        // Files added during a run join it with the same recipe.
        runIds: get().running
          ? [...get().runIds, ...added.map((a) => a.id)]
          : get().runIds,
      });
    },

    removeItem: (id) =>
      set({
        items: get().items.filter((i) => i.id !== id || i.status === "running"),
      }),

    clearFinished: () =>
      set({
        items: get().items.filter(
          (i) => i.status === "pending" || i.status === "running",
        ),
      }),

    restoreItems: (restored) => {
      const present = new Set(get().items.map((i) => i.id));
      const back = restored.filter((i) => !present.has(i.id));
      if (back.length) set({ items: [...get().items, ...back] });
    },

    startQueue: async (build, recipe) => {
      if (get().running) return;
      stopRequested = false;
      const items = get().items.map((i) =>
        i.status === "error" || i.status === "cancelled"
          ? { ...i, status: "pending" as const, error: null, finishedAt: null }
          : i,
      );
      set({
        running: true,
        items,
        runIds: items.filter((i) => i.status === "pending").map((i) => i.id),
      });
      await commands.setFileQueueHold(true).catch(() => {});
      try {
        while (!stopRequested) {
          const next = get().items.find((i) => i.status === "pending");
          if (!next) break;
          set({
            items: patchItem(get().items, next.id, {
              status: "running",
              recipe: recipe ?? null,
            }),
            startedAt: Date.now(),
            progress: null,
          });
          let patch: Partial<QueueItem>;
          try {
            const res = await commands.transcribeMediaFile(
              await build(next.inputPath),
            );
            if (res.status === "ok") {
              patch = { status: "done", result: res.data };
            } else if (res.error === "cancelled") {
              patch = { status: "cancelled" };
            } else {
              patch = { status: "error", error: res.error };
            }
          } catch (e) {
            patch = { status: "error", error: String(e) };
          }
          set({
            items: patchItem(get().items, next.id, {
              ...patch,
              finishedAt: Date.now(),
            }),
            progress: null,
          });
        }
      } finally {
        await commands.setFileQueueHold(false).catch(() => {});
        set({ running: false, progress: null, lastRunStopped: stopRequested });
        // «Готово, не просмотрено»: a dot on «Расшифровка» in the sidebar.
        const nav = useNavigationStore.getState();
        if (nav.section !== "transcription" || document.hidden)
          nav.setUnseenResults(true);
      }
    },

    cancel: async () => {
      stopRequested = true;
      await commands.cancelMediaFileTranscription();
    },

    loadResults: async () => {
      if (resultsLoaded) return;
      try {
        const saved = (await disk.get<QueueItem[]>(RESULTS_STORE_KEY)) ?? [];
        const present = new Set(get().items.map((i) => i.id));
        const back = saved.filter(
          (i) => i.status === "done" && i.result && !present.has(i.id),
        );
        lastSaved = JSON.stringify(saved);
        if (back.length) set({ items: [...get().items, ...back] });
      } catch (e) {
        console.warn("Failed to read transcription results", e);
      }
      resultsLoaded = true;
      await get().checkResults();
    },

    checkResults: async () => {
      const done = get().items.filter((i) => i.status === "done" && i.result);
      if (!done.length) return;
      try {
        const exist = await commands.pathsExist(
          done.map((i) => i.result!.output_path),
        );
        const missing = new Map(done.map((item, n) => [item.id, !exist[n]]));
        set({
          items: get().items.map((i) =>
            missing.has(i.id) && Boolean(i.missing) !== missing.get(i.id)
              ? { ...i, missing: missing.get(i.id) }
              : i,
          ),
        });
      } catch (e) {
        console.warn("Failed to check transcription documents", e);
      }
    },
  }),
);

// Keep finished documents between runs.
useFileTranscriptionStore.subscribe((state, prev) => {
  if (state.items !== prev.items) saveResults(state.items);
});

listen<FileTranscriptionProgress>("file-transcription-progress", (event) => {
  if (useFileTranscriptionStore.getState().running) {
    useFileTranscriptionStore.setState({ progress: event.payload });
  }
}).catch((e) =>
  console.warn("Failed to listen for file transcription progress", e),
);
