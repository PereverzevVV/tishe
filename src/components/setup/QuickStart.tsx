import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { commands, events } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { getTranslatedModelName } from "@/lib/utils/modelTranslation";
import { useModelStore } from "@/stores/modelStore";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import {
  LOCAL_PROVIDER_ID,
  llmReadiness,
  useLlmStore,
} from "@/stores/llmStore";
import { Button } from "../ui/Button";
import { Keycaps } from "../ui/Keycap";
import { ProgressLine } from "../ui/ProgressLine";
import { TextLink } from "../ui/TextLink";
import {
  llmNextStep,
  useLlmModelLabel,
  useRecommendedLlm,
} from "../pages/shared";
import { AsrSetupCard } from "./AsrSetupCard";

/**
 * «Быстрый старт» — the checklist on «Расшифровка» after the first-run
 * screen, the way apps greet a new person in the middle of their main
 * screen. Three steps make Tishe work (a speech model, one dictation, one
 * recording), the fourth is optional (editing). Each step shows how to do it
 * and the button that does it; a step ticks itself when it really happened,
 * not when a button is pressed. «Скрыть» closes it for good.
 */

type StepState = "done" | "current" | "next";

const Step: React.FC<{
  n: number;
  state: StepState;
  title: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ n, state, title, hint, children }) => (
  <li className="t-quick-step" data-state={state}>
    <span className="t-quick-mark" aria-hidden="true">
      {state === "done" ? <Check /> : n}
    </span>
    <div className="t-quick-body">
      <div className="t-quick-title">{title}</div>
      {hint && <div className="t-quick-hint">{hint}</div>}
      {state === "current" && children}
    </div>
  </li>
);

export const QuickStart: React.FC<{ onAddFiles: () => void }> = ({
  onAddFiles,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const osType = useOsType();
  const { models, currentModel } = useModelStore();
  const items = useFileTranscriptionStore((s) => s.items);
  const llm = useLlmStore();
  const link = useNavigationStore((s) => s.link);
  const dictated = useOnboardingStore((s) => s.dictated);
  const markDictated = useOnboardingStore((s) => s.markDictated);
  const close = useOnboardingStore((s) => s.closeQuickStart);
  const recommended = useRecommendedLlm();

  const active = models.find((m) => m.id === currentModel && m.is_downloaded);
  const filesDone = items.some((i) => i.status === "done");
  const llmState = llmReadiness(settings, llm);
  const llmLabel = useLlmModelLabel(llmState.modelId, llmState.providerId);
  const llmNext = llmNextStep(settings, llm);
  const llmDownloading = llm.models.find((m) => m.downloading);
  const downloadingLabel = useLlmModelLabel(
    llmDownloading?.id ?? "",
    LOCAL_PROVIDER_ID,
  );
  const onDiskLabel = useLlmModelLabel(llmNext.onDisk ?? "", LOCAL_PROVIDER_ID);
  const required = [Boolean(active), dictated, filesDone];
  const doneCount = required.filter(Boolean).length;
  const allDone = doneCount === required.length;

  // A dictation counts once it lands in «История»: already there, or new.
  useEffect(() => {
    if (dictated) return;
    void commands
      .getHistoryEntries(null, 1)
      .then((res) => {
        if (res.status === "ok" && res.data.entries.length > 0) markDictated();
      })
      .catch(() => {});
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const p = event.payload;
      if (p.action === "added" && p.entry.transcription_text.trim() !== "")
        markDictated();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [dictated, markDictated]);

  const key = settings?.bindings?.transcribe?.current_binding ?? "";
  const current = required.findIndex((done) => !done);
  const stateOf = (i: number): StepState =>
    required[i] ? "done" : i === current ? "current" : "next";

  if (allDone) {
    return (
      <section
        className="t-quick"
        aria-labelledby="quick-start-title"
        data-anchor="quick-start"
      >
        <div className="t-quick-head">
          <h2 id="quick-start-title" className="t-type-headline">
            {t("setup.quick.doneTitle")}
          </h2>
        </div>
        <p className="t-text-secondary">{t("setup.quick.doneText")}</p>
        <div>
          <Button variant="secondary" size="sm" onClick={close}>
            {t("setup.quick.close")}
          </Button>
        </div>
      </section>
    );
  }

  const llmStep = (() => {
    if (llmState.ready)
      return (
        <div className="t-quick-hint">
          {t("setup.quick.llmReady", {
            model: llmLabel || llmState.providerLabel,
          })}
        </div>
      );
    if (llmNext.step === "downloading") {
      const percent = llmDownloading
        ? (llm.progress[llmDownloading.id] ?? 0)
        : (llmState.percent ?? 0);
      return (
        <div className="flex flex-col gap-1">
          <ProgressLine value={percent} label={downloadingLabel} />
          <span className="t-type-caption t-text-secondary">
            {t("ui.llm.downloading", { percent: Math.round(percent) })}
          </span>
        </div>
      );
    }
    return (
      <div className="t-setup-actions">
        {llmNext.step === "download" && recommended.available && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void recommended.download()}
          >
            {t("ui.downloadSize", { size: recommended.size })}
          </Button>
        )}
        {llmNext.step === "useLocal" && llmNext.onDisk && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void recommended.useLocal(llmNext.onDisk ?? "")}
          >
            {t("onboarding.language.use", { name: onDiskLabel })}
          </Button>
        )}
        <TextLink onClick={() => link("llm", { target: "llm-where" })}>
          {t("ui.llm.otherOptions")}
        </TextLink>
      </div>
    );
  })();

  return (
    <section
      className="t-quick"
      aria-labelledby="quick-start-title"
      data-anchor="quick-start"
    >
      <div className="t-quick-head">
        <h2 id="quick-start-title" className="t-type-headline">
          {t("setup.quick.title")}
        </h2>
        <span className="t-type-caption t-text-tertiary">
          {t("setup.quick.progress", { done: doneCount, total: 3 })}
        </span>
        <Button
          variant="quiet"
          size="sm"
          className="ms-auto"
          onClick={close}
          title={t("setup.quick.hideHint")}
        >
          {t("setup.quick.hide")}
        </Button>
      </div>
      <ol className="t-quick-steps">
        <Step
          n={1}
          state={stateOf(0)}
          title={
            active
              ? t("setup.quick.modelDone", {
                  name: getTranslatedModelName(active, t),
                })
              : t("setup.quick.model")
          }
          hint={active ? undefined : t("setup.asr.text")}
        >
          <AsrSetupCard embedded />
        </Step>
        <Step
          n={2}
          state={stateOf(1)}
          title={
            dictated
              ? t("setup.quick.dictationDone")
              : t("setup.quick.dictation")
          }
          hint={
            dictated ? undefined : (
              <>
                {t("transcription.try.before")}{" "}
                {key && <Keycaps combo={formatKeyCombination(key, osType)} />}{" "}
                {t("transcription.try.after")}
              </>
            )
          }
        >
          <div className="t-setup-actions">
            <TextLink
              onClick={() => link("dictation", { target: "dictation-keys" })}
            >
              {t("transcription.try.changeKey")}
            </TextLink>
          </div>
        </Step>
        <Step
          n={3}
          state={stateOf(2)}
          title={filesDone ? t("setup.quick.fileDone") : t("setup.quick.file")}
          hint={filesDone ? undefined : t("setup.quick.fileHint")}
        >
          <div className="t-setup-actions">
            <Button variant="secondary" size="sm" onClick={onAddFiles}>
              {t("fileTranscription.input.choose")}
            </Button>
          </div>
        </Step>
      </ol>
      <div className="t-quick-optional">
        <div className="t-quick-title">
          {t("setup.quick.llm")}
          <span className="t-type-caption t-text-tertiary">
            {t("setup.quick.optional")}
          </span>
        </div>
        {!llmState.ready && (
          <div className="t-quick-hint">
            {t("setup.quick.llmHint", {
              model: recommended.name,
              size: recommended.size,
            })}
          </div>
        )}
        {llmStep}
      </div>
    </section>
  );
};
