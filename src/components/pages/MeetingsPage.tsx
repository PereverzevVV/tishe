import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigationStore } from "@/stores/navigationStore";
import { Page } from "../shell/Page";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Badge";

/**
 * «Встречи · скоро» (UX_INTERACTION_ARCHITECTURE S3, the «Скоро» pattern):
 * an honest page in the place where meeting recording will live, with what
 * works today. No dates (owner, 2026-10-08). Reference template: paragraphs
 * up to 560 px, one secondary button.
 */
export const MeetingsPage: React.FC = () => {
  const { t } = useTranslation();
  const open = useNavigationStore((s) => s.open);

  return (
    <Page
      section="meetings"
      title={
        <span className="inline-flex items-center gap-2">
          {t("sidebar.meetings")}
          <Tag>{t("sidebar.soon")}</Tag>
        </span>
      }
    >
      <div className="t-type-prose max-w-[560px]">
        <p>{t("meetings.what")}</p>
        <p className="mt-3 t-text-secondary">{t("meetings.how")}</p>
        <h2 className="t-group-title mt-8">{t("meetings.nowTitle")}</h2>
        <p className="t-text-secondary">{t("meetings.nowText")}</p>
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => open("transcription")}
        >
          {t("meetings.goTranscription")}
        </Button>
      </div>
    </Page>
  );
};
