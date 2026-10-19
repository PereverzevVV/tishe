import React from "react";
import { useTranslation } from "react-i18next";
import { useFileOptionsStore } from "@/stores/fileOptionsStore";
import { Page } from "../shell/Page";
import { SettingsGroup } from "../ui/SettingsGroup";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { ServiceLine } from "../ui/ServiceLine";
import { Keycaps } from "../ui/Keycap";
import { LogLevelSelector } from "../settings/debug/LogLevelSelector";
import { LiveLogViewer } from "../settings/debug/LiveLogViewer";
import { WhatsNewPreview } from "../settings/debug/WhatsNewPreview";
import { KeyboardDiagnostic } from "../settings/debug/KeyboardDiagnostic";
import {
  OnboardingPreview,
  type OnboardingPreviewStep,
} from "../settings/debug/OnboardingPreview";

/**
 * «Отладка» (Ctrl+Shift+D; UX_INTERACTION_ARCHITECTURE S9): developer and
 * bench tools only. Everything a user may need moved to its owner page; the
 * line on top reminds that debug mode persists between launches.
 */
interface DebugPageProps {
  onPreviewOnboarding?: (step: OnboardingPreviewStep) => void;
}

export const DebugPage: React.FC<DebugPageProps> = ({
  onPreviewOnboarding,
}) => {
  const { t } = useTranslation();
  const { options, update } = useFileOptionsStore();

  return (
    <Page section="debug" title={t("sidebar.debug")}>
      <ServiceLine className="mb-6 mt-0">
        <span className="inline-flex flex-wrap items-center gap-1">
          {t("debug.onBefore")}
          <Keycaps combo="Ctrl+Shift+D" />
          {t("debug.onAfter")}
        </span>
      </ServiceLine>

      <SettingsGroup title={t("debug.log")} anchor="debug-log">
        <LogLevelSelector grouped />
        <LiveLogViewer grouped />
      </SettingsGroup>

      <SettingsGroup title={t("debug.previews")} anchor="debug-previews">
        <WhatsNewPreview grouped />
        {onPreviewOnboarding && (
          <OnboardingPreview onPreview={onPreviewOnboarding} grouped />
        )}
      </SettingsGroup>

      <SettingsGroup title={t("debug.keyboard")} anchor="debug-keyboard">
        <KeyboardDiagnostic />
      </SettingsGroup>

      <SettingsGroup
        title={t("debug.transcription")}
        anchor="debug-transcription"
      >
        <ToggleSwitch
          checked={options.saveDebug}
          onChange={(saveDebug) => update({ saveDebug })}
          label={t("fileTranscription.output.saveDebug")}
          description={t("fileTranscription.output.saveDebugDescription")}
        />
      </SettingsGroup>
    </Page>
  );
};
