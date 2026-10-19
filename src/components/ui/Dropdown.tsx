import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Menu } from "./Menu";

/**
 * Dropdown list (VISUAL_DESIGN_SYSTEM §12.3): looks like a field, 32 high,
 * chevron 16 tertiary; the open list is the Menu component with a check on
 * the selected option and a search field above more than 10 options.
 */
export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface DropdownProps {
  options: DropdownOption[];
  className?: string;
  menuClassName?: string;
  selectedValue: string | null;
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onOpen?: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Stretch to the row width (stacked rows). */
  wide?: boolean;
  id?: string;
}

const SEARCH_FROM = 11;

export const Dropdown: React.FC<DropdownProps> = ({
  options,
  selectedValue,
  onSelect,
  className = "",
  placeholder,
  disabled = false,
  onOpen,
  ariaLabel,
  ariaLabelledBy,
  wide = false,
  id,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.value === selectedValue);
  const searchable = options.length >= SEARCH_FROM;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`t-select ${wide ? "t-select-wide" : ""} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        title={selected?.label}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            onOpen?.();
            setOpen(true);
          }
        }}
      >
        <span className={selected ? "" : "t-placeholder"}>
          {selected?.label ?? placeholder ?? t("common.choose")}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      <Menu
        anchor={triggerRef.current}
        open={open && !disabled}
        onClose={close}
        role="listbox"
        checkable
        minWidth={triggerRef.current?.offsetWidth}
        emptyText={t("common.noOptionsFound")}
        header={
          searchable ? (
            <div className="t-menu-search">
              <input
                autoFocus
                className="t-field t-field-sm w-full"
                value={query}
                placeholder={t("common.search")}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : undefined
        }
        items={visible.map((o) => ({
          value: o.value,
          label: o.label,
          description: o.description,
          disabled: o.disabled,
          selected: o.value === selectedValue,
          onSelect: () => onSelect(o.value),
        }))}
      />
    </>
  );
};
