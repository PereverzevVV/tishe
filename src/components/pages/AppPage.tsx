import React from "react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";
import { useSettings } from "@/hooks/useSettings";
import { Page } from "../shell/Page";
import { SettingsGroup } from "../ui/SettingsGroup";
import { SettingContainer } from "../ui/SettingContainer";
import { Button } from "../ui/Button";
import { ServiceLine } from "../ui/ServiceLine";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { StartHidden } from "../settings/StartHidden";
import { AutostartToggle } from "../settings/AutostartToggle";
import { ShowTrayIcon } from "../settings/ShowTrayIcon";
import { AppLanguageSelector } from "../settings/AppLanguageSelector";
import { ThemeSelector } from "../settings/ThemeSelector";
import { UpdateChecksToggle } from "../settings/UpdateChecksToggle";
import { ShowWhatsNewOnUpdate } from "../settings/ShowWhatsNewOnUpdate";
import { ExperimentalToggle } from "../settings/ExperimentalToggle";
import { KeyboardImplementationSelector } from "../settings/debug/KeyboardImplementationSelector";
import { AccelerationSelector } from "../settings/AccelerationSelector";
import { LazyStreamClose } from "../settings/LazyStreamClose";
import { VadBackendSelector } from "../settings/VadBackendSelector";

/**
 * «Приложение» — the program as a whole (UX_INTERACTION_ARCHITECTURE S7): a
 * short page set once. Launch and tray, look, Windows notifications about
 * transcriptions, updates, and experiments behind their own switch.
 */
export const AppPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateChecksLocked, updateSetting, isUpdating } =
    useSettings();
  const experimental = settings?.experimental_enabled ?? false;
  const updatesOn =
    (settings?.update_checks_enabled ?? false) && updateChecksLocked === false;

  return (
    <Page section="app" title={t("sidebar.app")} purpose={t("app.purpose")}>
      <div className="t-work t-wide">
        <div className="t-work-main">
          <SettingsGroup title={t("app.launch")} anchor="app-launch">
            <StartHidden grouped />
            <AutostartToggle grouped />
            <ShowTrayIcon
              grouped
              extra={
                (settings?.show_tray_icon ?? true) && (
                  <ServiceLine>{t("app.trayHint")}</ServiceLine>
                )
              }
            />
          </SettingsGroup>

          <SettingsGroup title={t("app.look")} anchor="app-look">
            <ThemeSelector grouped />
            <AppLanguageSelector grouped />
          </SettingsGroup>
        </div>

        <div className="t-work-side">
          <SettingsGroup
            title={t("app.notifications")}
            anchor="app-notifications"
          >
            <ToggleSwitch
              grouped
              checked={settings?.transcription_notifications ?? true}
              onChange={(on) =>
                updateSetting("transcription_notifications", on)
              }
              isUpdating={isUpdating("transcription_notifications")}
              label={t("app.notifyLabel")}
              description={t("app.notifyDescription")}
              descriptionMode="inline"
            />
          </SettingsGroup>

          <SettingsGroup title={t("app.updates")} anchor="app-updates">
            <UpdateChecksToggle grouped />
            {updatesOn && (
              <SettingContainer dependent title={t("app.checkNow")}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void emit("check-for-updates")}
                >
                  {t("app.checkNowButton")}
                </Button>
              </SettingContainer>
            )}
            <ShowWhatsNewOnUpdate grouped />
          </SettingsGroup>

          <SettingsGroup
            title={t("app.experimental")}
            anchor="app-experimental"
          >
            <ExperimentalToggle grouped />
            {experimental && (
              <>
                <KeyboardImplementationSelector grouped />
                <AccelerationSelector grouped />
                <LazyStreamClose grouped />
                <VadBackendSelector grouped />
              </>
            )}
          </SettingsGroup>
        </div>
      </div>
    </Page>
  );
};
