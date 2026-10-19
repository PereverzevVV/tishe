import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import {
  LOCAL_PROVIDER_ID,
  llmReadiness,
  useLlmStore,
} from "@/stores/llmStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { TextLink } from "../ui/TextLink";
import {
  llmNextStep,
  useLlmModelLabel,
  useRecommendedLlm,
} from "../pages/shared";

/**
 * «Для редактуры нужна нейросеть». Turning on editing (files) or the second
 * dictation key while the LLM is not ready opens this dialog instead of
 * switching on into a red line: it says what is missing and offers the way
 * that removes it — download the recommended model here, switch to a local
 * model already on disk, or set up a server or a service on «Редактура». A
 * ready LLM, or one still downloading, turns the switch on at once. What to
 * offer comes from `llmNextStep`, shared with «Быстрый старт» and the start
 * panel.
 */

export const useLlmGate = () => {
  const { settings } = useSettings();
  const llm = useLlmStore();
  const [pending, setPending] = useState<(() => void) | null>(null);

  const request = (enable: () => void) => {
    const { step } = llmNextStep(settings, llm);
    if (step === "ready" || step === "downloading") enable();
    else setPending(() => enable);
  };

  const dialog = (
    <LlmSetupDialog enable={pending} onClose={() => setPending(null)} />
  );
  return { request, dialog };
};

const LlmSetupDialog: React.FC<{
  enable: (() => void) | null;
  onClose: () => void;
}> = ({ enable, onClose }) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const llm = useLlmStore();
  const link = useNavigationStore((s) => s.link);
  const recommended = useRecommendedLlm();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const r = llmReadiness(settings, llm);
  const { step: need, onDisk } = llmNextStep(settings, llm);
  const onDiskName = useLlmModelLabel(onDisk ?? "", LOCAL_PROVIDER_ID);
  const reason =
    r.problem === "noKey"
      ? t("ui.llm.noKey", { provider: r.providerLabel })
      : r.problem === "noUrl"
        ? t("ui.llm.noUrl")
        : t("ui.llm.noServerModel");

  const toLlmPage = () => {
    onClose();
    link("llm", { target: "llm-where" });
  };

  let body: React.ReactNode;
  let actions: React.ReactNode;
  if (need === "download") {
    body = (
      <>
        <p className="t-text-secondary">{t("setup.llm.what")}</p>
        <div className="t-callout flex flex-col gap-1">
          <span className="font-semibold">{recommended.name}</span>
          <span className="t-type-caption t-text-secondary">
            {t("setup.llm.recommended", {
              size: recommended.size,
              ram: recommended.ramGb,
            })}
          </span>
        </div>
        <div>
          <TextLink onClick={toLlmPage}>{t("setup.llm.otherWays")}</TextLink>
        </div>
      </>
    );
    actions = (
      <>
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          ref={primaryRef}
          variant="primary"
          disabled={!recommended.available}
          onClick={() => {
            enable?.();
            onClose();
            void recommended.download();
          }}
        >
          {t("setup.llm.downloadOn", { size: recommended.size })}
        </Button>
      </>
    );
  } else if (need === "useLocal") {
    body = (
      <>
        <p className="t-text-secondary">{t("setup.llm.what")}</p>
        <div className="t-callout flex flex-col gap-1">
          <span className="font-semibold">{onDiskName}</span>
          <span className="t-type-caption t-text-secondary">
            {t("setup.llm.onDisk")}
          </span>
        </div>
        <div>
          <TextLink onClick={toLlmPage}>{t("setup.llm.otherWays")}</TextLink>
        </div>
      </>
    );
    actions = (
      <>
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          ref={primaryRef}
          variant="primary"
          onClick={() => {
            onClose();
            if (onDisk)
              void recommended.useLocal(onDisk).then(() => enable?.());
          }}
        >
          {t("setup.llm.turnOn")}
        </Button>
      </>
    );
  } else if (need === "runtime") {
    body = <p className="t-text-secondary">{t("setup.llm.runtime")}</p>;
    actions = (
      <>
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button ref={primaryRef} variant="primary" onClick={toLlmPage}>
          {t("setup.llm.openPage")}
        </Button>
      </>
    );
  } else {
    body = (
      <p className="t-text-secondary">{t("setup.llm.notSetUp", { reason })}</p>
    );
    actions = (
      <>
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          ref={primaryRef}
          variant="primary"
          onClick={() => {
            enable?.();
            toLlmPage();
          }}
        >
          {t("setup.llm.onAndSetUp")}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={enable !== null}
      size="narrow"
      title={
        need === "runtime" ? t("setup.llm.runtimeTitle") : t("setup.llm.title")
      }
      closeLabel={t("common.close")}
      onOpenChange={(next) => !next && onClose()}
      initialFocusRef={primaryRef as React.RefObject<HTMLElement>}
      footer={actions}
    >
      <div className="flex flex-col gap-3">{body}</div>
    </Dialog>
  );
};
