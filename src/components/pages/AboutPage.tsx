import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { resolveResource } from "@tauri-apps/api/path";
import { toast } from "sonner";
import { Page } from "../shell/Page";
import { SettingsGroup } from "../ui/SettingsGroup";
import { SettingContainer } from "../ui/SettingContainer";
import { Button } from "../ui/Button";
import { AppDataDirectory } from "../settings/AppDataDirectory";
import { LogDirectory } from "../settings/debug/LogDirectory";
import { WhatsNewModal } from "../whats-new/WhatsNewModal";
import {
  findLatestReleaseNote,
  type ReleaseNote,
} from "../whats-new/releaseNotes";
import { commands } from "@/bindings";
import { AUTHOR_URL, TISHE_RELEASE, TISHE_REPO_URL } from "@/lib/release";

/**
 * «О программе» — reference and service (UX_INTERACTION_ARCHITECTURE S8):
 * version and «Что нового», the project and its Handy origin, thanks, folders
 * for a bug report. No primary button: «Поддержать» is secondary (DD-07).
 */
export const AboutPage: React.FC = () => {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [note, setNote] = useState<ReleaseNote | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  const showWhatsNew = () => {
    const latest = findLatestReleaseNote();
    if (latest) setNote(latest);
    else toast(t("settings.debug.whatsNewPreview.noNotes"));
  };

  const openNotices = async () => {
    try {
      const path = await resolveResource("licenses/THIRD_PARTY_NOTICES.txt");
      const result = await commands.openTranscriptFile(path, false);
      if (result.status === "error") throw new Error(result.error);
    } catch {
      toast.error(t("about.project.licensesError"));
    }
  };

  return (
    <Page section="about" title={t("sidebar.about")}>
      <div className="t-work t-wide">
        <div className="t-work-main">
          <SettingsGroup anchor="about-version">
            <SettingContainer
              title={t("settings.about.version.title")}
              description={
                version
                  ? t("about.versionRelease", {
                      version,
                      release: TISHE_RELEASE,
                    })
                  : undefined
              }
            >
              <Button variant="secondary" size="sm" onClick={showWhatsNew}>
                {t("about.whatsNew")}
              </Button>
            </SettingContainer>
          </SettingsGroup>

          <SettingsGroup
            title={t("about.project.title")}
            anchor="about-project"
          >
            <SettingContainer
              title={t("about.project.author")}
              description={t("about.project.authorName")}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void openUrl(AUTHOR_URL)}
              >
                {t("about.project.authorProfile")}
              </Button>
            </SettingContainer>
            <SettingContainer
              title={t("about.project.tishe")}
              description={t("about.project.tisheText")}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void openUrl(TISHE_REPO_URL)}
              >
                {t("settings.about.sourceCode.button")}
              </Button>
            </SettingContainer>
            <SettingContainer
              title={t("about.project.basedOn")}
              description={t("about.project.basedOnText")}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void openUrl("https://github.com/cjpais/Handy")}
              >
                {t("settings.about.sourceCode.button")}
              </Button>
            </SettingContainer>
            <SettingContainer
              title={t("about.project.licenses")}
              description={t("about.project.licensesText")}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void openNotices()}
              >
                {t("about.project.licensesOpen")}
              </Button>
            </SettingContainer>
          </SettingsGroup>
        </div>

        <div className="t-work-side">
          <SettingsGroup
            title={t("settings.about.acknowledgments.title")}
            anchor="about-thanks"
          >
            <SettingContainer
              title={t("settings.about.acknowledgments.ggml.title")}
              description={t("settings.about.acknowledgments.ggml.details")}
            />
            <SettingContainer
              title={t("about.supportHandy")}
              description={t("settings.about.supportDevelopment.description")}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void openUrl("https://handy.computer/donate")}
              >
                {t("settings.about.supportDevelopment.button")}
              </Button>
            </SettingContainer>
          </SettingsGroup>

          <SettingsGroup title={t("about.folders")} anchor="about-folders">
            <AppDataDirectory grouped />
            <LogDirectory grouped />
          </SettingsGroup>
        </div>
      </div>

      {note && (
        <WhatsNewModal note={note} open onDismiss={() => setNote(null)} />
      )}
    </Page>
  );
};
