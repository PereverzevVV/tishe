import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioLines } from "lucide-react";
import { useModelStore } from "@/stores/modelStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { getTranslatedModelName } from "@/lib/utils/modelTranslation";
import { formatMb } from "@/lib/utils/humanize";
import {
  LANGS,
  langLimitKey,
  langModel,
  systemLanguage,
  type Lang,
} from "@/lib/firstModel";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { ProgressLine } from "../ui/ProgressLine";
import { ServiceLine } from "../ui/ServiceLine";
import { TextLink } from "../ui/TextLink";
import { useModelDownload } from "./useModelDownload";

/**
 * «Скачайте модель распознавания» — the one thing Tishe cannot work without,
 * shown where the person is when it is missing (Расшифровка, Диктовка,
 * Модели) instead of a red line and a link to the long catalog. The language
 * of the recordings picks the model, as on the first-run screen; the download
 * starts here and shows its progress here. When it completes, the status bar
 * makes the model active (`useAsrModelStatus`).
 *
 * `embedded` draws only the body, for the first step of «Быстрый старт».
 */
export const AsrSetupCard: React.FC<{ embedded?: boolean }> = ({
  embedded = false,
}) => {
  const { t, i18n } = useTranslation();
  const {
    models,
    currentModel,
    downloadingModels,
    verifyingModels,
    extractingModels,
    selectModel,
  } = useModelStore();
  const running = useFileTranscriptionStore((s) => s.running);
  const link = useNavigationStore((s) => s.link);
  const [lang, setLang] = useState<Lang>(systemLanguage);
  const [selecting, setSelecting] = useState(false);
  const [selectFailed, setSelectFailed] = useState(false);

  // A download already under way (started on the first-run screen or in the
  // catalog) is the one to show.
  const downloadingId =
    Object.keys(downloadingModels)[0] ??
    Object.keys({ ...verifyingModels, ...extractingModels })[0];
  const target = downloadingId
    ? models.find((m) => m.id === downloadingId)
    : langModel(models, lang);
  const dl = useModelDownload(target?.id);
  // On disk but not active (moved over from Handy, or a switch that failed).
  const onDisk = models.find((m) => m.is_downloaded);

  // A download that just finished is made active by the status bar within a
  // second; until then «Готовлю модель…», not «осталось её включить».
  const lastDownloading = useRef<string | null>(null);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (downloadingId) {
      lastDownloading.current = downloadingId;
      return;
    }
    const finished = models.find((m) => m.id === lastDownloading.current);
    if (finished?.is_downloaded) {
      lastDownloading.current = null;
      setSettling(true);
    }
  }, [downloadingId, models]);
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(false), 6000);
    return () => window.clearTimeout(timer);
  }, [settling]);
  const active = models.find((m) => m.id === currentModel && m.is_downloaded);

  // Right after the first run nothing else makes a downloaded model active:
  // the backend waits for onboarding to finish, and the status bar may have
  // missed the "download complete" event (the person opened Tishe at that
  // very moment). With «Быстрый старт» open, take the model on disk — once.
  const quickStart = useOnboardingStore((s) => s.quickStart);
  const triedAuto = useRef(false);
  useEffect(() => {
    if (active || !onDisk || !quickStart || running || downloadingId) return;
    if (triedAuto.current) return;
    triedAuto.current = true;
    void selectModel(onDisk.id);
  }, [active, onDisk, quickStart, running, downloadingId, selectModel]);
  if (active) return null;

  const size = (mb: number) => formatMb(mb, t, i18n.language);

  let body: React.ReactNode;
  if (settling) {
    body = (
      <div className="flex flex-col gap-2" aria-live="polite">
        <ProgressLine value={null} label={onDisk?.name} />
        <span className="t-type-caption t-text-secondary">
          {t("onboarding.download.preparing")}
        </span>
      </div>
    );
  } else if (onDisk && dl.state !== "downloading" && dl.state !== "preparing") {
    body = (
      <>
        <p className="t-text-secondary">
          {t("setup.asr.onDisk", { name: getTranslatedModelName(onDisk, t) })}
        </p>
        {selectFailed && (
          <ServiceLine kind="error">
            {t("onboarding.errors.selectModel")}
          </ServiceLine>
        )}
        <div className="t-setup-actions">
          <Button
            variant="primary"
            disabled={selecting || running}
            onClick={async () => {
              setSelecting(true);
              const ok = await selectModel(onDisk.id);
              setSelecting(false);
              setSelectFailed(!ok);
            }}
          >
            {t("onboarding.language.use", {
              name: getTranslatedModelName(onDisk, t),
            })}
          </Button>
          <TextLink
            onClick={() => link("models", { target: "models-catalog" })}
          >
            {t("setup.asr.allModels")}
          </TextLink>
        </div>
      </>
    );
  } else if (dl.state === "downloading" || dl.state === "preparing") {
    const preparing = dl.state === "preparing";
    body = (
      <div className="flex flex-col gap-2" aria-live="polite">
        <div className="font-semibold">
          {t("onboarding.download.title", {
            name: target ? getTranslatedModelName(target, t) : "",
          })}
        </div>
        <ProgressLine
          value={preparing ? null : dl.percent}
          label={target?.name}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 t-type-caption t-text-secondary">
          <span>
            {preparing ? t("onboarding.download.preparing") : dl.detail}
          </span>
          {!preparing && (
            <span className="flex items-center gap-3">
              {t("ui.percent", { n: Math.round(dl.percent) })}
              <Button
                variant="quiet"
                size="sm"
                onClick={() => void dl.cancel()}
              >
                {t("onboarding.download.cancel")}
              </Button>
            </span>
          )}
        </div>
        <p className="t-type-caption t-text-tertiary">
          {t("setup.asr.whileDownloading")}
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <div className="t-setup-lang">
          <span className="t-setup-label" id="setup-asr-lang">
            {t("setup.asr.language")}
          </span>
          <Dropdown
            ariaLabel={t("setup.asr.language")}
            selectedValue={lang}
            options={LANGS.filter((l) => langModel(models, l)).map((l) => ({
              value: l,
              label: t(`onboarding.language.${l}.title`),
            }))}
            onSelect={(v) => setLang(v as Lang)}
          />
        </div>
        {target && (
          <p className="t-type-caption t-text-secondary">
            {[
              getTranslatedModelName(target, t),
              t(langLimitKey(lang)),
              size(target.size_mb),
            ].join(" · ")}
          </p>
        )}
        {dl.state === "failed" && (
          <ServiceLine kind="error">
            {t("onboarding.download.failedHint")}
          </ServiceLine>
        )}
        <div className="t-setup-actions">
          <Button
            variant="primary"
            disabled={!target}
            onClick={() => void dl.start()}
          >
            {dl.state === "failed"
              ? t("onboarding.download.retry")
              : t("onboarding.language.download", {
                  size: target ? size(target.size_mb) : "",
                })}
          </Button>
          <TextLink
            onClick={() => link("models", { target: "models-catalog" })}
          >
            {t("setup.asr.allModels")}
          </TextLink>
        </div>
      </>
    );
  }

  if (embedded) return <div className="flex flex-col gap-3">{body}</div>;

  return (
    <section
      className="t-setup"
      data-anchor="setup-asr"
      aria-labelledby="setup-asr-title"
    >
      <div className="t-setup-head">
        <AudioLines className="t-setup-icon" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <h2 id="setup-asr-title" className="t-type-headline">
            {t("setup.asr.title")}
          </h2>
          <p className="t-text-secondary">{t("setup.asr.text")}</p>
        </div>
      </div>
      <div className="flex flex-col gap-3">{body}</div>
    </section>
  );
};
