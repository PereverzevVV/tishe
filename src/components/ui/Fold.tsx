import React, { createContext, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { useNavigationStore } from "@/stores/navigationStore";

/**
 * Fold («Дополнительно», «Если что-то не работает»; VISUAL_DESIGN_SYSTEM
 * §12.17). A heading, not a container: no border or fill. It remembers its
 * state between visits and launches, and shows «изменено: N» when settings
 * inside differ from their defaults.
 */
/**
 * Rows inside a fold show «изменено» and a reset when their value differs
 * from the default (Progressive Disclosure, rule 3); rows on the open page
 * do not, the value there is in sight.
 */
export const InFoldContext = createContext(false);

interface FoldProps {
  /** Storage key; also used by deep links (`DeepLink.fold`). */
  id: string;
  title: React.ReactNode;
  /** How many settings inside differ from the default. */
  changed?: number;
  children: React.ReactNode;
}

export const Fold: React.FC<FoldProps> = ({
  id,
  title,
  changed = 0,
  children,
}) => {
  const { t } = useTranslation();
  const open = useNavigationStore((s) => !!s.folds[id]);
  const setFold = useNavigationStore((s) => s.setFold);
  const bodyId = useId();
  const innerRef = useRef<HTMLDivElement>(null);
  // A closed fold keeps its content out of the tab order (React 18 has no
  // typed `inert` prop, so the attribute is set directly).
  useEffect(() => {
    innerRef.current?.toggleAttribute("inert", !open);
  }, [open]);
  const changedText =
    changed > 0 ? t("ui.fold.changed", { count: changed }) : "";

  return (
    <section className="t-fold" data-fold={id}>
      <button
        type="button"
        className="t-fold-head"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={
          changed > 0
            ? `${typeof title === "string" ? title : ""}, ${t("ui.fold.changedA11y", { count: changed })}`
            : undefined
        }
        onClick={() => setFold(id, !open)}
      >
        <ChevronRight aria-hidden="true" />
        <span>{title}</span>
        {changed > 0 && <span className="t-fold-count">{changedText}</span>}
      </button>
      <div className="t-fold-body" data-open={open} id={bodyId}>
        <div className="t-fold-inner" ref={innerRef}>
          <div className="t-fold-content">
            <InFoldContext.Provider value={true}>
              {children}
            </InFoldContext.Provider>
          </div>
        </div>
      </div>
    </section>
  );
};
