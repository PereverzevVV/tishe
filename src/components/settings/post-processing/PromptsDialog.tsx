import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { useSettings } from "../../../hooks/useSettings";
import { Dialog } from "../../ui/Dialog";
import { Dropdown } from "../../ui/Dropdown";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";
import { Button } from "../../ui/Button";

/**
 * «Инструкции для диктовки с редактурой» (UX_INTERACTION_ARCHITECTURE S12,
 * SF8): the library of instructions for the second key. Saving is explicit
 * here (DD-14): a long text should not be saved half-written on blur.
 */
interface PromptsDialogProps {
  open: boolean;
  onClose: () => void;
}

export const PromptsDialog: React.FC<PromptsDialogProps> = ({
  open,
  onClose,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, refreshSettings } = useSettings();
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");

  const prompts = getSetting("post_process_prompts") || [];
  const selectedPromptId = getSetting("post_process_selected_prompt_id") || "";
  const selectedPrompt =
    prompts.find((prompt) => prompt.id === selectedPromptId) || null;

  useEffect(() => {
    if (isCreating) return;
    setDraftName(selectedPrompt?.name ?? "");
    setDraftText(selectedPrompt?.prompt ?? "");
  }, [
    isCreating,
    selectedPromptId,
    selectedPrompt?.name,
    selectedPrompt?.prompt,
  ]);

  const isDirty =
    !!selectedPrompt &&
    (draftName.trim() !== selectedPrompt.name ||
      draftText.trim() !== selectedPrompt.prompt.trim());

  const create = async () => {
    if (!draftName.trim() || !draftText.trim()) return;
    const result = await commands.addPostProcessPrompt(
      draftName.trim(),
      draftText.trim(),
    );
    if (result.status === "ok") {
      await refreshSettings();
      await updateSetting("post_process_selected_prompt_id", result.data.id);
      setIsCreating(false);
    }
  };

  const save = async () => {
    if (!selectedPromptId || !draftName.trim() || !draftText.trim()) return;
    await commands.updatePostProcessPrompt(
      selectedPromptId,
      draftName.trim(),
      draftText.trim(),
    );
    await refreshSettings();
    toast(t("ui.saved"), { duration: 2000 });
  };

  // Deleting is reversible: «Вернуть» brings the instruction back.
  const remove = async () => {
    if (!selectedPrompt) return;
    const removed = selectedPrompt;
    await commands.deletePostProcessPrompt(removed.id);
    await refreshSettings();
    setIsCreating(false);
    toast(t("dictation.prompts.deleted", { name: removed.name }), {
      duration: 6000,
      action: {
        label: t("ui.undo"),
        onClick: async () => {
          const res = await commands.addPostProcessPrompt(
            removed.name,
            removed.prompt,
          );
          if (res.status === "ok") {
            await refreshSettings();
            await updateSetting("post_process_selected_prompt_id", res.data.id);
          }
        },
      },
    });
  };

  const fields = (
    <div className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span>{t("settings.postProcessing.prompts.promptLabel")}</span>
        <Input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder={t(
            "settings.postProcessing.prompts.promptLabelPlaceholder",
          )}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span>{t("settings.postProcessing.prompts.promptInstructions")}</span>
        <Textarea
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder={t(
            "settings.postProcessing.prompts.promptInstructionsPlaceholder",
          )}
          className="min-h-[160px]"
        />
        <span className="t-type-caption t-text-secondary">
          <Trans
            i18nKey="settings.postProcessing.prompts.promptTip"
            components={{ code: <code className="font-mono" /> }}
          />
        </span>
      </label>
    </div>
  );

  return (
    <Dialog
      open={open}
      title={t("dictation.prompts.title")}
      closeLabel={t("common.close")}
      onOpenChange={(next) => !next && onClose()}
      footer={
        isCreating ? (
          <>
            <Button variant="secondary" onClick={() => setIsCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void create()}
              disabled={!draftName.trim() || !draftText.trim()}
            >
              {t("settings.postProcessing.prompts.createPrompt")}
            </Button>
          </>
        ) : (
          <>
            {selectedPrompt && (
              <Button
                variant="quiet"
                className="t-dialog-foot-start"
                onClick={() => void remove()}
                disabled={prompts.length <= 1}
              >
                {t("settings.postProcessing.prompts.deletePrompt")}
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={!isDirty || !draftName.trim() || !draftText.trim()}
            >
              {t("ui.save")}
            </Button>
          </>
        )
      }
    >
      <p className="t-text-secondary">{t("dictation.prompts.intro")}</p>
      {!isCreating && (
        <div className="mt-4 flex items-center gap-2">
          <Dropdown
            className="flex-1"
            wide
            ariaLabel={t("dictation.prompts.current")}
            selectedValue={selectedPromptId || null}
            options={prompts.map((p) => ({ value: p.id, label: p.name }))}
            onSelect={(value) =>
              updateSetting("post_process_selected_prompt_id", value)
            }
            placeholder={
              prompts.length === 0
                ? t("settings.postProcessing.prompts.noPrompts")
                : t("settings.postProcessing.prompts.selectPrompt")
            }
          />
          <Button
            variant="secondary"
            onClick={() => {
              setIsCreating(true);
              setDraftName("");
              setDraftText("");
            }}
          >
            {t("dictation.prompts.create")}
          </Button>
        </div>
      )}
      {(isCreating || selectedPrompt) && fields}
      {!isCreating && !selectedPrompt && (
        <p className="mt-4 t-text-secondary">
          {prompts.length
            ? t("settings.postProcessing.prompts.selectToEdit")
            : t("settings.postProcessing.prompts.createFirst")}
        </p>
      )}
    </Dialog>
  );
};
