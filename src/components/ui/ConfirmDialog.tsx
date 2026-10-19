import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "./Dialog";
import { Button } from "./Button";

/**
 * Confirmation of an irreversible or expensive action (VISUAL_DESIGN_SYSTEM
 * §12.10, UX_INTERACTION_ARCHITECTURE «Destructive Actions»): 400 wide, the
 * title names the object, the body names the consequence, the red button
 * names the verb. Focus starts on the safe button so a stray Enter does
 * nothing irreversible.
 */
interface ConfirmDialogProps {
  open: boolean;
  title: React.ReactNode;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      size="narrow"
      alert
      title={title}
      closeLabel={t("common.close")}
      showCloseButton={false}
      onOpenChange={(next) => !next && onCancel()}
      initialFocusRef={cancelRef as React.RefObject<HTMLElement>}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="t-text-secondary">{children}</p>
    </Dialog>
  );
};
