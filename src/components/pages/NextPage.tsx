import React from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Page } from "../shell/Page";
import { Button } from "../ui/Button";
import { TISHE_REPO_URL } from "@/lib/release";

/** Next versions, in the planned order (product concept §13, step 2). */
const PLAN = ["meetings", "summaries", "search", "agents"] as const;

/**
 * «Что дальше» (release plan, item 3): what Tishe and Private Memory are, and
 * what the next versions bring — instead of buttons for features that do not
 * exist yet. No dates (owner, 2026-10-08). Reference template: paragraphs up
 * to 560 px, secondary buttons only.
 */
export const NextPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <Page section="next" title={t("sidebar.next")}>
      <div className="t-work t-wide">
        <div className="t-work-main">
          <div className="t-type-prose max-w-[560px]">
            <p>{t("next.lead")}</p>
            <p className="mt-3 t-text-secondary">{t("next.now")}</p>

            <h2 className="t-group-title mt-8">{t("next.planTitle")}</h2>
            <ol className="mt-2 list-decimal space-y-3 pl-5">
              {PLAN.map((id) => (
                <li key={id}>
                  <span className="font-semibold">
                    {t(`next.plan.${id}.title`)}
                  </span>
                  <span className="t-text-secondary">
                    {" — "}
                    {t(`next.plan.${id}.text`)}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-3 t-text-secondary">{t("next.order")}</p>
          </div>
        </div>

        <div className="t-work-side">
          <div className="t-next-free t-type-prose max-w-[560px]">
            <h2 className="t-group-title">{t("next.freeTitle")}</h2>
            <p className="t-text-secondary">{t("next.freeText")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => void openUrl(TISHE_REPO_URL)}
              >
                {t("next.follow")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void openUrl(`${TISHE_REPO_URL}/issues`)}
              >
                {t("next.feedback")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
};
