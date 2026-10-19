import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { OutputFormat, SttEngine } from "@/bindings";

/**
 * Options of file transcription («Расшифровка»), saved in
 * file_transcription.json as before. They live in a store, not in the page,
 * because two pages edit them: the recipe and «Дополнительно» on
 * «Расшифровка», and «Сохранять промежуточные файлы» on «Отладка».
 */

export interface CloudPreset {
  baseUrl: string;
  models: string[];
}

export const CLOUD_PRESETS: Record<string, CloudPreset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["whisper-large-v3", "whisper-large-v3-turbo"],
  },
  custom: { baseUrl: "", models: [] },
};

export interface DiarizationOptions {
  enabled: boolean;
  /** 0 = detect automatically. */
  numSpeakers: number;
  modelId: string | null;
}

export interface FileOptions {
  engine: SttEngine;
  format: OutputFormat;
  maxPartMinutes: number;
  cloudProvider: string;
  cloudBaseUrl: string;
  cloudKeys: Record<string, string>;
  cloudModels: Record<string, string>;
  cloudLanguage: string;
  llmEnabled: boolean;
  llmPrompt: string | null;
  includeRaw: boolean;
  timestamps: boolean;
  /** Close each document with stage times and warnings. */
  includeNotes: boolean;
  /** Drop hesitation sounds ("э-э", "uh") from the main text. */
  removeFillers: boolean;
  /** Keep the text after every step in a "<document>.debug" folder. */
  saveDebug: boolean;
  /** Folder for the documents; null saves each next to its source file. */
  lastOutputDir: string | null;
  /** Program told about each job's progress; null sends nothing. */
  eventScript: string | null;
  /** Minimum seconds between progress events sent to the script. */
  eventIntervalSecs: number;
  diarization: DiarizationOptions;
}

export const DEFAULT_FILE_OPTIONS: FileOptions = {
  engine: "local",
  format: "docx",
  maxPartMinutes: 29,
  cloudProvider: "openai",
  cloudBaseUrl: "",
  cloudKeys: {},
  cloudModels: {},
  cloudLanguage: "",
  llmEnabled: false,
  llmPrompt: null,
  includeRaw: false,
  timestamps: true,
  includeNotes: true,
  removeFillers: true,
  saveDebug: false,
  lastOutputDir: null,
  eventScript: null,
  eventIntervalSecs: 10,
  diarization: { enabled: false, numSpeakers: 0, modelId: null },
};

/** The effective cloud endpoint, model and key for the chosen provider. */
export const cloudConfig = (o: FileOptions) => {
  const preset = CLOUD_PRESETS[o.cloudProvider] ?? CLOUD_PRESETS.custom;
  const baseUrl =
    o.cloudProvider === "custom" ? o.cloudBaseUrl : preset.baseUrl;
  const model = o.cloudModels[o.cloudProvider] ?? preset.models[0] ?? "";
  const key = o.cloudKeys[o.cloudProvider] ?? "";
  return { preset, baseUrl, model, key };
};

const disk = new LazyStore("file_transcription.json");
const STORE_KEY = "options";

interface FileOptionsStore {
  options: FileOptions;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<FileOptions>) => void;
}

export const useFileOptionsStore = create<FileOptionsStore>()((set, get) => ({
  options: DEFAULT_FILE_OPTIONS,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const saved = await disk.get<Partial<FileOptions>>(STORE_KEY);
      if (saved) {
        set({
          options: {
            ...DEFAULT_FILE_OPTIONS,
            ...saved,
            diarization: {
              ...DEFAULT_FILE_OPTIONS.diarization,
              ...saved.diarization,
            },
          },
        });
      }
    } catch (e) {
      console.warn("Failed to load file transcription options", e);
    } finally {
      set({ loaded: true });
    }
  },

  update: (patch) => {
    const next = { ...get().options, ...patch };
    set({ options: next });
    disk
      .set(STORE_KEY, next)
      .then(() => disk.save())
      .catch((e) =>
        console.warn("Failed to save file transcription options", e),
      );
  },
}));

/** How many «Дополнительно» options differ from their defaults. */
export const changedAdvancedCount = (o: FileOptions): number => {
  const d = DEFAULT_FILE_OPTIONS;
  let n = 0;
  if (o.maxPartMinutes !== d.maxPartMinutes) n++;
  if ((o.llmPrompt ?? "").trim() !== "") n++;
  if (o.includeRaw !== d.includeRaw) n++;
  if (o.format !== d.format) n++;
  if (o.lastOutputDir !== d.lastOutputDir) n++;
  if (o.timestamps !== d.timestamps) n++;
  if (o.removeFillers !== d.removeFillers) n++;
  if (o.includeNotes !== d.includeNotes) n++;
  if (o.eventScript !== d.eventScript) n++;
  return n;
};
