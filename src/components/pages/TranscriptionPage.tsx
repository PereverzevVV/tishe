import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, CircleAlert, Lock, Upload } from "lucide-react";
import {
  commands,
  type EventLabels,
  type FileTranscriptionRequest,
  type WarningLabels,
} from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import {
  LOCAL_PROVIDER_ID,
  llmReadiness,
  useLlmStore,
} from "@/stores/llmStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import {
  useFileTranscriptionStore,
  type FileTranscriptionProgress,
} from "@/stores/fileTranscriptionStore";
import {
  CLOUD_PRESETS,
  cloudConfig,
  useFileOptionsStore,
} from "@/stores/fileOptionsStore";
import { useModelStore } from "@/stores/modelStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { useDropStore } from "@/stores/dropStore";
import { MEDIA_EXTENSIONS } from "@/lib/media";
import { formatBytes, formatClock } from "@/lib/utils/humanize";
import { Page } from "../shell/Page";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { Input } from "../ui/Input";
import { SettingsGroup } from "../ui/SettingsGroup";
import { SettingContainer } from "../ui/SettingContainer";
import { Segments } from "../ui/Segments";
import { ServiceLine } from "../ui/ServiceLine";
import { TextLink } from "../ui/TextLink";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { FileList } from "./transcription/FileList";
import { FOLD_ID, MoreOptions } from "./transcription/MoreOptions";
import {
  RECOMMENDED_SPEAKER_MODEL,
  useDiarization,
} from "./transcription/useDiarization";
import {
  AsrEchoLine,
  LlmReadinessLine,
  useLlmModelLabel,
  llmNextStep,
  useRecommendedLlm,
} from "./shared";
import { QuickStart } from "../setup/QuickStart";
import { AsrSetupCard } from "../setup/AsrSetupCard";
import { useLlmGate } from "../setup/LlmSetupDialog";

/**
 * «Расшифровка» — the workspace (UX_INTERACTION_ARCHITECTURE S1, template
 * «Рабочее место»): the file zone, one list of queue and results, the recipe,
 * «Дополнительно», and the launch panel pinned at the bottom with the only
 * primary button of the window.
 */

const EXTENSION = { markdown: "md", docx: "docx" } as const;

const splitPath = (path: string) => {
  const sep = path.includes("\\") ? "\\" : "/";
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dir = idx >= 0 ? path.slice(0, idx) : "";
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  const dot = name.lastIndexOf(".");
  return { dir, stem: dot > 0 ? name.slice(0, dot) : name, sep };
};

export const TranscriptionPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { options, update, loaded } = useFileOptionsStore();
  const queue = useFileTranscriptionStore();
  const { items, running, startedAt, progress } = queue;
  const { models, currentModel, downloadProgress } = useModelStore();
  const quickStart = useOnboardingStore((s) => s.quickStart);
  const llm = useLlmStore();
  const llmGate = useLlmGate();
  const recommendedLlm = useRecommendedLlm();
  const link = useNavigationStore((s) => s.link);
  const setUnseen = useNavigationStore((s) => s.setUnseenResults);
  const rejected = useDropStore((s) => s.rejected);
  const checkResults = useFileTranscriptionStore((s) => s.checkResults);
  const { settings } = useSettings();
  // The built-in LLM's name for the document header (the backend uses it
  // only when that LLM edits the text).
  const localLlmName = useLlmModelLabel(
    settings?.post_process_models?.[LOCAL_PROVIDER_ID] ?? "",
    LOCAL_PROVIDER_ID,
  );

  // Documents kept from earlier runs may have been moved: check on opening.
  useEffect(() => {
    void checkResults();
  }, [checkResults]);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [confirmStop, setConfirmStop] = useState(false);
  const [doneFlash, setDoneFlash] = useState<number | null>(null);
  const wasRunning = useRef(running);

  const diar = useDiarization(options.diarization.modelId, (id) =>
    update({ diarization: { ...options.diarization, modelId: id } }),
  );

  useEffect(() => {
    void commands.isFfmpegAvailable().then(setFfmpegAvailable);
  }, []);

  // Seeing the page clears «готово, не просмотрено»; so does showing the
  // window while the page is open.
  useEffect(() => {
    setUnseen(false);
    const onVisible = () => {
      if (!document.hidden) setUnseen(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [setUnseen]);

  useEffect(() => {
    if (!running) return;
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  // «Готово: 3 файла» in the panel for 6 s after the queue finishes.
  useEffect(() => {
    const finished = wasRunning.current && !running;
    wasRunning.current = running;
    if (!finished) return;
    const state = useFileTranscriptionStore.getState();
    const done = state.items.filter(
      (i) => state.runIds.includes(i.id) && i.status === "done",
    ).length;
    if (done === 0) return;
    setDoneFlash(done);
    const timer = window.setTimeout(() => setDoneFlash(null), 6000);
    return () => window.clearTimeout(timer);
  }, [running]);

  const downloadedModels = useMemo(
    () => models.filter((m) => m.is_downloaded),
    [models],
  );
  const cloud = cloudConfig(options);
  const isCloud = options.engine === "cloud";
  const providerLabel = t(
    `fileTranscription.cloud.providers.${options.cloudProvider}`,
  );

  const cloudConfigMissing =
    isCloud &&
    (!cloud.baseUrl.trim() || !cloud.model.trim() || !cloud.key.trim());
  const activeModel = downloadedModels.find((m) => m.id === currentModel);
  // A model on disk that is not active does not transcribe either: the
  // backend rejects every file ("no local model is selected").
  const localModelMissing = !isCloud && !activeModel;
  const modelOnDisk = downloadedModels.length > 0;
  // A speech model downloading for setup: its percent in the panel.
  const asrDownload = Object.values(downloadProgress)[0];
  // Editing asked for, but the LLM is not ready: the start waits for it
  // instead of failing on every file.
  const llmState = llmReadiness(settings, llm);
  const llmNext = llmNextStep(settings, llm);
  const llmMissing = options.llmEnabled && !llmState.ready;
  const llmDownloading = llm.models.find((m) => m.downloading);
  // Cloud models without timestamps can't be matched to speakers (whisper
  // ones return verbose_json with segment times).
  const untimedCloudModel =
    isCloud && !cloud.model.toLowerCase().includes("whisper")
      ? cloud.model
      : null;
  const diarize = options.diarization.enabled;
  const diarizationMissing = diarize && !diar.ready;
  const runnable = items.filter((i) => i.status !== "done");
  const canStart =
    !running &&
    ffmpegAvailable &&
    runnable.length > 0 &&
    !cloudConfigMissing &&
    !localModelMissing &&
    !diarizationMissing &&
    !llmMissing;

  const stageText = (p: FileTranscriptionProgress | null) => {
    if (!p) return t("fileTranscription.progress.starting");
    const key = `fileTranscription.progress.${p.stage}`;
    return p.total_parts > 1 && p.part > 0
      ? t(`${key}Part`, { part: p.part, total: p.total_parts })
      : t(key);
  };

  // Remaining time, only once the estimate means something (≥ 5 %, ≥ 30 s).
  const fraction = progress?.fraction ?? 0;
  const remaining =
    running && fraction >= 0.05 && elapsed >= 30
      ? (elapsed * (1 - fraction)) / fraction
      : null;

  const pickInput = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: t("fileTranscription.input.filterName"),
          extensions: MEDIA_EXTENSIONS,
        },
      ],
    });
    if (!selected) return;
    queue.addFiles(Array.isArray(selected) ? selected : [selected]);
  };

  // Message templates for the event script, in the app language. The backend
  // fills in {part}, {total} and {minutes}.
  const eventLabels = (): EventLabels => {
    const stage = (key: string) =>
      t(`fileTranscription.progress.${key}`, {
        part: "{part}",
        total: "{total}",
      });
    return {
      extracting: stage("extracting"),
      diarizing: stage("diarizing"),
      splitting: stage("splitting"),
      transcribing: stage("transcribing"),
      transcribing_part: stage("transcribingPart"),
      post_processing: stage("post_processing"),
      post_processing_part: stage("post_processingPart"),
      writing: stage("writing"),
      remaining: t("fileTranscription.events.remaining", {
        minutes: "{minutes}",
      }),
      started: t("fileTranscription.events.started"),
      finished: t("fileTranscription.events.finished"),
      cancelled: t("fileTranscription.events.cancelled"),
    };
  };

  // Warning texts in the app language for the document and the file list.
  // The backend fills in {part}, {fragment}, {count}, {kept}, {total},
  // {reasons} and {error}.
  const warningLabels = (): WarningLabels => {
    const text = (key: string) =>
      t(`fileTranscription.document.warnings.${key}`, {
        part: "{part}",
        fragment: "{fragment}",
        lines: "{count}",
        kept: "{kept}",
        total: "{total}",
        reasons: "{reasons}",
        error: "{error}",
      });
    return {
      no_timestamps_model: text("noTimestampsModel"),
      no_timestamps_part: text("noTimestampsPart"),
      llm_empty: text("llmEmpty"),
      llm_error: text("llmError"),
      numbers_back: text("numbersBack"),
      lines_lost: text("linesLost"),
      lines_kept: text("linesKept"),
      kept_missing: text("kept.missing"),
      kept_duplicate: text("kept.duplicate"),
      kept_empty: text("kept.empty"),
      kept_too_long: text("kept.tooLong"),
      kept_translated: text("kept.translated"),
      kept_too_short: text("kept.tooShort"),
      kept_cut_off: text("kept.cutOff"),
    };
  };

  // Output path for one file: chosen folder (or the source's folder) plus the
  // source name; the backend adds " (2)" etc. instead of overwriting.
  const outputPathFor = (inputPath: string) => {
    const { dir, stem, sep } = splitPath(inputPath);
    const outDir = options.lastOutputDir ?? dir;
    const outSep = outDir.includes("\\")
      ? "\\"
      : outDir.includes("/")
        ? "/"
        : sep;
    return commands.uniqueOutputPath(
      `${outDir}${outDir ? outSep : ""}${stem}.${EXTENSION[options.format]}`,
    );
  };

  const start = () => {
    void queue.startQueue(
      async (inputPath): Promise<FileTranscriptionRequest> => ({
        input_path: inputPath,
        output_path: await outputPathFor(inputPath),
        format: options.format,
        max_part_minutes: options.maxPartMinutes,
        engine: options.engine,
        cloud: isCloud
          ? {
              base_url: cloud.baseUrl,
              api_key: cloud.key,
              model: cloud.model,
              language: options.cloudLanguage.trim() || null,
              prompt: null,
            }
          : null,
        llm_enabled: options.llmEnabled,
        // null: the built-in instruction, written in the language of the text.
        llm_prompt: options.llmPrompt?.trim() ? options.llmPrompt : null,
        remove_fillers: options.removeFillers,
        include_raw: options.includeRaw,
        timestamps: options.timestamps,
        include_notes: options.includeNotes,
        save_debug: options.saveDebug,
        labels: {
          title: t("fileTranscription.document.title"),
          source_file: t("fileTranscription.document.sourceFile"),
          duration: t("fileTranscription.document.duration"),
          parts: t("fileTranscription.document.parts"),
          engine: t("fileTranscription.document.engine"),
          llm: t("fileTranscription.document.llm"),
          created: t("fileTranscription.document.created"),
          part: t("fileTranscription.document.part"),
          raw_transcript: t("fileTranscription.document.rawTranscript"),
          speaker: t("fileTranscription.document.speaker"),
          notes: t("fileTranscription.document.notes"),
          notes_total: t("fileTranscription.document.notesTotal"),
          notes_extracting: t("fileTranscription.document.notesExtracting"),
          notes_diarizing: t("fileTranscription.document.notesDiarizing"),
          notes_transcribing: t("fileTranscription.document.notesTranscribing"),
          notes_llm: t("fileTranscription.document.notesLlm"),
          notes_warnings: t("fileTranscription.document.notesWarnings"),
          notes_none: t("fileTranscription.document.notesNone"),
          notes_language: t("fileTranscription.document.notesLanguage"),
          llm_local: localLlmName
            ? t("fileTranscription.document.llmLocal", {
                model: localLlmName,
              })
            : "",
          warnings: warningLabels(),
        },
        diarization:
          diarize && diar.ready
            ? {
                model_id: diar.ready,
                num_speakers: options.diarization.numSpeakers || null,
              }
            : null,
        events: options.eventScript
          ? {
              script: options.eventScript,
              progress_interval_secs: options.eventIntervalSecs,
              labels: eventLabels(),
            }
          : null,
      }),
      { speakers: diarize, editing: options.llmEnabled, cloud: isCloud },
    );
  };

  if (!loaded) return null;

  // ---------- file zone (§12.25) ----------
  // Recordings can be added before the model is ready; the setup card above
  // says what is missing and the panel holds the start.
  const dropZone =
    items.length === 0 ? (
      <div className="t-drop t-drop-empty">
        <Upload aria-hidden="true" />
        <div className="t-drop-empty-title">
          {t("transcription.drop.title")}
        </div>
        <div className="t-drop-empty-text">{t("transcription.drop.text")}</div>
        <Button variant="secondary" onClick={() => void pickInput()}>
          {t("fileTranscription.input.choose")}
        </Button>
      </div>
    ) : (
      <div className="t-drop t-drop-row">
        <span>{t("transcription.drop.more")}</span>
        <Button variant="quiet" size="sm" onClick={() => void pickInput()}>
          {t("fileTranscription.input.choose")}
        </Button>
      </div>
    );

  // ---------- recipe ----------
  const speakerModel = diar.models.find(
    (m) => m.id === RECOMMENDED_SPEAKER_MODEL,
  );
  const speakerDownloading = diar.models.find((m) => m.downloading);
  const speakersLine = (() => {
    if (!diarize) return null;
    if (speakerDownloading)
      return (
        <ServiceLine
          kind="busy"
          action={
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void diar.cancel(speakerDownloading.id)}
            >
              {t("ui.cancelDownload")}
            </Button>
          }
        >
          {t("transcription.recipe.speakersDownloading", {
            percent: Math.round(diar.progress[speakerDownloading.id] ?? 0),
          })}
        </ServiceLine>
      );
    if (!diar.ready)
      return (
        <ServiceLine
          kind="missing"
          action={
            speakerModel && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void diar.download(RECOMMENDED_SPEAKER_MODEL)}
              >
                {t("ui.download")}
              </Button>
            )
          }
        >
          {t("transcription.recipe.speakersMissing", {
            size: speakerModel
              ? formatBytes(speakerModel.size_bytes, t, i18n.language)
              : "",
          })}
        </ServiceLine>
      );
    return (
      <ServiceLine kind="ready">
        {t("transcription.recipe.speakersReady")}
      </ServiceLine>
    );
  })();

  const formatLabel = t(`transcription.recipe.format.${options.format}`);
  const placeLabel = options.lastOutputDir
    ? options.lastOutputDir
    : t("transcription.recipe.nextToSource");

  const recipe = (
    <SettingsGroup
      title={t("transcription.recipe.title")}
      anchor="transcription-recipe"
    >
      {running && (
        <div className="t-lock">
          <Lock aria-hidden="true" />
          {t("transcription.recipe.locked")}
        </div>
      )}
      <SettingContainer
        title={t("transcription.recipe.where")}
        layout="stacked"
        extra={
          isCloud ? (
            <ServiceLine kind="cloud">
              {t("transcription.recipe.audioToService", {
                provider: providerLabel,
              })}
            </ServiceLine>
          ) : undefined
        }
      >
        <Segments
          wide
          ariaLabel={t("transcription.recipe.where")}
          value={options.engine}
          disabled={running}
          onChange={(engine) =>
            update({ engine: engine as typeof options.engine })
          }
          options={[
            { value: "local", label: t("transcription.recipe.local") },
            { value: "cloud", label: t("transcription.recipe.cloud") },
          ]}
        />
      </SettingContainer>
      {isCloud && (
        <>
          <SettingContainer
            dependent
            title={t("fileTranscription.cloud.provider")}
          >
            <Dropdown
              options={Object.keys(CLOUD_PRESETS).map((id) => ({
                value: id,
                label: t(`fileTranscription.cloud.providers.${id}`),
              }))}
              selectedValue={options.cloudProvider}
              onSelect={(value) => update({ cloudProvider: value })}
              disabled={running}
            />
          </SettingContainer>
          <SettingContainer
            dependent
            title={t("fileTranscription.cloud.apiKey")}
            description={t("fileTranscription.cloud.apiKeyDescription")}
            anchor="transcription-cloud-key"
          >
            <Input
              type="password"
              className="w-48"
              value={cloud.key}
              placeholder="sk-..."
              aria-label={t("fileTranscription.cloud.apiKey")}
              onChange={(e) =>
                update({
                  cloudKeys: {
                    ...options.cloudKeys,
                    [options.cloudProvider]: e.target.value,
                  },
                })
              }
              disabled={running}
            />
          </SettingContainer>
        </>
      )}
      <ToggleSwitch
        checked={diarize}
        onChange={(enabled) =>
          update({ diarization: { ...options.diarization, enabled } })
        }
        disabled={running}
        label={t("transcription.recipe.speakers")}
        description={t("transcription.recipe.speakersDescription")}
        extra={
          <>
            {speakersLine}
            {diarize && untimedCloudModel && (
              <ServiceLine kind="caveat">
                {t("fileTranscription.diarization.cloudUntimed", {
                  model: untimedCloudModel,
                })}
              </ServiceLine>
            )}
          </>
        }
      />
      {diarize && (
        <SettingContainer
          dependent
          title={t("fileTranscription.diarization.count")}
          description={t("transcription.recipe.countDescription")}
        >
          <Dropdown
            options={[
              { value: "0", label: t("fileTranscription.diarization.auto") },
              ...[2, 3, 4, 5, 6, 7, 8].map((n) => ({
                value: String(n),
                label: String(n),
              })),
            ]}
            selectedValue={String(options.diarization.numSpeakers)}
            onSelect={(v) =>
              update({
                diarization: {
                  ...options.diarization,
                  numSpeakers: parseInt(v, 10) || 0,
                },
              })
            }
            disabled={running}
          />
        </SettingContainer>
      )}
      <ToggleSwitch
        checked={options.llmEnabled}
        onChange={(llmEnabled) =>
          llmEnabled
            ? llmGate.request(() => update({ llmEnabled: true }))
            : update({ llmEnabled: false })
        }
        disabled={running}
        label={t("transcription.recipe.editing")}
        description={t("transcription.recipe.editingDescription")}
        extra={options.llmEnabled ? <LlmReadinessLine /> : undefined}
      />
      <SettingContainer
        title={t("transcription.recipe.result")}
        extra={
          <ServiceLine
            action={
              <TextLink
                onClick={() =>
                  link("transcription", {
                    target: "transcription-document",
                    fold: FOLD_ID,
                  })
                }
              >
                {t("ui.change")}
              </TextLink>
            }
          >
            {formatLabel} · {placeLabel}
          </ServiceLine>
        }
      />
      <div className="t-block">
        {isCloud ? (
          <ServiceLine
            action={
              <TextLink
                onClick={() =>
                  link("transcription", {
                    target: "transcription-recognition",
                    fold: FOLD_ID,
                  })
                }
              >
                {t("ui.change")}
              </TextLink>
            }
          >
            {t("transcription.recipe.cloudEcho", {
              model: cloud.model || "—",
              provider: providerLabel,
            })}
          </ServiceLine>
        ) : (
          <AsrEchoLine sharedWith="dictation" />
        )}
      </div>
    </SettingsGroup>
  );

  // ---------- panel ----------
  const fileCount = runnable.length;
  const startLabel =
    fileCount > 0
      ? t("transcription.panel.start", { count: fileCount })
      : t("fileTranscription.actions.start");
  const errorCount = items.filter((i) => i.status === "error").length;

  const panelLeft = (() => {
    if (running) {
      const current = items.find((i) => i.status === "running");
      const index = current ? queue.runIds.indexOf(current.id) + 1 : 1;
      return (
        <span className="t-panel-text">
          {t("transcription.panel.running", {
            current: index,
            total: Math.max(queue.runIds.length, 1),
            time: formatClock(elapsed),
          })}
        </span>
      );
    }
    if (doneFlash)
      return (
        <span className="t-panel-text">
          <Check
            width={14}
            height={14}
            className="t-icon-secondary"
            aria-hidden="true"
          />
          {t("transcription.panel.done", { count: doneFlash })}
        </span>
      );
    // First reason in pipeline order, with the action that removes it.
    if (!ffmpegAvailable)
      return (
        <span className="t-panel-text">
          <CircleAlert
            width={14}
            height={14}
            className="t-icon-danger"
            aria-hidden="true"
          />
          {t("transcription.panel.noFfmpeg")}
        </span>
      );
    if (fileCount === 0)
      return (
        <span className="t-panel-text">
          {t("transcription.panel.addFiles")}
        </span>
      );
    if (localModelMissing)
      return (
        <span className="t-panel-text">
          {asrDownload
            ? t("transcription.panel.modelDownloading", {
                percent: Math.round(asrDownload.percentage),
              })
            : modelOnDisk
              ? t("transcription.panel.modelNotActive")
              : t("transcription.panel.noModel")}
          {!asrDownload && (
            <TextLink
              onClick={() =>
                link("transcription", {
                  target: quickStart ? "quick-start" : "setup-asr",
                })
              }
            >
              {modelOnDisk ? t("ui.open") : t("ui.download")}
            </TextLink>
          )}
        </span>
      );
    if (cloudConfigMissing)
      return (
        <span className="t-panel-text">
          {options.cloudProvider === "custom"
            ? t("transcription.panel.cloudIncompleteCustom")
            : t("transcription.panel.cloudIncomplete", {
                provider: providerLabel,
              })}
          <TextLink
            onClick={() =>
              options.cloudProvider === "custom"
                ? link("transcription", {
                    target: "transcription-recognition",
                    fold: FOLD_ID,
                  })
                : link("transcription", { target: "transcription-recipe" })
            }
          >
            {t("ui.change")}
          </TextLink>
        </span>
      );
    if (diarizationMissing)
      return (
        <span className="t-panel-text">
          {t("transcription.panel.noSpeakerModel")}
          {!speakerDownloading && speakerModel && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void diar.download(RECOMMENDED_SPEAKER_MODEL)}
            >
              {t("ui.download")}
            </Button>
          )}
        </span>
      );
    if (llmMissing)
      return (
        <span className="t-panel-text">
          {llmNext.step === "downloading"
            ? t("transcription.panel.llmDownloading", {
                percent: Math.round(
                  llmDownloading
                    ? (llm.progress[llmDownloading.id] ?? 0)
                    : (llmState.percent ?? 0),
                ),
              })
            : llmNext.step === "download" || llmNext.step === "useLocal"
              ? t("transcription.panel.llmMissing")
              : t("transcription.panel.llmNotSetUp")}
          {llmNext.step === "download" && recommendedLlm.available && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void recommendedLlm.download()}
            >
              {t("ui.downloadSize", { size: recommendedLlm.size })}
            </Button>
          )}
          {llmNext.step === "useLocal" && llmNext.onDisk && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void recommendedLlm.useLocal(llmNext.onDisk ?? "")}
            >
              {t("setup.llm.turnOn")}
            </Button>
          )}
          {(llmNext.step === "setup" || llmNext.step === "runtime") && (
            <TextLink onClick={() => link("llm", { target: "llm-where" })}>
              {t("ui.change")}
            </TextLink>
          )}
          <TextLink onClick={() => update({ llmEnabled: false })}>
            {t("transcription.panel.withoutEditing")}
          </TextLink>
        </span>
      );
    if (isCloud)
      return (
        <ServiceLine kind="cloud" className="mt-0">
          {t("transcription.recipe.audioToService", {
            provider: providerLabel,
          })}
        </ServiceLine>
      );
    if (errorCount > 0)
      return (
        <span className="t-panel-text">
          {t("transcription.panel.errors", { count: errorCount })}
        </span>
      );
    return (
      <span className="t-panel-text">
        {t("transcription.panel.summary", { count: fileCount })}
      </span>
    );
  })();

  const current = items.find((i) => i.status === "running");
  const doneInRun = items.filter(
    (i) => queue.runIds.includes(i.id) && i.status === "done",
  ).length;
  const waitingInRun = items.filter(
    (i) => queue.runIds.includes(i.id) && i.status === "pending",
  ).length;

  const panel = (
    <>
      {panelLeft}
      {running ? (
        <Button variant="secondary" onClick={() => setConfirmStop(true)}>
          {t("fileTranscription.actions.cancel")}
        </Button>
      ) : (
        <Button variant="primary" onClick={start} disabled={!canStart}>
          {startLabel}
        </Button>
      )}
    </>
  );

  return (
    <Page
      section="transcription"
      title={t("sidebar.transcription")}
      panel={panel}
    >
      {/* Wide window: files on the left, recipe and options on the right
          (VD-86); otherwise the wrappers vanish and it is one column. */}
      <div className="t-work t-wide">
        <div className="t-work-main">
          {!ffmpegAvailable && (
            <Alert variant="error" title={t("transcription.ffmpeg.title")}>
              {t("fileTranscription.ffmpegMissing")}
            </Alert>
          )}
          {quickStart ? (
            <QuickStart onAddFiles={() => void pickInput()} />
          ) : (
            !isCloud && !activeModel && <AsrSetupCard />
          )}
          {dropZone}
          {rejected.length > 0 && (
            <ServiceLine kind="error" className="-mt-4 mb-6">
              {t("transcription.drop.rejected", {
                names: rejected.join(", "),
              })}
            </ServiceLine>
          )}
          <FileList stageText={stageText} remaining={remaining} />
        </div>
        <div className="t-work-side">
          {recipe}
          <MoreOptions running={running} diar={diar} />
        </div>
      </div>
      {llmGate.dialog}
      <ConfirmDialog
        open={confirmStop}
        title={t("transcription.stop.title")}
        confirmLabel={t("transcription.stop.confirm")}
        cancelLabel={t("transcription.stop.keep")}
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          void queue.cancel();
        }}
      >
        {t("transcription.stop.body", {
          done: doneInRun,
          percent: Math.round(fraction * 100),
          waiting: waitingInRun,
          name: current ? current.inputPath.split(/[\\/]/).pop() : "",
        })}
      </ConfirmDialog>
    </Page>
  );
};
