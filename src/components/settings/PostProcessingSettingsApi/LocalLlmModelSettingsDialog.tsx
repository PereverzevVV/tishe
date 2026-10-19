import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  commands,
  type LlmModelSettings,
  type LlmModelSettingsView,
} from "@/bindings";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NumberParam, PromptParam, SelectParam } from "../models/ParamFields";

const EMPTY: LlmModelSettings = {
  prompt_ru: null,
  prompt_en: null,
  temperature: null,
  chunk_chars: null,
  context_tokens: null,
  max_answer_tokens: null,
  threads: null,
};

/**
 * ⚙ «Параметры» of a built-in LLM model: its instructions for Russian and
 * English and its launch parameters. Saved at once; only what differs from
 * the measured defaults is stored (`model_settings.json`).
 */
export const LocalLlmModelSettingsDialog: React.FC<{
  modelId: string | null;
  modelName: string;
  onClose: () => void;
}> = ({ modelId, modelName, onClose }) => {
  const { t } = useTranslation();
  const [view, setView] = useState<LlmModelSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    if (modelId) void commands.getLlmModelSettings(modelId).then(setView);
  }, [modelId]);

  const save = async (settings: LlmModelSettings) => {
    if (!modelId) return false;
    const res = await commands.setLlmModelSettings(modelId, settings);
    if (res.status === "ok") {
      setView(res.data);
      setError(null);
      return true;
    } else {
      const tooSmall = /^context_too_small:(\d+)$/.exec(res.error);
      setError(
        tooSmall
          ? t("settings.models.params.llm.contextTooSmall", {
              min: Number(tooSmall[1]),
            })
          : t("settings.models.params.llm.invalid", { detail: res.error }),
      );
      return false;
    }
  };

  const s = view?.settings;
  const d = view?.defaults;
  const changedAny =
    !!s && Object.values(s).some((v) => v !== null && v !== undefined);
  const p = "settings.models.params.llm";

  return (
    <Dialog
      open={modelId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("settings.models.params.title", { name: modelName })}
      description={t("settings.models.params.savedAtOnce")}
      closeLabel={t("common.close")}
      className="max-w-2xl"
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={!changedAny}
            onClick={() => void save(EMPTY)}
          >
            {t("settings.models.params.resetAll")}
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            {t("settings.models.params.done")}
          </Button>
        </>
      }
    >
      {!s || !d ? (
        <div className="py-6 text-center t-text-secondary">…</div>
      ) : (
        <div className="space-y-5">
          <p className="t-type-caption t-text-secondary">
            {t(`${p}.promptNote`)}
          </p>
          <PromptParam
            label={t(`${p}.promptRu`)}
            value={s.prompt_ru}
            defaultValue={d.prompt_ru}
            onCommit={(v) => save({ ...s, prompt_ru: v })}
          />
          <PromptParam
            label={t(`${p}.promptEn`)}
            value={s.prompt_en}
            defaultValue={d.prompt_en}
            onCommit={(v) => save({ ...s, prompt_en: v })}
          />
          <NumberParam
            label={t(`${p}.temperature.label`)}
            description={t(`${p}.temperature.description`)}
            value={s.temperature}
            defaultValue={d.temperature}
            min={0}
            max={1.5}
            step={0.05}
            onCommit={(v) => save({ ...s, temperature: v })}
          />
          <NumberParam
            label={t(`${p}.chunk.label`)}
            description={t(`${p}.chunk.description`)}
            value={s.chunk_chars}
            defaultValue={d.chunk_chars}
            min={1000}
            max={8000}
            step={500}
            onCommit={(v) => save({ ...s, chunk_chars: v })}
          />
          <NumberParam
            label={t(`${p}.context.label`)}
            description={t(`${p}.context.description`)}
            value={s.context_tokens}
            defaultValue={d.context_tokens}
            min={4096}
            max={32768}
            step={1024}
            onCommit={(v) => save({ ...s, context_tokens: v })}
          />
          <NumberParam
            label={t(`${p}.answer.label`)}
            description={t(`${p}.answer.description`)}
            value={s.max_answer_tokens}
            defaultValue={d.max_answer_tokens}
            min={512}
            max={8192}
            step={256}
            onCommit={(v) => save({ ...s, max_answer_tokens: v })}
          />
          <SelectParam
            label={t(`${p}.threads.label`)}
            description={t(`${p}.threads.description`)}
            value={s.threads === null ? "auto" : String(s.threads)}
            options={[
              { value: "auto", label: t(`${p}.threads.auto`) },
              ...Array.from({ length: d.max_threads }, (_, i) => ({
                value: String(i + 1),
                label: String(i + 1),
              })),
            ]}
            changed={s.threads !== null}
            onSelect={(v) =>
              void save({ ...s, threads: v === "auto" ? null : Number(v) })
            }
            onReset={() => void save({ ...s, threads: null })}
          />
          <p className="t-type-caption t-text-secondary">
            {t(`${p}.restartNote`)}
          </p>
          {error && (
            <Alert variant="error" contained>
              {error}
            </Alert>
          )}
        </div>
      )}
    </Dialog>
  );
};
