import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Tooltip (VISUAL_DESIGN_SYSTEM §12.18): inverse surface, caption text, no
 * arrow or border, up to 280 wide, 8 px from the element.
 */
type TooltipPosition = "top" | "bottom" | "right";

interface TooltipProps {
  targetRef: React.RefObject<HTMLElement>;
  position?: TooltipPosition;
  children: React.ReactNode;
}

const GAP = 8;
const EDGE = 8;

export const Tooltip: React.FC<TooltipProps> = ({
  targetRef,
  position = "top",
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  const update = useCallback(() => {
    const target = targetRef.current;
    const tip = ref.current;
    if (!target || !tip) return;
    const t = target.getBoundingClientRect();
    const r = tip.getBoundingClientRect();
    if (position === "right") {
      const top = Math.max(
        EDGE,
        Math.min(
          t.top + t.height / 2 - r.height / 2,
          window.innerHeight - EDGE - r.height,
        ),
      );
      setCoords({ top, left: t.right + GAP });
      return;
    }
    let top = position === "top" ? t.top - GAP - r.height : t.bottom + GAP;
    if (top < EDGE) top = t.bottom + GAP;
    if (top + r.height > window.innerHeight - EDGE)
      top = t.top - GAP - r.height;
    let left = t.left + t.width / 2 - r.width / 2;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - r.width));
    setCoords({ top, left });
  }, [targetRef, position]);

  useEffect(() => {
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [update]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="t-tooltip"
      style={{
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        visibility: coords ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
};

/** Hover/focus tooltip around any element (500 ms on hover, at once on focus). */
export const WithTooltip: React.FC<{
  text: React.ReactNode;
  children: React.ReactElement;
  position?: TooltipPosition;
  /** Take the full width of the parent (e.g. a sidebar item). */
  block?: boolean;
}> = ({ text, children, position, block }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <span
      ref={ref}
      className={block ? "flex" : "inline-flex"}
      onMouseEnter={() => {
        clear();
        timer.current = window.setTimeout(() => setShow(true), 500);
      }}
      onMouseLeave={() => {
        clear();
        setShow(false);
      }}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      onKeyDown={(e) => e.key === "Escape" && setShow(false)}
    >
      {children}
      {show && (
        <Tooltip targetRef={ref} position={position}>
          {text}
        </Tooltip>
      )}
    </span>
  );
};
