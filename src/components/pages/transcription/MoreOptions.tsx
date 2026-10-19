import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Trash2 } from "lucide-react";
import { commands, type OutputFormat } from "@/bindings";
import {
  DEFAULT_FILE_OPTIONS,
  changedAdvancedCount,
  cloudConfig,
  useFileOptionsStore,
} from "@/stores/fileOptionsStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { formatBytes } from "@/lib/utils/humanize";
import { Fold } from "@/components/ui/Fold";
import { SettingsGroup } from "@/components/ui/SettingsGroup";
import { SettingContainer } from "@/components/ui/SettingContainer";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { ResetButton } from "@/components/ui/ResetButton";
import { NumberField } from "@/components/ui/NumberField";
import { ServiceLine } from "@/components/ui/ServiceLine";
import { TextLink } from "@/components/ui/TextLink";
import { Tag } from "@/components/ui/Badge";
import { ProgressLine } from "@/components/ui/ProgressLine";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SPEAKER_MODEL_LOOK, type useDiarization } from "./useDiarization";

/**
 * «Расшифровка → Дополнительно» (UX_INTERACTION_ARCHITECTURE S1, Progressive
 * Disclosure level 3): rare settings with safe defaults. Their effective
 * value stays visible on the page («Результат: …», the echo, «Звук уйдёт…»).
 */

type ScriptTest =
  | { state: "idle" | "running" | "ok" }
  | { state: "failed"; error: string };

export const FOLD_ID = "transcription-more";

interface MoreOptionsProps {
  running: boolean;
  diar: ReturnType<typeof useDiarization>;
}

export const MoreOptions: React.FC<MoreOptionsProps> = ({ running, diar }) => {
  const { t, i18n } = useTranslation();
  const { options, update } = useFileOptionsStore();
  const link = useNavigationStore((s) => s.link);
  const [scriptTest, setScriptTest] = useState<ScriptTest>({ state: "idle" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const cloud = cloudConfig(options);

  const pickOutputDir = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: options.lastOutputDir ?? undefined,
    });
    if (typeof selected === "string") update({ lastOutputDir: selected });
  };

  const pickEventScript = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [
        {
          name: t("fileTranscription.events.filterName"),
          extensions: ["exe", "ps1", "bat", "cmd"],
        },
      ],
    });
    if (typeof selected !== "string") return;
    update({ eventScript: selected });
    setScriptTest({ state: "idle" });
  };

  const testEventScript = async () => {
    if (!options.eventScript) return;
    setScriptTest({ state: "running" });
    const res = await commands.sendTestFileEvent(
      options.eventScript,
      t("fileTranscription.events.testMessage"),
    );
    setScriptTest(
      res.status === "ok"
        ? { state: "ok" }
        : { state: "failed", error: res.error },
    );
  };

  const deleteName = (id: string) => {
    const look = SPEAKER_MODEL_LOOK[id];
    return look
      ? t(`fileTranscription.diarization.models.${look.key}.title`)
      : id;
  };

  return (
    <Fold
      id={FOLD_ID}
      title={t("ui.fold.more")}
      changed={changedAdvancedCount(options)}
    >
      <SettingsGroup
        title={t("transcription.more.recognition")}
        anchor="transcription-recognition"
      >
        <NumberField
          label={t("fileTranscription.maxPart.title")}
          description={t("transcription.more.maxPartDescription")}
          value={options.maxPartMinutes}
          min={2}
          max={180}
          unit={t("fileTranscription.maxPart.unit")}
          defaultValue={DEFAULT_FILE_OPTIONS.maxPartMinutes}
          disabled={running}
          onChange={(v) => update({ maxPartMinutes: Math.round(v) })}
        />
        {options.engine === "cloud" && (
          <>
            {options.cloudProvider === "custom" && (
              <SettingContainer
                title={t("fileTranscription.cloud.baseUrl")}
                description={t("fileTranscription.cloud.baseUrlDescription")}
                layout="stacked"
              >
                <Input
                  className="w-full"
                  value={options.cloudBaseUrl}
                  placeholder="https://example.com/v1"
                  onChange={(e) => update({ cloudBaseUrl: e.target.value })}
                  disabled={running}
                />
              </SettingContainer>
            )}
            <SettingContainer
              title={t("fileTranscription.cloud.model")}
              description={t("fileTranscription.cloud.modelDescription")}
            >
              {cloud.preset.models.length > 0 ? (
                <Dropdown
                  options={cloud.preset.models.map((m) => ({
                    value: m,
                    label: m,
                  }))}
                  selectedValue={cloud.model}
                  onSelect={(value) =>
                    update({
                      cloudModels: {
                        ...options.cloudModels,
                        [options.cloudProvider]: value,
                      },
                    })
                  }
                  disabled={running}
                />
              ) : (
                <Input
                  value={cloud.model}
                  placeholder="whisper-1"
                  onChange={(e) =>
                    update({
                      cloudModels: {
                        ...options.cloudModels,
                        [options.cloudProvider]: e.target.value,
                      },
                    })
                  }
                  disabled={running}
                />
              )}
            </SettingContainer>
            <SettingContainer
              title={t("fileTranscription.cloud.language")}
              description={t("fileTranscription.cloud.languageDescription")}
            >
              <Input
                className="w-24"
                value={options.cloudLanguage}
                placeholder={t("fileTranscription.cloud.languagePlaceholder")}
                onChange={(e) => update({ cloudLanguage: e.target.value })}
                disabled={running}
              />
            </SettingContainer>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t("transcription.more.speakers")}
        anchor="transcription-speakers"
      >
        <SettingContainer
          title={t("fileTranscription.diarization.model")}
          description={t("fileTranscription.diarization.modelDescription")}
          layout="stacked"
        >
          <div
            role="radiogroup"
            aria-label={t("fileTranscription.diarization.model")}
          >
            {diar.models.map((m) => {
              const look = SPEAKER_MODEL_LOOK[m.id];
              if (!look) return null;
              const selected = m.id === diar.ready;
              const pct = diar.progress[m.id];
              const base = `fileTranscription.diarization.models.${look.key}`;
              const choose = () => {
                if (m.downloaded && !selected && !running)
                  update({
                    diarization: { ...options.diarization, modelId: m.id },
                  });
              };
              return (
                <div key={m.id} className="t-item">
                  <div
                    className="flex min-w-0 gap-3"
                    role="radio"
                    aria-checked={selected}
                    aria-disabled={!m.downloaded || running}
                    tabIndex={m.downloaded ? 0 : -1}
                    onClick={choose}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        choose();
                      }
                    }}
                  >
                    <span
                      className="t-radio mt-0.5"
                      data-checked={selected}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{t(`${base}.title`)}</span>
                        {look.recommended && (
                          <Tag>
                            {t("fileTranscription.diarization.recommended")}
                          </Tag>
                        )}
                      </div>
                      <div className="t-row-desc">
                        {t(`${base}.description`)}
                      </div>
                      {m.downloading && (
                        <div className="mt-1">
                          <div className="t-item-meta">
                            {t("ui.downloadingPercent", {
                              percent: Math.round(pct ?? 0),
                            })}
                          </div>
                          <ProgressLine value={pct ?? 0} />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="t-item-acts">
                    {m.downloading ? (
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => void diar.cancel(m.id)}
                      >
                        {t("ui.cancelDownload")}
                      </Button>
                    ) : m.downloaded ? (
                      <Button
                        variant="quiet"
                        size="sm"
                        icon
                        disabled={running}
                        aria-label={t("ui.deleteNamed", {
                          name: t(`${base}.title`),
                        })}
                        title={t("ui.deleteNamed", {
                          name: t(`${base}.title`),
                        })}
                        onClick={() => setConfirmDelete(m.id)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void diar.download(m.id)}
                      >
                        {t("ui.downloadSize", {
                          size: formatBytes(m.size_bytes, t, i18n.language),
                        })}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {diar.error && <ServiceLine kind="error">{diar.error}</ServiceLine>}
        </SettingContainer>
      </SettingsGroup>

      <SettingsGroup
        title={t("transcription.more.editing")}
        anchor="transcription-editing"
      >
        <SettingContainer
          changed={(options.llmPrompt ?? "").trim() !== ""}
          ownReset
          title={t("transcription.more.prompt")}
          description={t("transcription.more.promptDescription")}
          layout="stacked"
        >
          <div className="flex items-start gap-2">
            <Textarea
              value={options.llmPrompt ?? ""}
              placeholder={t("fileTranscription.llm.promptPlaceholder")}
              onChange={(e) => update({ llmPrompt: e.target.value || null })}
              disabled={running}
              className="w-full"
              aria-label={t("transcription.more.prompt")}
            />
            {options.llmPrompt !== null && (
              <ResetButton
                onClick={() => update({ llmPrompt: null })}
                disabled={running}
              />
            )}
          </div>
        </SettingContainer>
        <ToggleSwitch
          changed={options.includeRaw !== DEFAULT_FILE_OPTIONS.includeRaw}
          onReset={() =>
            update({ includeRaw: DEFAULT_FILE_OPTIONS.includeRaw })
          }
          checked={options.includeRaw}
          onChange={(includeRaw) => update({ includeRaw })}
          disabled={running}
          label={t("fileTranscription.llm.includeRaw")}
          description={t("fileTranscription.llm.includeRawDescription")}
        />
      </SettingsGroup>

      <SettingsGroup
        title={t("transcription.more.document")}
        anchor="transcription-document"
      >
        <SettingContainer
          title={t("fileTranscription.output.format")}
          changed={options.format !== DEFAULT_FILE_OPTIONS.format}
          onReset={() => update({ format: DEFAULT_FILE_OPTIONS.format })}
        >
          <Dropdown
            options={[
              { value: "docx", label: t("fileTranscription.output.docx") },
              {
                value: "markdown",
                label: t("fileTranscription.output.markdown"),
              },
            ]}
            selectedValue={options.format}
            onSelect={(value) => update({ format: value as OutputFormat })}
            disabled={running}
          />
        </SettingContainer>
        <SettingContainer
          changed={options.lastOutputDir !== DEFAULT_FILE_OPTIONS.lastOutputDir}
          ownReset
          title={t("fileTranscription.output.location")}
          description={t("transcription.more.locationDescription")}
          layout="stacked"
        >
          <div className="flex items-center gap-2">
            <span
              className="t-type-caption t-text-secondary t-selectable min-w-0 flex-1 truncate"
              title={options.lastOutputDir ?? ""}
            >
              {options.lastOutputDir ??
                t("fileTranscription.output.nextToSource")}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={pickOutputDir}
              disabled={running}
            >
              {t("fileTranscription.output.choose")}
            </Button>
            {options.lastOutputDir && (
              <ResetButton
                onClick={() => update({ lastOutputDir: null })}
                disabled={running}
              />
            )}
          </div>
        </SettingContainer>
        <ToggleSwitch
          changed={options.timestamps !== DEFAULT_FILE_OPTIONS.timestamps}
          onReset={() =>
            update({ timestamps: DEFAULT_FILE_OPTIONS.timestamps })
          }
          checked={options.timestamps}
          onChange={(timestamps) => update({ timestamps })}
          disabled={running}
          label={t("fileTranscription.output.timestamps")}
          description={t("transcription.more.timestampsDescription")}
        />
        <ToggleSwitch
          changed={options.removeFillers !== DEFAULT_FILE_OPTIONS.removeFillers}
          onReset={() =>
            update({ removeFillers: DEFAULT_FILE_OPTIONS.removeFillers })
          }
          checked={options.removeFillers}
          onChange={(removeFillers) => update({ removeFillers })}
          disabled={running}
          label={t("fileTranscription.output.removeFillers")}
          description={t("transcription.more.removeFillersDescription")}
          extra={
            <ServiceLine
              action={
                <TextLink
                  onClick={() =>
                    link("dictation", {
                      target: "dictation-text",
                      fold: "dictation-more",
                    })
                  }
                >
                  {t("ui.open")}
                </TextLink>
              }
            >
              {t("transcription.more.globalFillers")}
            </ServiceLine>
          }
        />
        <ToggleSwitch
          changed={options.includeNotes !== DEFAULT_FILE_OPTIONS.includeNotes}
          onReset={() =>
            update({ includeNotes: DEFAULT_FILE_OPTIONS.includeNotes })
          }
          checked={options.includeNotes}
          onChange={(includeNotes) => update({ includeNotes })}
          disabled={running}
          label={t("fileTranscription.output.notes")}
          description={t("transcription.more.notesDescription")}
        />
      </SettingsGroup>

      <SettingsGroup
        title={t("transcription.more.integrations")}
        anchor="transcription-integrations"
      >
        <SettingContainer
          changed={options.eventScript !== DEFAULT_FILE_OPTIONS.eventScript}
          ownReset
          title={t("fileTranscription.events.title")}
          description={t("transcription.more.eventsDescription")}
          layout="stacked"
          extra={
            scriptTest.state === "ok" ? (
              <ServiceLine kind="ready">
                {t("fileTranscription.events.testOk")}
              </ServiceLine>
            ) : scriptTest.state === "failed" ? (
              <ServiceLine kind="error">
                {t("fileTranscription.events.testFailed", {
                  error: scriptTest.error,
                })}
              </ServiceLine>
            ) : undefined
          }
        >
          <div className="flex items-center gap-2">
            <span
              className="t-type-caption t-text-secondary t-selectable min-w-0 flex-1 truncate"
              title={options.eventScript ?? ""}
            >
              {options.eventScript ?? t("fileTranscription.events.none")}
            </span>
            {options.eventScript && (
              <Button
                variant="quiet"
                size="sm"
                loading={scriptTest.state === "running"}
                onClick={() => void testEventScript()}
              >
                {t("fileTranscription.events.test")}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={pickEventScript}
              disabled={running}
            >
              {t("fileTranscription.events.choose")}
            </Button>
            {options.eventScript && (
              <ResetButton
                onClick={() => {
                  update({ eventScript: null });
                  setScriptTest({ state: "idle" });
                }}
                disabled={running}
              />
            )}
          </div>
        </SettingContainer>
        {options.eventScript && (
          <NumberField
            dependent
            label={t("fileTranscription.events.interval.title")}
            description={t("fileTranscription.events.interval.description")}
            value={options.eventIntervalSecs}
            min={1}
            max={600}
            unit={t("fileTranscription.events.interval.unit")}
            defaultValue={DEFAULT_FILE_OPTIONS.eventIntervalSecs}
            disabled={running}
            onChange={(v) => update({ eventIntervalSecs: Math.round(v) })}
          />
        )}
      </SettingsGroup>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("ui.confirm.deleteModelTitle", {
          name: confirmDelete ? deleteName(confirmDelete) : "",
        })}
        confirmLabel={t("ui.confirm.deleteModel")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void diar.remove(confirmDelete);
          setConfirmDelete(null);
        }}
      >
        {t("ui.confirm.deleteSpeakerModelBody")}
      </ConfirmDialog>
    </Fold>
  );
};
