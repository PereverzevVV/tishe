import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";
import { type } from "@tauri-apps/plugin-os";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { useSettingsStore } from "@/stores/settingsStore";
import { useModelStore } from "@/stores/modelStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { countChanged } from "@/lib/changedSettings";
import { Page } from "../shell/Page";
import { SettingsGroup } from "../ui/SettingsGroup";
import { SettingContainer } from "../ui/SettingContainer";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { Dropdown } from "../ui/Dropdown";
import { Button } from "../ui/Button";
import { Fold } from "../ui/Fold";
import { Keycaps } from "../ui/Keycap";
import { ServiceLine } from "../ui/ServiceLine";
import { TextLink } from "../ui/TextLink";
import { ShortcutInput } from "../settings/ShortcutInput";
import { ShortcutActivationSetting } from "../settings/ShortcutActivation";
import { MicrophoneSelector } from "../settings/MicrophoneSelector";
import { ChannelSelector } from "../settings/ChannelSelector";
import { MuteWhileRecording } from "../settings/MuteWhileRecording";
import { AudioFeedback } from "../settings/AudioFeedback";
import { SoundPicker } from "../settings/SoundPicker";
import { OutputDeviceSelector } from "../settings/OutputDeviceSelector";
import { VolumeSlider } from "../settings/VolumeSlider";
import { PasteMethodSetting } from "../settings/PasteMethod";
import { TypingToolSetting } from "../settings/TypingTool";
import { ClipboardHandlingSetting } from "../settings/ClipboardHandling";
import { AutoSubmit } from "../settings/AutoSubmit";
import { AppendTrailingSpace } from "../settings/AppendTrailingSpace";
import { ShowOverlay } from "../settings/ShowOverlay";
import { VoiceActivityDetection } from "../settings/VoiceActivityDetection";
import { AlwaysOnMicrophone } from "../settings/AlwaysOnMicrophone";
import { ClamshellMicrophoneSelector } from "../settings/ClamshellMicrophoneSelector";
import { PasteDelay } from "../settings/debug/PasteDelay";
import { ReliablePasteToggle } from "../settings/debug/ReliablePaste";
import { RecordingBuffer } from "../settings/debug/RecordingBuffer";
import { HoldThreshold } from "../settings/debug/HoldThreshold";
import { PromptsDialog } from "../settings/post-processing/PromptsDialog";
import { FillerWordRemoval } from "../settings/FillerWordRemoval";
import { AsrEchoLine, LlmReadinessLine } from "./shared";
import { AsrSetupCard } from "../setup/AsrSetupCard";
import { useLlmGate } from "../setup/LlmSetupDialog";

/**
 * «Диктовка» (UX_INTERACTION_ARCHITECTURE S2): the invisible way of working.
 * The page answers «does it work and with which key», changes the key or the
 * microphone, turns on the second key with editing, and fixes problems by
 * symptom in «Если что-то не работает».
 */

/**
 * Bindings whose key another program holds (S2). Only the system-shortcut
 * mode can be refused; the default hook on Windows never is.
 */
const useShortcutConflicts = (): string[] => {
  const [conflicts, setConflicts] = useState<string[]>([]);
  useEffect(() => {
    void commands
      .getShortcutConflicts()
      .then(setConflicts)
      .catch(() => {});
    const unlisten = listen<string[]>("shortcut-conflicts-changed", (e) =>
      setConflicts(e.payload),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  return conflicts;
};

const MORE_FOLD = "dictation-more";
const FIX_FOLD = "dictation-fix";

export const DictationPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings, getSetting, updateSetting, isUpdating } = useSettings();
  const defaults = useSettingsStore((s) => s.defaultSettings);
  const osType = useOsType();
  const isLinux = type() === "linux";
  const { models, currentModel } = useModelStore();
  const link = useNavigationStore((s) => s.link);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const conflicts = useShortcutConflicts();
  const llmGate = useLlmGate();
  const keyBusy = conflicts.includes("transcribe");

  const transcribeKey = settings?.bindings?.transcribe?.current_binding ?? "";
  const hasModel = models.some((m) => m.id === currentModel && m.is_downloaded);
  const secondKey = getSetting("post_process_enabled") ?? false;
  const feedback = getSetting("audio_feedback") ?? false;
  const activation = getSetting("shortcut_activation") ?? "hold_or_toggle";
  const prompts = getSetting("post_process_prompts") ?? [];
  const selectedPrompt = getSetting("post_process_selected_prompt_id") ?? "";

  const moreChanged = countChanged(settings, defaults, [
    "paste_method",
    "typing_tool",
    "clipboard_handling",
    "auto_submit",
    "append_trailing_space",
    "overlay_style",
    "overlay_position",
    "vad_enabled",
    "always_on_microphone",
    "clamshell_microphone",
    "filler_word_removal_enabled",
  ]);
  const fixChanged = countChanged(settings, defaults, [
    "paste_delay_ms",
    "paste_delay_after_ms",
    "reliable_paste",
    "extra_recording_buffer_ms",
    "hold_threshold_ms",
  ]);

  const status = !hasModel ? null : keyBusy ? (
    <SettingContainer
      title={t("dictation.status.keyBusy")}
      extra={
        <ServiceLine
          kind="error"
          action={
            <TextLink
              onClick={() => link("dictation", { target: "dictation-keys" })}
            >
              {t("dictation.status.changeKey")}
            </TextLink>
          }
        >
          {t("dictation.status.keyBusyDetail", {
            key: formatKeyCombination(transcribeKey, osType),
          })}
        </ServiceLine>
      }
    />
  ) : (
    <SettingContainer
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {t("dictation.status.ready")}
          {transcribeKey && (
            <Keycaps combo={formatKeyCombination(transcribeKey, osType)} />
          )}
          <span className="t-text-secondary">
            {t("dictation.status.anyWindow")}
          </span>
        </span>
      }
      extra={<AsrEchoLine sharedWith="files" />}
    />
  );

  return (
    <Page section="dictation" title={t("sidebar.dictation")}>
      <div className="t-work t-wide">
        <div className="t-work-main">
          {/* Without a speech model the page starts with the way to get one. */}
          {status ? (
            <SettingsGroup anchor="dictation-status">{status}</SettingsGroup>
          ) : (
            <AsrSetupCard />
          )}

          <SettingsGroup
            title={t("dictation.keys.title")}
            anchor="dictation-keys"
          >
            <ShortcutInput shortcutId="transcribe" grouped />
            <ShortcutActivationSetting grouped />
            {/* Cancel shortcut remains hidden on Linux because of dynamic shortcut instability. */}
            {!isLinux && <ShortcutInput shortcutId="cancel" grouped />}
            <ToggleSwitch
              checked={secondKey}
              onChange={(enabled) =>
                enabled
                  ? llmGate.request(() =>
                      updateSetting("post_process_enabled", true),
                    )
                  : updateSetting("post_process_enabled", false)
              }
              isUpdating={isUpdating("post_process_enabled")}
              label={t("dictation.keys.second")}
              description={t("dictation.keys.secondDescription")}
              extra={secondKey ? <LlmReadinessLine /> : undefined}
              anchor="dictation-second-key"
            />
            {secondKey && (
              <>
                <ShortcutInput
                  shortcutId="transcribe_with_post_process"
                  grouped
                  dependent
                />
                {conflicts.includes("transcribe_with_post_process") && (
                  <ServiceLine kind="error" className="t-row t-row-dependent">
                    {t("dictation.keys.secondBusy")}
                  </ServiceLine>
                )}
                <SettingContainer
                  dependent
                  title={t("dictation.keys.instruction")}
                >
                  <Dropdown
                    ariaLabel={t("dictation.keys.instruction")}
                    selectedValue={selectedPrompt || null}
                    options={prompts.map((p) => ({
                      value: p.id,
                      label: p.name,
                    }))}
                    onSelect={(value) =>
                      updateSetting("post_process_selected_prompt_id", value)
                    }
                    placeholder={t(
                      "settings.postProcessing.prompts.selectPrompt",
                    )}
                  />
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => setPromptsOpen(true)}
                  >
                    {t("dictation.keys.manage")}
                  </Button>
                </SettingContainer>
              </>
            )}
          </SettingsGroup>

          <SettingsGroup
            title={t("settings.sound.title")}
            anchor="dictation-sound"
          >
            <MicrophoneSelector grouped />
            <ChannelSelector grouped />
            <MuteWhileRecording grouped />
            <AudioFeedback grouped />
            {feedback && (
              <>
                <SoundPicker
                  dependent
                  label={t("settings.debug.soundTheme.label")}
                />
                <OutputDeviceSelector grouped dependent />
                <VolumeSlider dependent />
              </>
            )}
          </SettingsGroup>
        </div>

        <div className="t-work-side">
          <Fold id={MORE_FOLD} title={t("ui.fold.more")} changed={moreChanged}>
            <SettingsGroup
              title={t("dictation.more.paste")}
              anchor="dictation-paste"
            >
              <PasteMethodSetting grouped />
              <TypingToolSetting grouped />
              <ClipboardHandlingSetting grouped />
              <AutoSubmit grouped />
              <AppendTrailingSpace grouped />
            </SettingsGroup>
            <SettingsGroup
              title={t("dictation.more.text")}
              anchor="dictation-text"
            >
              <FillerWordRemoval
                grouped
                descriptionMode="inline"
                extra={
                  <ServiceLine
                    action={
                      <TextLink
                        onClick={() =>
                          link("transcription", {
                            target: "transcription-document",
                            fold: "transcription-more",
                          })
                        }
                      >
                        {t("ui.open")}
                      </TextLink>
                    }
                  >
                    {t("dictation.more.fillersDocuments")}
                  </ServiceLine>
                }
              />
            </SettingsGroup>
            <SettingsGroup
              title={t("dictation.more.indicator")}
              anchor="dictation-indicator"
            >
              <ShowOverlay grouped />
            </SettingsGroup>
            <SettingsGroup
              title={t("dictation.more.microphone")}
              anchor="dictation-microphone"
            >
              <VoiceActivityDetection grouped />
              <AlwaysOnMicrophone grouped />
              <ClamshellMicrophoneSelector grouped />
            </SettingsGroup>
            <SettingsGroup
              title={t("dictation.more.prompts")}
              anchor="dictation-prompts"
            >
              <SettingContainer
                title={t("dictation.more.promptsRow")}
                description={t("dictation.more.promptsDescription", {
                  count: prompts.length,
                })}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPromptsOpen(true)}
                >
                  {t("dictation.keys.manage")}
                </Button>
              </SettingContainer>
            </SettingsGroup>
          </Fold>

          <Fold
            id={FIX_FOLD}
            title={t("dictation.fix.title")}
            changed={fixChanged}
          >
            <SettingsGroup
              title={t("dictation.fix.paste")}
              description={t("dictation.fix.pasteHelp")}
              anchor="dictation-fix-paste"
            >
              <PasteDelay />
              <PasteDelay
                settingKey="paste_delay_after_ms"
                labelKey="settings.debug.pasteDelayAfter.title"
                descriptionKey="settings.debug.pasteDelayAfter.description"
              />
              <ReliablePasteToggle grouped />
            </SettingsGroup>
            <SettingsGroup
              title={t("dictation.fix.cutOff")}
              anchor="dictation-fix-cutoff"
            >
              <RecordingBuffer />
            </SettingsGroup>
            {activation === "hold_or_toggle" && (
              <SettingsGroup
                title={t("dictation.fix.hold")}
                anchor="dictation-fix-hold"
              >
                <HoldThreshold />
              </SettingsGroup>
            )}
          </Fold>
        </div>
      </div>

      {llmGate.dialog}
      <PromptsDialog open={promptsOpen} onClose={() => setPromptsOpen(false)} />
    </Page>
  );
};
