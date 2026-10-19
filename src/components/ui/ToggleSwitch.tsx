import React, { useId } from "react";
import { SettingContainer } from "./SettingContainer";
import { Spinner } from "./Spinner";

/** A bare switch (§12.4): outline when off, grey fill when on. */
export const Switch: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}> = ({
  checked,
  onChange,
  disabled = false,
  busy = false,
  id,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}) =>
  busy ? (
    <span className="flex h-5 w-9 items-center justify-center">
      <Spinner size={12} />
    </span>
  ) : (
    <button
      id={id}
      type="button"
      role="switch"
      className="t-toggle"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  isUpdating?: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  tooltipPosition?: "top" | "bottom";
  /** Service lines under the description. */
  extra?: React.ReactNode;
  dependent?: boolean;
  anchor?: string;
  /** App setting behind the switch: «изменено» and reset inside a fold. */
  settingKey?: React.ComponentProps<typeof SettingContainer>["settingKey"];
  /** Explicit «changed» / reset for values that are not app settings. */
  changed?: boolean;
  onReset?: () => void;
}

/** A setting row whose control is a switch. */
export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  isUpdating = false,
  label,
  description,
  grouped = true,
  extra,
  dependent,
  anchor,
  settingKey,
  changed,
  onReset,
}) => {
  const id = useId();
  return (
    <SettingContainer
      title={label}
      description={description}
      grouped={grouped}
      disabled={disabled}
      extra={extra}
      dependent={dependent}
      anchor={anchor}
      controlId={id}
      settingKey={settingKey}
      changed={changed}
      onReset={onReset}
    >
      <Switch
        id={id}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        busy={isUpdating}
      />
    </SettingContainer>
  );
};
