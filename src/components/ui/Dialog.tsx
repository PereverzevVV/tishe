import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface DialogProps {
  open: boolean;
  title: React.ReactNode;
  children: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  closeLabel: string;
  dismissible?: boolean;
  closeOnBackdrop?: boolean;
  showCloseButton?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement>;
  className?: string;
  contentClassName?: string;
  contentFades?: boolean;
  /** 400 for confirmations, 560 for parameters, editors, «Что нового» (§12.10). */
  size?: "narrow" | "wide";
  /** Confirmation of an irreversible action: role alertdialog. */
  alert?: boolean;
}

const isVisible = (element: HTMLElement) => {
  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
};

const getFocusableElements = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      isVisible(element),
  );

export const Dialog: React.FC<DialogProps> = ({
  open,
  title,
  children,
  onOpenChange,
  description,
  footer,
  closeLabel,
  dismissible = true,
  closeOnBackdrop = true,
  showCloseButton = true,
  initialFocusRef,
  className = "",
  contentClassName = "",
  contentFades: _contentFades = false,
  size = "wide",
  alert = false,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusDialog = () => {
      const fallback = contentRef.current;
      const target = initialFocusRef?.current ?? fallback;
      target?.focus();
    };

    const animationFrame = requestAnimationFrame(focusDialog);

    return () => {
      cancelAnimationFrame(animationFrame);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onOpenChange(false);
        return;
      }

      if (event.key !== "Tab" || !contentRef.current) return;

      const focusableElements = getFocusableElements(contentRef.current);
      if (focusableElements.length === 0) {
        event.preventDefault();
        contentRef.current.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (activeElement === contentRef.current) {
        event.preventDefault();
        if (event.shiftKey) {
          lastElement.focus();
        } else {
          firstElement.focus();
        }
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissible, onOpenChange, open]);

  if (!open) return null;

  const handleBackdropMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (
      dismissible &&
      closeOnBackdrop &&
      event.target === event.currentTarget
    ) {
      onOpenChange(false);
    }
  };
  return createPortal(
    <div className="t-scrim" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={contentRef}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`t-dialog ${size === "wide" ? "t-dialog-wide" : ""} ${className}`}
      >
        <div className="t-dialog-head">
          <div className="min-w-0">
            <h2 id={titleId} className="t-dialog-title">
              {title}
            </h2>
            {description && (
              <div id={descriptionId} className="t-dialog-desc">
                {description}
              </div>
            )}
          </div>
          {dismissible && showCloseButton && (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={closeLabel}
              title={closeLabel}
              className="t-btn t-btn-quiet t-btn-sm t-btn-icon"
            >
              <X aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={`t-dialog-body ${contentClassName}`}>{children}</div>
        {footer ? (
          <div className="t-dialog-foot">{footer}</div>
        ) : (
          <div className="h-6 flex-none" aria-hidden="true" />
        )}
      </div>
    </div>,
    document.body,
  );
};
