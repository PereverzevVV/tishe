import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  type AppSettings,
  type LocalLlmModelInfo,
  type LocalLlmStatus,
} from "@/bindings";

/**
 * The built-in LLM («Нейросеть») as one resource for the whole window: the
 * catalog, download progress and the process state. «Нейросеть» manages it;
 * «Расшифровка» and «Диктовка» only read its readiness (ownership rule,
 * UX_ARCHITECTURE_PROPOSAL); the sidebar shows a spinner while it downloads.
 */

export const LOCAL_PROVIDER_ID = "local";
export const APPLE_PROVIDER_ID = "apple_intelligence";
export const CUSTOM_PROVIDER_ID = "custom";
export const RECOMMENDED_LOCAL_MODEL = "gemma-4-e4b-qat";

export interface ModelLook {
  /** Translation key under settings.postProcessing.local.models. */
  key: string;
  /** 1–5, from the bench on a laptop CPU (see DOCUMENTATION.md §3.1, §9.3). */
  speed: number;
  quality: number;
  /** Memory while loaded, GB. */
  ramGb: number;
  recommended?: boolean;
  /** Ships with a speedup (speculative decoding); see `Speedup` in local_llm.rs. */
  speedup?: boolean;
  /** Not run on the bench: speed and quality are estimates. */
  untested?: boolean;
}

// Per-model presentation; the catalog itself lives in the backend.
// Speed is minutes of LLM work per hour of Russian speech on a laptop CPU
// (bench 2026-10-06, DOCUMENTATION §9.3): 5 ≤ 12, 4 ≤ 18, 3 ≤ 27, 2 ≤ 40,
// 1 slower. Quality is fixes against new errors on the same bench.
export const MODEL_LOOK: Record<string, ModelLook> = {
  "gemma-4-e4b-qat": {
    key: "gemma4_e4b_qat",
    speed: 3,
    quality: 4,
    ramGb: 6.3,
    speedup: true,
    recommended: true,
  },
  "gemma-4-e2b-qat": {
    key: "gemma4_e2b_qat",
    speed: 4,
    quality: 3,
    ramGb: 4.4,
    speedup: true,
  },
  "qwen3.5-4b-mtp": {
    key: "qwen35_4b_mtp",
    speed: 3,
    quality: 3,
    ramGb: 4.9,
    speedup: true,
  },
  "gemma-4-e4b": { key: "gemma4_e4b", speed: 2, quality: 4, ramGb: 5.7 },
  "qwen3.5-4b": { key: "qwen35_4b", speed: 2, quality: 2, ramGb: 4.7 },
  // Bench 2026-10-14 (DOCUMENTATION §9.13): Ruadapt 25 chars/s, fixes but
  // also breaks words; Nemotron 19 chars/s, leaves the text almost as is.
  // Memory is an estimate (file size + context).
  "ruadapt-qwen3-4b": {
    key: "ruadapt_qwen3_4b",
    speed: 3,
    quality: 2,
    ramGb: 4.4,
  },
  "nemotron-3-nano-4b": {
    key: "nemotron3_nano_4b",
    speed: 2,
    quality: 1,
    ramGb: 4,
  },
  // Not measured on the bench: estimates.
  "gigachat-3.1-10b-a1.8b": {
    key: "gigachat31",
    speed: 4,
    quality: 4,
    ramGb: 7.5,
    untested: true,
  },
  "qwen3.5-9b": {
    key: "qwen35_9b",
    speed: 1,
    quality: 5,
    ramGb: 8,
    untested: true,
  },
};

interface LlmStore {
  models: LocalLlmModelInfo[];
  status: LocalLlmStatus | null;
  /** Download percentage by model id. */
  progress: Record<string, number>;
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  download: (id: string) => Promise<boolean>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  stop: () => Promise<void>;
  clearError: () => void;
}

let listening = false;

export const useLlmStore = create<LlmStore>()((set, get) => ({
  models: [],
  status: null,
  progress: {},
  error: null,
  loaded: false,

  load: async () => {
    if (!listening) {
      listening = true;
      listen<{ model_id: string; percentage: number }>(
        "local-llm-download-progress",
        (e) =>
          set((s) => ({
            progress: {
              ...s.progress,
              [e.payload.model_id]: e.payload.percentage,
            },
          })),
      ).catch(() => {});
      listen<LocalLlmStatus>("local-llm-state", (e) =>
        set({ status: e.payload }),
      ).catch(() => {});
    }
    if (get().loaded) return;
    await get().reload();
    set({ loaded: true });
  },

  reload: async () => {
    try {
      const [models, status] = await Promise.all([
        commands.localLlmListModels(),
        commands.localLlmStatus(),
      ]);
      set({ models, status });
      // The backend changes the chosen local model on its own after a
      // download or a delete (it picks a fallback) without a settings event;
      // re-read settings so the page and the start gate see the new choice.
      void useSettingsStore.getState().refreshSettings();
    } catch (e) {
      console.warn("Failed to load the built-in LLM state", e);
    }
  },

  download: async (id) => {
    set((s) => ({
      error: null,
      progress: { ...s.progress, [id]: 0 },
      models: s.models.map((m) =>
        m.id === id ? { ...m, downloading: true } : m,
      ),
    }));
    const res = await commands.localLlmDownloadModel(id);
    if (res.status === "error") set({ error: res.error });
    set((s) => {
      const { [id]: _, ...rest } = s.progress;
      return { progress: rest };
    });
    await get().reload();
    return res.status === "ok" && res.data;
  },

  cancel: async (id) => {
    await commands.localLlmCancelDownload(id);
  },

  remove: async (id) => {
    set({ error: null });
    const res = await commands.localLlmDeleteModel(id);
    if (res.status === "error") set({ error: res.error });
    await get().reload();
  },

  stop: async () => {
    await commands.localLlmStop();
  },

  clearError: () => set({ error: null }),
}));

export type LlmWhere = "local" | "server" | "cloud";

/** Where the text goes for a provider (Нейросеть → «Где работает нейросеть»). */
export const providerWhere = (providerId: string): LlmWhere =>
  providerId === LOCAL_PROVIDER_ID || providerId === APPLE_PROVIDER_ID
    ? "local"
    : providerId === CUSTOM_PROVIDER_ID
      ? "server"
      : "cloud";

/** True when the address points at this computer (Ollama, LM Studio). */
export const isLocalAddress = (url: string): boolean =>
  /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.trim());

export type LlmProblem =
  | "noModel"
  | "downloading"
  | "runtime"
  | "noKey"
  | "noUrl"
  | "noServerModel";

export interface LlmReadiness {
  where: LlmWhere;
  providerId: string;
  providerLabel: string;
  /** Model id: local catalog id or the provider's model name. */
  modelId: string;
  ready: boolean;
  problem: LlmProblem | null;
  /** Download percentage of the recommended model while it downloads. */
  percent: number | null;
  baseUrl: string;
}

/** Readiness of the editing LLM, computed from settings and the LLM store. */
export const llmReadiness = (
  settings: AppSettings | null,
  llm: Pick<LlmStore, "models" | "status" | "progress">,
): LlmReadiness => {
  const providers = settings?.post_process_providers ?? [];
  const providerId =
    settings?.post_process_provider_id || providers[0]?.id || LOCAL_PROVIDER_ID;
  const provider = providers.find((p) => p.id === providerId);
  const where = providerWhere(providerId);
  const modelId = settings?.post_process_models?.[providerId] ?? "";
  const baseUrl = provider?.base_url ?? "";
  const base = {
    where,
    providerId,
    providerLabel: provider?.label ?? providerId,
    modelId,
    percent: null as number | null,
    baseUrl,
  };

  if (providerId === LOCAL_PROVIDER_ID) {
    if (llm.status && !llm.status.runtime_available)
      return { ...base, ready: false, problem: "runtime" };
    const chosen = llm.models.find((m) => m.id === modelId && m.downloaded);
    if (chosen) return { ...base, ready: true, problem: null };
    const downloading = llm.models.find((m) => m.downloading);
    if (downloading)
      return {
        ...base,
        modelId: downloading.id,
        ready: false,
        problem: "downloading",
        percent: llm.progress[downloading.id] ?? 0,
      };
    return { ...base, ready: false, problem: "noModel" };
  }
  if (providerId === APPLE_PROVIDER_ID)
    return { ...base, ready: true, problem: null };
  if (where === "server") {
    if (!baseUrl.trim()) return { ...base, ready: false, problem: "noUrl" };
    if (!modelId.trim())
      return { ...base, ready: false, problem: "noServerModel" };
    return { ...base, ready: true, problem: null };
  }
  const key = settings?.post_process_api_keys?.[providerId] ?? "";
  if (!key.trim()) return { ...base, ready: false, problem: "noKey" };
  if (!modelId.trim())
    return { ...base, ready: false, problem: "noServerModel" };
  return { ...base, ready: true, problem: null };
};
