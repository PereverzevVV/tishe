import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

/**
 * Popup menu (VISUAL_DESIGN_SYSTEM §12.9): raised surface, radius 10,
 * padding 4, shadow e2, items 32 high. Used by «⋯» buttons, the model chip in
 * the status bar and the dropdown list.
 */

export interface MenuItem {
  /** Stable key; also the value reported by a dropdown. */
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  /** Marked with a check, not a fill (§12.9). */
  selected?: boolean;
  /** Red text; always last, after a separator. */
  danger?: boolean;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
  /** Small heading above this item. */
  group?: string;
  onSelect?: () => void;
}

interface MenuProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: (reason: "select" | "dismiss") => void;
  items: MenuItem[];
  /** Show check marks column (dropdowns). */
  checkable?: boolean;
  /** Placement relative to the anchor. */
  placement?: "below" | "above";
  align?: "start" | "end";
  /** Optional content above the items, e.g. a search field. */
  header?: React.ReactNode;
  emptyText?: React.ReactNode;
  minWidth?: number;
  role?: "menu" | "listbox";
  ariaLabel?: string;
}

const GAP = 4;
const EDGE = 8;

export const Menu: React.FC<MenuProps> = ({
  anchor,
  open,
  onClose,
  items,
  checkable = false,
  placement = "below",
  align = "start",
  header,
  emptyText,
  minWidth,
  role = "menu",
  ariaLabel,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState<number>(-1);

  const enabledIndexes = items
    .map((item, i) => (item.disabled ? -1 : i))
    .filter((i) => i >= 0);

  const place = useCallback(() => {
    if (!anchor || !menuRef.current) return;
    const a = anchor.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const roomBelow = window.innerHeight - a.bottom - GAP - EDGE;
    const roomAbove = a.top - GAP - EDGE;
    const goAbove =
      placement === "above"
        ? roomAbove >= m.height || roomAbove > roomBelow
        : roomBelow < m.height && roomAbove > roomBelow;
    let top = goAbove ? a.top - GAP - m.height : a.bottom + GAP;
    top = Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - m.height));
    let left = align === "end" ? a.right - m.width : a.left;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - m.width));
    setPos({ top, left });
  }, [anchor, placement, align]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place, items.length]);

  useEffect(() => {
    if (!open) return;
    const selected = items.findIndex((i) => i.selected && !i.disabled);
    setActive(selected >= 0 ? selected : -1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose("dismiss");
    };
    const onResize = () => onClose("dismiss");
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose("dismiss");
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, anchor, onClose]);

  // Keep the keyboard-active item visible.
  useEffect(() => {
    if (!open || active < 0) return;
    const el = menuRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose("dismiss");
        anchor?.focus();
        return;
      }
      if (e.key === "Tab") {
        onClose("dismiss");
        return;
      }
      if (enabledIndexes.length === 0) return;
      const pos = enabledIndexes.indexOf(active);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(enabledIndexes[(pos + 1) % enabledIndexes.length]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(
          enabledIndexes[
            pos <= 0
              ? enabledIndexes.length - 1
              : (pos - 1) % enabledIndexes.length
          ],
        );
      } else if (e.key === "Home") {
        e.preventDefault();
        setActive(enabledIndexes[0]);
      } else if (e.key === "End") {
        e.preventDefault();
        setActive(enabledIndexes[enabledIndexes.length - 1]);
      } else if (e.key === "Enter" || e.key === " ") {
        // Let a focused text field (search) keep the space key.
        if (e.key === " " && e.target instanceof HTMLInputElement) return;
        if (active >= 0) {
          e.preventDefault();
          const item = items[active];
          item.onSelect?.();
          onClose("select");
          anchor?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, active, enabledIndexes, items, onClose, anchor]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="t-menu"
      role={role}
      aria-label={ariaLabel}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        minWidth: Math.max(minWidth ?? 0, 180),
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {header}
      {items.length === 0 && emptyText && (
        <div className="t-menu-empty">{emptyText}</div>
      )}
      {items.map((item, i) => (
        <React.Fragment key={item.value}>
          {item.separatorBefore && <div className="t-menu-sep" role="none" />}
          {item.group && <div className="t-menu-group">{item.group}</div>}
          <button
            type="button"
            data-index={i}
            data-active={i === active}
            role={role === "listbox" ? "option" : "menuitem"}
            aria-selected={role === "listbox" ? !!item.selected : undefined}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            className={`t-menu-item ${item.danger ? "t-menu-item-danger" : ""}`}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose("select");
              anchor?.focus();
            }}
          >
            {checkable && (
              <span className="t-menu-check" aria-hidden="true">
                {item.selected && <Check width={16} height={16} />}
              </span>
            )}
            <span className="t-menu-text">
              <span>{item.label}</span>
              {item.description && (
                <span className="t-menu-desc">{item.description}</span>
              )}
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
};

/** A «⋯»-style trigger plus its menu. */
export const useMenu = () => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { open, setOpen, close, toggle, anchorRef };
};
