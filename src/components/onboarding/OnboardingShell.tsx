import React from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText, Lock, Mic } from "lucide-react";
import logoUrl from "@/assets/tishe-logo.png";

/**
 * Frame of the first-run screens (VISUAL_DESIGN_SYSTEM VD-87): the step in
 * the middle of the window, not at its top edge, at any window size. On a
 * wide window (≥ 900) a welcome column stands on the left — what Tishe
 * does, the three steps and where the person is — and the step on the right;
 * on a narrow one the welcome shrinks to the logo and «Шаг 2 из 3».
 */

const STEPS = ["permissions", "language", "download"] as const;
export type OnboardingStepId = (typeof STEPS)[number];

export const OnboardingShell: React.FC<{
  /** The current step; none when only permissions are asked again. */
  step?: OnboardingStepId;
  children: React.ReactNode;
}> = ({ step, children }) => {
  const { t } = useTranslation();
  const index = step ? STEPS.indexOf(step) : -1;

  return (
    <div className="t-onb">
      <div className="t-onb-inner">
        <aside className="t-onb-aside">
          <div className="t-onb-brand">
            <img src={logoUrl} alt="" width={32} height={32} />
            <span className="t-type-headline">{t("ui.productName")}</span>
            {step && (
              <span className="t-onb-count t-type-caption t-text-tertiary">
                {t("onboarding.step", { n: index + 1, total: STEPS.length })}
              </span>
            )}
          </div>
          <div className="t-onb-welcome">
            {/* The step's own title is the page heading. */}
            <div className="t-type-display">
              {t("onboarding.welcome.title")}
            </div>
            <p className="t-text-secondary">{t("onboarding.welcome.lead")}</p>
            <ul className="t-onb-features">
              <li>
                <FileText aria-hidden="true" />
                <span>{t("onboarding.welcome.files")}</span>
              </li>
              <li>
                <Mic aria-hidden="true" />
                <span>{t("onboarding.welcome.dictation")}</span>
              </li>
              <li>
                <Lock aria-hidden="true" />
                <span>{t("onboarding.welcome.private")}</span>
              </li>
            </ul>
            {step && (
              <ol
                className="t-onb-steps"
                aria-label={t("onboarding.welcome.stepsLabel")}
              >
                {STEPS.map((id, i) => (
                  <li
                    key={id}
                    data-state={
                      i < index ? "done" : i === index ? "current" : "next"
                    }
                    aria-current={i === index ? "step" : undefined}
                  >
                    <span className="t-onb-step-mark" aria-hidden="true">
                      {i < index ? <Check /> : i + 1}
                    </span>
                    {t(`onboarding.welcome.steps.${id}`)}
                  </li>
                ))}
              </ol>
            )}
            <p className="t-onb-credit t-type-caption t-text-tertiary">
              {t("onboarding.welcome.credit")}
            </p>
          </div>
        </aside>
        <main className="t-onb-main">{children}</main>
      </div>
    </div>
  );
};
