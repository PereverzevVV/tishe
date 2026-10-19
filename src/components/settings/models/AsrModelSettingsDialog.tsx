import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  commands,
  type AsrModelSettings,
  type AsrModelSettingsView,
} from "@/bindings";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NumberParam, SelectParam } from "./ParamFields";

/**
 * ⚙ «Параметры» of a speech recognition model. Changes are saved at once in
 * `model_settings.json`; only what differs from the defaults is stored.
 */
export const AsrModelSettingsDialog: React.FC<{
  modelId: string | null;
  modelName: string;
  onClose: () => void;
}> = ({ modelId, modelName, onClose }) => {
  const { t } = useTranslation();
  const [view, setView] = useState<AsrModelSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    if (modelId) void commands.getAsrModelSettings(modelId).then(setView);
  }, [modelId]);

  const save = async (settings: AsrModelSettings) => {
    if (!modelId) return false;
    const res = await commands.setAsrModelSettings(modelId, settings);
    if (res.status === "ok") {
      setView(res.data);
      setError(null);
      return true;
    }
    setError(res.error);
    return false;
  };

  const s = view?.settings;
  const changedAny = !!s && (s.segment_max_secs !== null || !!s.cpu_only);

  return (
    <Dialog
      open={modelId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("settings.models.params.title", { name: modelName })}
      description={t("settings.models.params.savedAtOnce")}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={!changedAny}
            onClick={() =>
              void save({ segment_max_secs: null, cpu_only: null })
            }
          >
            {t("settings.models.params.resetAll")}
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            {t("settings.models.params.done")}
          </Button>
        </>
      }
    >
      {!view || !s ? (
        <div className="py-6 text-center t-text-secondary">…</div>
      ) : (
        <div className="space-y-5">
          <NumberParam
            label={t("settings.models.params.asr.segment.label")}
            description={t("settings.models.params.asr.segment.description")}
            value={s.segment_max_secs}
            defaultValue={view.defaults.segment_max_secs}
            min={12}
            max={30}
            onCommit={(v) => save({ ...s, segment_max_secs: v })}
          />
          {view.device_choice ? (
            <SelectParam
              label={t("settings.models.params.asr.device.label")}
              description={t("settings.models.params.asr.device.description")}
              value={s.cpu_only ? "cpu" : "general"}
              options={[
                {
                  value: "general",
                  label: t("settings.models.params.asr.device.general"),
                },
                {
                  value: "cpu",
                  label: t("settings.models.params.asr.device.cpu"),
                },
              ]}
              changed={!!s.cpu_only}
              onSelect={(v) => void save({ ...s, cpu_only: v === "cpu" })}
              onReset={() => void save({ ...s, cpu_only: null })}
            />
          ) : (
            <p className="t-text-secondary">
              {t("settings.models.params.asr.device.notHere")}
            </p>
          )}
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
