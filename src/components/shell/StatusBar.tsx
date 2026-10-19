import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { ChevronDown, CircleAlert } from "lucide-react";
import { commands } from "@/bindings";
import { useModelStore } from "@/stores/modelStore";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { useLlmStore, MODEL_LOOK } from "@/stores/llmStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { getTranslatedModelName } from "@/lib/utils/modelTranslation";
import type { ModelStateEvent } from "@/lib/types/events";
import { Menu, type MenuItem } from "../ui/Menu";
import { Spinner } from "../ui/Spinner";
import { ReleaseNotice } from "./ReleaseNotice";

/**
 * Status bar (VISUAL_DESIGN_SYSTEM §12.13; UX_INTERACTION_ARCHITECTURE,
 * «Строка состояния»): the speech model and its state, the running task,
 * downloads, a new version when it is true, and the version. Every part is a
 * way to the object it describes. When nothing runs, the task part is absent.
 */

export type AsrStatus = "ready" | "loading" | "error" | "unloaded" | "none";

/**
 * State of the speech model, from the model-state events. With `autoSelect`
 * (the status bar, mounted once) it also selects a model as soon as its
 * download completes, as the old footer did.
 */
export const useAsrModelStatus = (autoSelect = true) => {
  const { currentModel, selectModel } = useModelStore();
  const [status, setStatus] = useState<AsrStatus>("unloaded");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const check = async () => {
      if (!currentModel) {
        setStatus("none");
        return;
      }
      try {
        const res = await commands.getTranscriptionModelStatus();
        if (res.status === "ok")
          setStatus(res.data === currentModel ? "ready" : "unloaded");
      } catch {
        setStatus("error");
        setError(null);
      }
    };
    void check();
  }, [currentModel]);

  useEffect(() => {
    const stateUnlisten = listen<ModelStateEvent>(
      "model-state-changed",
      (event) => {
        const { event_type, error: err } = event.payload;
        if (event_type === "loading_started") {
          setStatus("loading");
          setError(null);
        } else if (event_type === "loading_completed") {
          setStatus("ready");
          setError(null);
          setPending(null);
        } else if (event_type === "loading_failed") {
          setStatus("error");
          setError(err || null);
          setPending(null);
        } else if (event_type === "unloaded") {
          setStatus("unloaded");
          setError(null);
        }
      },
    );
    // Use a model as soon as its download completes (fires after extraction).
    const doneUnlisten = listen<string>("model-download-complete", (event) => {
      if (!autoSelect) return;
      const modelId = event.payload;
      window.setTimeout(async () => {
        try {
          const recording = await commands.isRecording();
          if (recording) return;
          setPending(modelId);
          const ok = await selectModel(modelId);
          if (!ok) setPending(null);
        } catch {
          // ignore errors of the automatic switch
        }
      }, 500);
    });
    return () => {
      stateUnlisten.then((fn) => fn());
      doneUnlisten.then((fn) => fn());
    };
  }, [selectModel, autoSelect]);

  return { status, error, displayModelId: pending || currentModel };
};

export const StatusBar: React.FC = () => {
  const { t } = useTranslation();
  const { models, currentModel, selectModel, downloadProgress } =
    useModelStore();
  const { status, displayModelId } = useAsrModelStatus();
  const running = useFileTranscriptionStore((s) => s.running);
  const items = useFileTranscriptionStore((s) => s.items);
  const runIds = useFileTranscriptionStore((s) => s.runIds);
  const progress = useFileTranscriptionStore((s) => s.progress);
  const llmModels = useLlmStore((s) => s.models);
  const llmProgress = useLlmStore((s) => s.progress);
  const link = useNavigationStore((s) => s.link);
  const [version, setVersion] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  const model = models.find((m) => m.id === displayModelId);
  const modelName = model ? getTranslatedModelName(model, t) : "";
  const downloaded = models.filter((m) => m.is_downloaded);

  const dot = (() => {
    if (status === "loading") return <Spinner size={12} />;
    if (status === "error")
      return (
        <CircleAlert
          width={14}
          height={14}
          className="t-icon-danger"
          aria-hidden="true"
        />
      );
    if (status === "ready")
      return <span className="t-dot" aria-hidden="true" />;
    return <span className="t-dot t-dot-empty" aria-hidden="true" />;
  })();

  const stateWord = {
    ready: t("statusBar.model.ready"),
    loading: t("statusBar.model.loading"),
    error: t("statusBar.model.error"),
    unloaded: t("statusBar.model.unloaded"),
    none: t("statusBar.model.none"),
  }[status];

  const menuItems: MenuItem[] = [
    ...(running
      ? [
          {
            value: "locked",
            label: t("statusBar.model.locked"),
            disabled: true,
          },
        ]
      : []),
    ...downloaded.map((m) => ({
      value: m.id,
      label: getTranslatedModelName(m, t),
      selected: m.id === currentModel,
      disabled: running,
      onSelect: () => void selectModel(m.id),
    })),
    {
      value: "__all",
      label: t("statusBar.model.all"),
      separatorBefore: true,
      onSelect: () => link("models", { target: "models-active" }),
    },
  ];

  // Running file: «Расшифровка: файл 1 из 2 · 47 %».
  const taskPart = (() => {
    if (!running) return null;
    const current = items.find((i) => i.status === "running");
    const index = current ? runIds.indexOf(current.id) + 1 : 0;
    const pct = Math.round((progress?.fraction ?? 0) * 100);
    return (
      <button
        type="button"
        className="t-status-part"
        onClick={() =>
          link("transcription", {
            target: current ? `file-${current.id}` : undefined,
          })
        }
      >
        <span className="t-status-text">
          {t("statusBar.task", {
            current: Math.max(index, 1),
            total: Math.max(runIds.length, 1),
            percent: pct,
          })}
        </span>
      </button>
    );
  })();

  const downloadParts: React.ReactNode[] = [];
  const asrDownloads = Object.values(downloadProgress);
  if (asrDownloads.length === 1) {
    const d = asrDownloads[0];
    const m = models.find((x) => x.id === d.model_id);
    downloadParts.push(
      <button
        key="asr"
        type="button"
        className="t-status-part"
        onClick={() => link("models", { target: `model-${d.model_id}` })}
      >
        <span className="t-status-text">
          {t("statusBar.downloading", {
            name: m ? getTranslatedModelName(m, t) : d.model_id,
            percent: Math.round(d.percentage),
          })}
        </span>
      </button>,
    );
  } else if (asrDownloads.length > 1) {
    const avg =
      asrDownloads.reduce((sum, d) => sum + d.percentage, 0) /
      asrDownloads.length;
    downloadParts.push(
      <button
        key="asr"
        type="button"
        className="t-status-part"
        onClick={() => link("models", { target: "models-catalog" })}
      >
        <span className="t-status-text">
          {t("statusBar.downloadingMany", {
            count: asrDownloads.length,
            percent: Math.round(avg),
          })}
        </span>
      </button>,
    );
  }
  const llmDownloading = llmModels.find((m) => m.downloading);
  if (llmDownloading) {
    const look = MODEL_LOOK[llmDownloading.id];
    downloadParts.push(
      <button
        key="llm"
        type="button"
        className="t-status-part"
        onClick={() => link("llm", { target: "llm-variant" })}
      >
        <span className="t-status-text">
          {t("statusBar.downloading", {
            name: look
              ? t(`settings.postProcessing.local.models.${look.key}.model`)
              : llmDownloading.id,
            percent: Math.round(llmProgress[llmDownloading.id] ?? 0),
          })}
        </span>
      </button>,
    );
  }

  return (
    <footer className="t-status" aria-live="polite">
      <button
        ref={chipRef}
        type="button"
        className="t-status-part"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={
          modelName
            ? t("statusBar.model.a11y", { model: modelName, state: stateWord })
            : stateWord
        }
        onClick={() => setMenuOpen((o) => !o)}
      >
        {dot}
        <span className="t-status-text">{modelName || stateWord}</span>
        <ChevronDown width={14} height={14} aria-hidden="true" />
      </button>
      <Menu
        anchor={chipRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={menuItems}
        checkable
        placement="above"
        ariaLabel={t("statusBar.model.menu")}
      />
      {taskPart}
      {downloadParts}
      <span className="t-status-end flex items-center gap-4">
        <ReleaseNotice />
        {/* eslint-disable-next-line i18next/no-literal-string */}
        {version && <span>v{version}</span>}
      </span>
    </footer>
  );
};
