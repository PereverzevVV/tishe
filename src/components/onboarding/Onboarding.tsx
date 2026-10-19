import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText, Mic, Sparkles } from "lucide-react";
import type { ModelInfo } from "@/bindings";
import ModelCard, { isLegacySource } from "./ModelCard";
import { OnboardingShell } from "./OnboardingShell";
import { useModelStore } from "../../stores/modelStore";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Keycaps } from "../ui/Keycap";
import { ProgressLine } from "../ui/ProgressLine";
import { TextLink } from "../ui/TextLink";
import { formatBytes, formatMb } from "@/lib/utils/humanize";
import {
  LANGS,
  langLimitKey,
  langModel as findLangModel,
  systemLanguage,
  type Lang,
} from "@/lib/firstModel";

/**
 * First-run model choice (UX_INTERACTION_ARCHITECTURE CF1, S10; DD-29, DD-33).
 * The person knows the language of their recordings, not model names, so the
 * screen asks «На каком языке ваши записи?» with four cards; the card that
 * matches the Windows language is chosen already. A click only chooses; the
 * download starts with the button that names the model and its size. Any
 * other model is one link away. Step 2 of 3 (permissions → language →
 * download). While the model downloads, the screen tells how dictation and
 * files work, and «Открыть Tishe» lets the person in without waiting: the
 * download goes on and «Быстрый старт» shows it.
 */

type Choice = { lang: Lang } | { modelId: string };
type Phase = "choose" | "download" | "error";

interface OnboardingProps {
  onModelSelected: () => void;
  /** Into the window while the model still downloads. */
  onContinue?: () => void;
  preview?: boolean;
}

const Onboarding: React.FC<OnboardingProps> = ({
  onModelSelected,
  onContinue,
  preview = false,
}) => {
  const { t, i18n } = useTranslation();
  const { settings } = useSettings();
  const osType = useOsType();
  const {
    models,
    downloadModel,
    selectModel,
    downloadingModels,
    verifyingModels,
    extractingModels,
    downloadProgress,
    downloadStats,
    cancelDownload,
  } = useModelStore();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [browse, setBrowse] = useState(false);
  const [phase, setPhase] = useState<Phase>("choose");
  const [error, setError] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const hasStartedSelection = useRef(false);
  const cancelled = useRef(false);
  const groupRef = useRef<HTMLDivElement>(null);

  const langModel = (lang: Lang): ModelInfo | undefined =>
    findLangModel(models, lang);

  // First choice, once the catalog is known: a model already on disk (moved
  // over from Handy) wins, then the Windows language.
  useEffect(() => {
    if (choice || models.length === 0) return;
    const onDisk = LANGS.find((lang) => langModel(lang)?.is_downloaded);
    const anyOnDisk = models.find((m) => m.is_downloaded);
    if (onDisk) setChoice({ lang: onDisk });
    else if (anyOnDisk) setChoice({ modelId: anyOnDisk.id });
    else setChoice({ lang: systemLanguage() });
  }, [models, choice]);

  const chosen: ModelInfo | undefined = !choice
    ? undefined
    : "lang" in choice
      ? langModel(choice.lang)
      : models.find((m) => m.id === choice.modelId);

  // The chosen model is on disk and checked: make it the model and finish.
  useEffect(() => {
    if (preview) return;
    if (!selectedModelId) {
      hasStartedSelection.current = false;
      return;
    }
    const model = models.find((m) => m.id === selectedModelId);
    const busy =
      selectedModelId in downloadingModels ||
      selectedModelId in verifyingModels ||
      selectedModelId in extractingModels;
    if (model?.is_downloaded && !busy && !hasStartedSelection.current) {
      hasStartedSelection.current = true;
      selectModel(selectedModelId).then((success) => {
        if (success) {
          onModelSelected();
        } else {
          toast.error(t("onboarding.errors.selectModel"));
          hasStartedSelection.current = false;
          setSelectedModelId(null);
          setPhase("choose");
        }
      });
    }
  }, [
    selectedModelId,
    models,
    downloadingModels,
    verifyingModels,
    extractingModels,
    selectModel,
    onModelSelected,
    preview,
    t,
  ]);

  const start = async () => {
    if (preview || !chosen) return;
    setError(null);
    cancelled.current = false;
    setSelectedModelId(chosen.id);
    if (chosen.is_downloaded) return;
    setPhase("download");
    const ok = await downloadModel(chosen.id);
    if (!ok) {
      setSelectedModelId(null);
      if (cancelled.current) {
        setPhase("choose");
      } else {
        setError(useModelStore.getState().error);
        setPhase("error");
      }
    }
  };

  const cancel = async () => {
    if (!selectedModelId) return;
    cancelled.current = true;
    await cancelDownload(selectedModelId);
    setSelectedModelId(null);
    setPhase("choose");
  };

  // Arrow keys move the choice inside the radio group (WAI-ARIA radiogroup).
  const onGroupKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const available = LANGS.filter((lang) => langModel(lang));
    const current =
      choice && "lang" in choice ? available.indexOf(choice.lang) : -1;
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const next =
      available[(current + step + available.length) % available.length];
    setChoice({ lang: next });
    requestAnimationFrame(() =>
      groupRef.current
        ?.querySelector<HTMLElement>(`[data-lang="${next}"]`)
        ?.focus(),
    );
  };

  const catalog = useMemo(
    () =>
      models.filter(
        (m) => m.is_downloaded || (!isLegacySource(m) && m.is_recommended),
      ),
    [models],
  );
  const catalogRest = useMemo(
    () =>
      models.filter(
        (m) => !m.is_downloaded && !isLegacySource(m) && !m.is_recommended,
      ),
    [models],
  );
  const [showRest, setShowRest] = useState(false);

  const size = (m: ModelInfo) => formatMb(m.size_mb, t, i18n.language);
  const dictationKey = settings?.bindings?.transcribe?.current_binding ?? "";

  let body: React.ReactNode;
  if (phase === "choose") {
    const custom = choice && "modelId" in choice ? chosen : undefined;
    body = (
      <>
        <div className="flex flex-col gap-2">
          <h1 className="t-type-title" id="onb-lang-title">
            {t("onboarding.language.title")}
          </h1>
          <p className="t-text-secondary">
            {t("onboarding.language.description")}
          </p>
        </div>

        <div
          ref={groupRef}
          role="radiogroup"
          aria-labelledby="onb-lang-title"
          className="flex flex-col gap-2"
          onKeyDown={onGroupKey}
        >
          {LANGS.map((lang) => {
            const m = langModel(lang);
            if (!m) return null;
            const selected = Boolean(
              choice && "lang" in choice && choice.lang === lang,
            );
            return (
              <button
                key={lang}
                type="button"
                role="radio"
                data-lang={lang}
                aria-checked={selected}
                tabIndex={selected || (!choice && lang === LANGS[0]) ? 0 : -1}
                className={`t-card-choice t-card-choice-clickable t-onb-choice text-start ${
                  selected ? "t-card-choice-selected" : ""
                }`}
                onClick={() => setChoice({ lang })}
              >
                <span className="t-radio" aria-hidden="true" />
                <span className="flex flex-col gap-1 min-w-0">
                  <span className="font-semibold">
                    {t(`onboarding.language.${lang}.title`)}
                  </span>
                  <span className="t-type-caption t-text-secondary">
                    {[
                      m.name,
                      t(langLimitKey(lang)),
                      m.is_downloaded
                        ? t("onboarding.language.onDisk")
                        : size(m),
                    ].join(" · ")}
                  </span>
                </span>
              </button>
            );
          })}
          {custom && (
            <div
              role="radio"
              aria-checked
              tabIndex={0}
              className="t-card-choice t-card-choice-selected t-onb-choice"
            >
              <span className="t-radio" aria-hidden="true" />
              <span className="flex flex-col gap-1 min-w-0">
                <span className="font-semibold">{custom.name}</span>
                <span className="t-type-caption t-text-secondary">
                  {custom.is_downloaded
                    ? t("onboarding.language.onDisk")
                    : size(custom)}
                </span>
              </span>
            </div>
          )}
        </div>

        <p className="t-type-caption t-text-tertiary">
          {t("onboarding.language.shared")}
        </p>

        <div>
          <TextLink onClick={() => setBrowse((b) => !b)}>
            {browse
              ? t("onboarding.language.hideCatalog")
              : t("onboarding.language.otherModel")}
          </TextLink>
        </div>

        {browse && (
          <div className="flex flex-col gap-2">
            {[...catalog, ...(showRest ? catalogRest : [])].map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                status={model.is_downloaded ? "available" : "downloadable"}
                onSelect={(id) => {
                  setChoice({ modelId: id });
                  setBrowse(false);
                }}
                onDownload={(id) => {
                  setChoice({ modelId: id });
                  setBrowse(false);
                }}
                showRecommended={false}
              />
            ))}
            {catalogRest.length > 0 && (
              <Button
                variant="quiet"
                size="sm"
                className="self-start"
                onClick={() => setShowRest((v) => !v)}
              >
                {showRest
                  ? t("onboarding.showFewerModels")
                  : t("onboarding.showAllModels", {
                      total: catalog.length + catalogRest.length,
                    })}
              </Button>
            )}
          </div>
        )}

        <div className="t-onb-cta">
          <Button
            variant="primary"
            size="lg"
            disabled={!chosen || preview}
            onClick={() => void start()}
          >
            {chosen?.is_downloaded
              ? t("onboarding.language.use", { name: chosen.name })
              : t("onboarding.language.downloadNamed", {
                  name: chosen?.name ?? "",
                  size: chosen ? size(chosen) : "",
                })}
          </Button>
          {!chosen?.is_downloaded && (
            <span className="t-type-caption t-text-tertiary">
              {t("onboarding.language.once")}
            </span>
          )}
        </div>
      </>
    );
  } else if (phase === "download" && selectedModelId) {
    const model = models.find((m) => m.id === selectedModelId);
    const progress = downloadProgress[selectedModelId];
    const speed = downloadStats[selectedModelId]?.speed;
    // Once the store no longer lists the download, it is past the network
    // part (a failure moves to the error phase): «Готовлю модель…», not a
    // flash of «0 % · Подключаюсь…» and a live «Открыть Tishe».
    const preparing =
      selectedModelId in verifyingModels ||
      selectedModelId in extractingModels ||
      !(selectedModelId in downloadingModels) ||
      Boolean(model?.is_downloaded);
    const pct = progress?.percentage ?? 0;
    body = (
      <>
        <div className="flex flex-col gap-2">
          <h1 className="t-type-title">
            {t("onboarding.download.title", { name: model?.name ?? "" })}
          </h1>
          <p className="t-text-secondary">
            {t("onboarding.download.description")}
          </p>
        </div>
        <div className="flex flex-col gap-2" aria-live="polite">
          <ProgressLine value={preparing ? null : pct} label={model?.name} />
          <div className="flex justify-between gap-4 t-type-caption t-text-secondary">
            <span>
              {preparing
                ? t("onboarding.download.preparing")
                : progress && progress.total > 0
                  ? t("onboarding.download.amount", {
                      done: formatBytes(progress.downloaded, t, i18n.language),
                      total: formatBytes(progress.total, t, i18n.language),
                    })
                  : t("onboarding.download.starting")}
              {!preparing && speed
                ? ` · ${t("onboarding.download.speed", {
                    n: speed.toLocaleString(i18n.language, {
                      maximumFractionDigits: 1,
                    }),
                  })}`
                : ""}
            </span>
            {!preparing && (
              <span>{t("ui.percent", { n: Math.round(pct) })}</span>
            )}
          </div>
        </div>
        <div className="t-onb-tips">
          <h2 className="t-group-title">{t("onboarding.tips.title")}</h2>
          <ul>
            <li>
              <Mic aria-hidden="true" />
              <span>
                {t("onboarding.tips.dictationBefore")}{" "}
                {dictationKey && (
                  <Keycaps combo={formatKeyCombination(dictationKey, osType)} />
                )}{" "}
                {t("onboarding.tips.dictationAfter")}
              </span>
            </li>
            <li>
              <FileText aria-hidden="true" />
              <span>{t("onboarding.tips.files")}</span>
            </li>
            <li>
              <Sparkles aria-hidden="true" />
              <span>{t("onboarding.tips.editing")}</span>
            </li>
          </ul>
        </div>
        <div className="t-onb-cta t-onb-cta-row">
          <Button
            variant="secondary"
            disabled={preparing}
            onClick={() => void cancel()}
          >
            {t("onboarding.download.cancel")}
          </Button>
          {onContinue && !preparing && (
            <Button variant="primary" onClick={onContinue}>
              {t("onboarding.download.continue")}
            </Button>
          )}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h1 className="t-type-title">{t("onboarding.download.failed")}</h1>
        <Alert
          variant="error"
          title={t("onboarding.download.failedTitle")}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void start()}>
                {t("onboarding.download.retry")}
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  setPhase("choose");
                  setBrowse(true);
                }}
              >
                {t("onboarding.language.otherModel")}
              </Button>
            </div>
          }
        >
          {error ?? t("onboarding.download.failedHint")}
        </Alert>
      </>
    );
  }

  return (
    <OnboardingShell step={phase === "choose" ? "language" : "download"}>
      {body}
    </OnboardingShell>
  );
};

export default Onboarding;
