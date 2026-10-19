import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button } from "../ui/Button";
import AccessibilityPermissions from "../AccessibilityPermissions";
import SecureInputWarning from "../SecureInputWarning";
import { useNavigationStore, type SectionId } from "@/stores/navigationStore";
import { DropOverlay } from "./DropOverlay";

/**
 * Page template (VISUAL_DESIGN_SYSTEM §7.4–7.5, §12.12): a scrolling field
 * with a centred 640 px column (on a wide window a wider page whose text
 * blocks keep 640 and whose `.t-wide` blocks use the width, VD-86), the page
 * title, an optional purpose line and,
 * for «Расшифровка», a panel pinned under the scroll area.
 *
 * It also keeps the section's scroll position for this run of the program and
 * reveals a deep-link target: scroll to the top third, highlight for 1.5 s,
 * focus the group title.
 */
interface PageProps {
  section: SectionId;
  title: React.ReactNode;
  purpose?: React.ReactNode;
  /** Pinned panel under the scroll area (only «Расшифровка»). */
  panel?: React.ReactNode;
  children: React.ReactNode;
  /** Extra layer over the page, e.g. the drop target. */
  overlay?: React.ReactNode;
  /** Drag-and-drop handlers etc. on the page root. */
  rootProps?: React.HTMLAttributes<HTMLDivElement>;
}

export const SECTION_TITLE_KEY: Record<SectionId, string> = {
  transcription: "sidebar.transcription",
  dictation: "sidebar.dictation",
  meetings: "sidebar.meetings",
  history: "sidebar.history",
  models: "sidebar.models",
  llm: "sidebar.llm",
  app: "sidebar.app",
  next: "sidebar.next",
  about: "sidebar.about",
  debug: "sidebar.debug",
};

const reveal = (root: HTMLElement, scroller: HTMLElement, target: string) => {
  const el = root.querySelector<HTMLElement>(`[data-anchor="${target}"]`);
  if (!el) return;
  const top =
    el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop;
  scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 6);
  const surface = el.querySelector<HTMLElement>(".t-group") ?? el;
  surface.classList.remove("t-highlight");
  // Restart the animation when the same target is opened twice.
  void surface.offsetWidth;
  surface.classList.add("t-highlight");
  window.setTimeout(() => surface.classList.remove("t-highlight"), 1600);
  const heading = el.querySelector<HTMLElement>(".t-group-title") ?? el;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
};

export const Page: React.FC<PageProps> = ({
  section,
  title,
  purpose,
  panel,
  children,
  overlay,
  rootProps,
}) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const colRef = useRef<HTMLDivElement>(null);
  const back = useNavigationStore((s) => s.back);
  const pending = useNavigationStore((s) => s.pending);
  const goBack = useNavigationStore((s) => s.goBack);
  const rememberScroll = useNavigationStore((s) => s.rememberScroll);
  const consumePending = useNavigationStore((s) => s.consumePending);

  // Restore this section's scroll position.
  useLayoutEffect(() => {
    const saved = useNavigationStore.getState().scroll[section] ?? 0;
    if (scrollRef.current) scrollRef.current.scrollTop = saved;
  }, [section]);

  // Reveal a deep-link target once the page (and an opened fold) has laid
  // out. The target is consumed only when it is revealed, so a re-run of the
  // effect (React StrictMode, a quick re-render) does not lose it.
  useEffect(() => {
    if (!pending?.target) return;
    const target = pending.target;
    const timer = window.setTimeout(
      () => {
        consumePending();
        if (colRef.current && scrollRef.current)
          reveal(colRef.current, scrollRef.current, target);
      },
      pending.fold ? 200 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [pending, consumePending]);

  // Two-column blocks on a wide window (VD-86). The shorter column stays in
  // view while the page scrolls, but only when it fits the window: a taller
  // one would hide its own bottom. The main column is at least as tall as
  // the side column, capped at the visible height, so an empty drop zone
  // fills the space beside the recipe without pushing its text off screen.
  useEffect(() => {
    const col = colRef.current;
    const scroller = scrollRef.current;
    if (!col || !scroller || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const wide = window.matchMedia("(min-width: 1280px)").matches;
      const room = scroller.clientHeight - 48;
      col.querySelectorAll<HTMLElement>(".t-work").forEach((work) => {
        const main = work.querySelector<HTMLElement>(":scope > .t-work-main");
        const side = work.querySelector<HTMLElement>(":scope > .t-work-side");
        if (!main || !side) return;
        const top =
          work.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
        const visible = scroller.clientHeight - top - 32;
        const fill = Math.max(0, Math.min(side.offsetHeight, visible));
        work.style.setProperty("--t-work-fill", `${Math.round(fill)}px`);
        const mainH = main.offsetHeight;
        const sideH = side.offsetHeight;
        main.classList.toggle(
          "t-sticky",
          wide && mainH < sideH && mainH <= room,
        );
        side.classList.toggle(
          "t-sticky",
          wide && sideH < mainH && sideH <= room,
        );
      });
    };
    const ro = new ResizeObserver(update);
    ro.observe(col);
    ro.observe(scroller);
    // A fold opening in a short column does not change the page height.
    col
      .querySelectorAll<HTMLElement>(".t-work-main, .t-work-side")
      .forEach((el) => ro.observe(el));
    update();
    return () => ro.disconnect();
  }, []);

  return (
    <div className="t-main" {...rootProps}>
      <div
        ref={scrollRef}
        className="t-scroll"
        onScroll={(e) => rememberScroll(section, e.currentTarget.scrollTop)}
      >
        <div className="t-col" ref={colRef}>
          {back && (
            <Button
              variant="quiet"
              size="sm"
              className="t-back t-text-secondary"
              onClick={goBack}
            >
              <ArrowLeft aria-hidden="true" />
              {t(`ui.back.${back.section}`)}
            </Button>
          )}
          <header className="t-page-head">
            <h1 className="t-page-title">{title}</h1>
            {purpose && <p className="t-page-purpose">{purpose}</p>}
          </header>
          <AccessibilityPermissions />
          <SecureInputWarning />
          {children}
        </div>
      </div>
      {panel && (
        <div className="t-panel">
          <div className="t-panel-inner">{panel}</div>
        </div>
      )}
      {overlay}
      <DropOverlay />
    </div>
  );
};
