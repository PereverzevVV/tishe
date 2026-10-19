import React, { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { SettingContainer } from "./SettingContainer";
import { ResetButton } from "./ResetButton";

/**
 * Numeric setting (VISUAL_DESIGN_SYSTEM §12.2 «Число», VD-81): a 32 field
 * with the unit inside the row, the range and default in the hint. The value
 * applies on leaving the field or Enter; a value out of range is not applied
 * and is shown as a field error.
 */
interface NumberFieldProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  defaultValue?: number;
  disabled?: boolean;
  dependent?: boolean;
  anchor?: string;
  grouped?: boolean;
}

export const NumberField: React.FC<NumberFieldProps> = ({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  defaultValue,
  disabled = false,
  dependent,
  anchor,
  grouped = true,
}) => {
  const { t } = useTranslation();
  const id = useId();
  const errId = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);

  const commit = () => {
    const parsed = Number(draft.replace(",", "."));
    if (draft.trim() === "" || Number.isNaN(parsed)) {
      setError(t("ui.number.notNumber"));
      return;
    }
    if (parsed < min || parsed > max) {
      setError(t("ui.number.range", { min, max }));
      return;
    }
    setError(null);
    if (parsed !== value) onChange(parsed);
  };

  const hint =
    defaultValue !== undefined
      ? t("ui.number.hintDefault", { value: defaultValue, min, max })
      : t("ui.number.hint", { min, max });

  return (
    <SettingContainer
      title={label}
      description={description}
      disabled={disabled}
      dependent={dependent}
      anchor={anchor}
      controlId={id}
      grouped={grouped}
      changed={defaultValue !== undefined && value !== defaultValue}
      ownReset
      extra={
        error ? (
          <div className="t-field-error" id={errId}>
            <CircleAlert width={14} height={14} aria-hidden="true" />
            {error}
          </div>
        ) : (
          <div className="t-field-hint">{hint}</div>
        )
      }
    >
      <input
        id={id}
        className="t-field t-field-number"
        inputMode="decimal"
        value={draft}
        step={step}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(String(value));
            setError(null);
          }
        }}
      />
      {unit && <span className="t-field-unit">{unit}</span>}
      {defaultValue !== undefined && value !== defaultValue && (
        <ResetButton
          onClick={() => onChange(defaultValue)}
          disabled={disabled}
        />
      )}
    </SettingContainer>
  );
};
