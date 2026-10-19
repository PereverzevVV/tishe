import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { useModelStore } from "@/stores/modelStore";
import {
  LOCAL_PROVIDER_ID,
  MODEL_LOOK,
  RECOMMENDED_LOCAL_MODEL,
  isLocalAddress,
  llmReadiness,
  useLlmStore,
} from "@/stores/llmStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { getTranslatedModelName } from "@/lib/utils/modelTranslation";
import { formatBytes, languageName } from "@/lib/utils/humanize";
import { ServiceLine } from "../ui/ServiceLine";
import { TextLink } from "../ui/TextLink";
import { Button } from "../ui/Button";

/**
 * Pieces shared by several pages: the echo of the speech-recognition engine
 * and the readiness line of the editing LLM. Both are «эхо» rows
 * (UX_ARCHITECTURE_PROPOSAL, ownership rule): the setting lives on its
 * resource page, the scenario shows its value and «Изменить».
 */

/** Name and language of the speech model used by dictation and files. */
const useAsrEcho = () => {
  const { t, i18n } = useTranslation();
  const { models, currentModel } = useModelStore();
  const { settings } = useSettings();
  const model = models.find((m) => m.id === currentModel && m.is_downloaded);
  if (!model) return { model: null, name: "", language: "" };
  const name = getTranslatedModelName(model, t);
  let language = "";
  if (model.supports_language_selection) {
    const code = settings?.selected_language ?? "auto";
    language =
      code === "auto"
        ? t("settings.general.language.auto").toLowerCase()
        : languageName(code, i18n.language);
  } else if (model.supported_languages.length === 1) {
    language = languageName(model.supported_languages[0], i18n.language);
  }
  return { model, name, language };
};

/** «Распознавание: GigaAM v3 · язык: русский · общая с … · Изменить». */
export const AsrEchoLine: React.FC<{ sharedWith: "dictation" | "files" }> = ({
  sharedWith,
}) => {
  const { t } = useTranslation();
  const link = useNavigationStore((s) => s.link);
  const section = useNavigationStore((s) => s.section);
  const quickStart = useOnboardingStore((s) => s.quickStart);
  const echo = useAsrEcho();
  if (!echo.model) {
    // Not an error to fix elsewhere: the page shows how to get one.
    return (
      <ServiceLine
        kind="missing"
        action={
          <TextLink
            onClick={() =>
              link(section, {
                target:
                  quickStart && section === "transcription"
                    ? "quick-start"
                    : "setup-asr",
              })
            }
          >
            {t("ui.download")}
          </TextLink>
        }
      >
        {t("ui.echo.noModel")}
      </ServiceLine>
    );
  }
  const parts = [
    t("ui.echo.recognition", { model: echo.name }),
    echo.language ? t("ui.echo.language", { language: echo.language }) : null,
    sharedWith === "dictation"
      ? t("ui.echo.sharedWithDictation")
      : t("ui.echo.sharedWithFiles"),
  ].filter(Boolean);
  return (
    <ServiceLine
      action={
        <TextLink onClick={() => link("models", { target: "models-active" })}>
          {t("ui.change")}
        </TextLink>
      }
    >
      {parts.join(" · ")}
    </ServiceLine>
  );
};

/** Human name of the LLM model for a readiness line. */
export const useLlmModelLabel = (modelId: string, providerId: string) => {
  const { t } = useTranslation();
  if (providerId === LOCAL_PROVIDER_ID) {
    const look = MODEL_LOOK[modelId];
    return look
      ? t(`settings.postProcessing.local.models.${look.key}.model`)
      : modelId;
  }
  return modelId;
};

/**
 * The recommended built-in LLM: its name, size and a download that also makes
 * it the model in use when none is chosen yet. Used by the readiness line,
 * the «Для редактуры нужна нейросеть» dialog and «Быстрый старт».
 */
export const useRecommendedLlm = () => {
  const { t, i18n } = useTranslation();
  const { setPostProcessProvider, updatePostProcessModel } = useSettings();
  const llm = useLlmStore();
  const rec = llm.models.find((m) => m.id === RECOMMENDED_LOCAL_MODEL);
  const look = MODEL_LOOK[RECOMMENDED_LOCAL_MODEL];

  // The built-in LLM becomes the one in use: provider «на этом компьютере»
  // and, unless a downloaded model is chosen already, this model.
  const useLocal = async (id: string) => {
    const settings = useSettingsStore.getState().settings;
    if (settings?.post_process_provider_id !== LOCAL_PROVIDER_ID)
      await setPostProcessProvider(LOCAL_PROVIDER_ID);
    const chosen = settings?.post_process_models?.[LOCAL_PROVIDER_ID] ?? "";
    const chosenOnDisk = useLlmStore
      .getState()
      .models.some((m) => m.id === chosen && m.downloaded);
    if (!chosenOnDisk) await updatePostProcessModel(LOCAL_PROVIDER_ID, id);
  };

  return {
    available: Boolean(rec),
    name: look
      ? t(`settings.postProcessing.local.models.${look.key}.model`)
      : RECOMMENDED_LOCAL_MODEL,
    size: rec ? formatBytes(rec.size_bytes, t, i18n.language) : "",
    ramGb: look ? look.ramGb.toLocaleString(i18n.language) : "",
    useLocal,
    download: async () => {
      // Switch first, so the readiness line shows this download at once.
      if (
        useSettingsStore.getState().settings?.post_process_provider_id !==
        LOCAL_PROVIDER_ID
      )
        await setPostProcessProvider(LOCAL_PROVIDER_ID);
      const ok = await llm.download(RECOMMENDED_LOCAL_MODEL);
      if (ok) await useLocal(RECOMMENDED_LOCAL_MODEL);
      return ok;
    },
  };
};

/**
 * What it takes to make editing work, for the dialog, «Быстрый старт» and
 * the start panel:
 * - `download` — no local model yet; also when a cloud service is chosen but
 *   was never set up (a new install starts on OpenAI without a key), because
 *   for most people the built-in model is the right answer;
 * - `useLocal` — a local model is on disk but not the one in use
 *   (`onDisk` names it);
 * - `setup` — an own server or a service that misses an address, key or
 *   model: only «Редактура» can fix that;
 * - `runtime` — this build has no built-in engine.
 */
export type LlmNext =
  | "ready"
  | "downloading"
  | "download"
  | "useLocal"
  | "setup"
  | "runtime";

export const llmNextStep = (
  settings: Parameters<typeof llmReadiness>[0],
  llm: Parameters<typeof llmReadiness>[1],
): { step: LlmNext; onDisk?: string } => {
  const r = llmReadiness(settings, llm);
  if (r.ready) return { step: "ready" };
  if (r.problem === "downloading") return { step: "downloading" };
  if (llm.models.some((m) => m.downloading)) return { step: "downloading" };
  if (r.problem === "runtime") return { step: "runtime" };
  const localProvider = (settings?.post_process_providers ?? []).some(
    (p) => p.id === LOCAL_PROVIDER_ID,
  );
  const localWorks = localProvider && llm.status?.runtime_available !== false;
  const neverSetUp = r.where === "cloud" && r.problem === "noKey";
  if (r.problem === "noModel" || (neverSetUp && localWorks)) {
    const onDisk = llm.models.find((m) => m.downloaded)?.id;
    return onDisk ? { step: "useLocal", onDisk } : { step: "download" };
  }
  return { step: "setup" };
};

/**
 * Readiness of the editing LLM under a recipe or second-key switch: ready,
 * missing (with «Скачать»), downloading (with «Отменить»), or where the text
 * goes when it leaves the computer (amber cloud).
 */
export const LlmReadinessLine: React.FC = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const llm = useLlmStore();
  const recommended = useRecommendedLlm();
  const link = useNavigationStore((s) => s.link);
  const r = llmReadiness(settings, llm);
  const modelLabel = useLlmModelLabel(r.modelId, r.providerId);
  const toLlm = (
    <TextLink onClick={() => link("llm", { target: "llm-where" })}>
      {t("ui.change")}
    </TextLink>
  );

  if (r.where === "local") {
    if (r.problem === "runtime")
      return (
        <ServiceLine kind="error" action={toLlm}>
          {t("ui.llm.runtimeMissing")}
        </ServiceLine>
      );
    if (r.problem === "downloading")
      return (
        <ServiceLine
          kind="busy"
          action={
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void llm.cancel(r.modelId)}
            >
              {t("ui.cancelDownload")}
            </Button>
          }
        >
          {t("ui.llm.downloading", { percent: Math.round(r.percent ?? 0) })}
        </ServiceLine>
      );
    if (r.problem === "noModel") {
      return (
        <ServiceLine
          kind="missing"
          action={
            <>
              {recommended.available && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void recommended.download()}
                >
                  {t("ui.downloadSize", { size: recommended.size })}
                </Button>
              )}
              <TextLink onClick={() => link("llm", { target: "llm-variant" })}>
                {t("ui.llm.otherOptions")}
              </TextLink>
            </>
          }
        >
          {t("ui.llm.needed", { model: recommended.name })}
        </ServiceLine>
      );
    }
    return (
      <ServiceLine kind="ready" action={toLlm}>
        {t("ui.llm.ready", { model: modelLabel || r.providerLabel })}
      </ServiceLine>
    );
  }

  if (r.problem === "noKey")
    return (
      <ServiceLine kind="error" action={toLlm}>
        {t("ui.llm.noKey", { provider: r.providerLabel })}
      </ServiceLine>
    );
  if (r.problem === "noUrl")
    return (
      <ServiceLine kind="error" action={toLlm}>
        {t("ui.llm.noUrl")}
      </ServiceLine>
    );
  if (r.problem === "noServerModel")
    return (
      <ServiceLine kind="error" action={toLlm}>
        {t("ui.llm.noServerModel")}
      </ServiceLine>
    );
  if (r.where === "server" && isLocalAddress(r.baseUrl))
    return (
      <ServiceLine kind="ready" action={toLlm}>
        {t("ui.llm.localServer", { model: r.modelId })}
      </ServiceLine>
    );
  return (
    <ServiceLine kind="cloud" action={toLlm}>
      {r.where === "server"
        ? t("ui.llm.textToServer", { address: r.baseUrl })
        : t("ui.llm.textToService", { provider: r.providerLabel })}
    </ServiceLine>
  );
};
