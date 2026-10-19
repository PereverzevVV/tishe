import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../../ui/Input";
import { ResetButton } from "../../ui/ResetButton";
import { Textarea } from "../../ui/Textarea";

/** Resolves to false when the value was refused and nothing changed. */
type Commit<T> = (value: T | null) => Promise<boolean>;

/**
 * Fields of the ⚙ «Параметры» windows. Each shows the value in effect — the
 * default when the user changed nothing — never an empty box, and says what
 * the default is. Committing the default (or clearing the field) stores
 * "default" again (`null`), so tuned defaults are never frozen in the file.
 */

const Row: React.FC<{
  label: string;
  hint: string;
  changed: boolean;
  onReset: () => void;
  children: React.ReactNode;
}> = ({ label, hint, changed, onReset, children }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {changed && (
          <ResetButton
            onClick={onReset}
            ariaLabel={t("settings.models.params.resetField")}
          />
        )}
      </div>
      {children}
      <p className="t-type-caption t-text-secondary">{hint}</p>
    </div>
  );
};

export const NumberParam: React.FC<{
  label: string;
  description: string;
  value: number | null;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  onCommit: Commit<number>;
}> = ({
  label,
  description,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  onCommit,
}) => {
  const { t, i18n } = useTranslation();
  const effective = value ?? defaultValue;
  const [text, setText] = useState(String(effective));
  useEffect(() => setText(String(effective)), [effective]);

  const commit = async () => {
    const parsed = Number(text.replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(parsed)) {
      setText(String(effective));
      await onCommit(null);
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setText(String(clamped));
    if (!(await onCommit(clamped === defaultValue ? null : clamped))) {
      setText(String(effective));
    }
  };

  const fmt = (n: number) => n.toLocaleString(i18n.language);
  return (
    <Row
      label={label}
      hint={`${description} ${t("settings.models.params.defaultRange", {
        value: fmt(defaultValue),
        min: fmt(min),
        max: fmt(max),
      })}`}
      changed={value !== null}
      onReset={() => void onCommit(null)}
    >
      <Input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        variant="compact"
        className="w-32"
      />
    </Row>
  );
};

export const SelectParam: React.FC<{
  label: string;
  description: string;
  value: string;
  options: { value: string; label: string }[];
  changed: boolean;
  onSelect: (value: string) => void;
  onReset: () => void;
}> = ({ label, description, value, options, changed, onSelect, onReset }) => (
  <Row label={label} hint={description} changed={changed} onReset={onReset}>
    <select
      value={value}
      onChange={(e) => onSelect(e.target.value)}
      className="t-field"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </Row>
);

/** An instruction: filled with the built-in text until the user edits it. */
export const PromptParam: React.FC<{
  label: string;
  value: string | null;
  defaultValue: string;
  onCommit: Commit<string>;
}> = ({ label, value, defaultValue, onCommit }) => {
  const { t } = useTranslation();
  const effective = value ?? defaultValue;
  const [text, setText] = useState(effective);
  useEffect(() => setText(effective), [effective]);

  const commit = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === defaultValue.trim()) {
      setText(defaultValue);
      await onCommit(null);
    } else if (!(await onCommit(trimmed))) {
      setText(effective);
    }
  };

  return (
    <Row
      label={label}
      hint={
        value === null
          ? t("settings.models.params.prompt.builtIn")
          : t("settings.models.params.prompt.own")
      }
      changed={value !== null}
      onReset={() => void onCommit(null)}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        rows={5}
        className="w-full font-normal"
      />
    </Row>
  );
};
