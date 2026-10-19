import React from "react";
import SelectComponent from "react-select";
import CreatableSelect from "react-select/creatable";
import type {
  ActionMeta,
  Props as ReactSelectProps,
  SingleValue,
  StylesConfig,
} from "react-select";

export type SelectOption = {
  value: string;
  label: string;
  isDisabled?: boolean;
};

type BaseProps = {
  value: string | null;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  isClearable?: boolean;
  onChange: (value: string | null, action: ActionMeta<SelectOption>) => void;
  onBlur?: () => void;
  className?: string;
  formatCreateLabel?: (input: string) => string;
};

type CreatableProps = {
  isCreatable: true;
  onCreateOption: (value: string) => void;
};

type NonCreatableProps = {
  isCreatable?: false;
  onCreateOption?: never;
};

export type SelectProps = BaseProps & (CreatableProps | NonCreatableProps);

// react-select styled as the Tishe field and menu (§12.2, §12.3, §12.9).
const selectStyles: StylesConfig<SelectOption, false> = {
  control: (base, state) => ({
    ...base,
    minHeight: 32,
    height: 32,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: state.isDisabled
      ? "var(--t-separator)"
      : "var(--t-border-control)",
    boxShadow: state.isFocused ? "0 0 0 2px var(--t-accent)" : "none",
    backgroundColor: state.isDisabled
      ? "var(--t-overlay-hover)"
      : "var(--t-bg-field)",
    fontSize: 14,
    color: "var(--t-text-primary)",
    transition: "border-color 100ms cubic-bezier(0.2, 0, 0, 1)",
    ":hover": {
      borderColor: "var(--t-border-control-hover)",
    },
  }),
  valueContainer: (base) => ({
    ...base,
    paddingInline: 12,
    paddingBlock: 0,
  }),
  indicatorsContainer: (base) => ({ ...base, height: 30 }),
  indicatorSeparator: () => ({ display: "none" }),
  input: (base) => ({
    ...base,
    margin: 0,
    padding: 0,
    color: "var(--t-text-primary)",
  }),
  singleValue: (base, state) => ({
    ...base,
    color: state.isDisabled
      ? "var(--t-text-disabled)"
      : "var(--t-text-primary)",
  }),
  dropdownIndicator: (base) => ({
    ...base,
    padding: "0 8px",
    color: "var(--t-text-tertiary)",
    ":hover": { color: "var(--t-text-tertiary)" },
  }),
  clearIndicator: (base) => ({
    ...base,
    padding: "0 4px",
    color: "var(--t-text-tertiary)",
    ":hover": { color: "var(--t-text-primary)" },
  }),
  loadingIndicator: (base) => ({ ...base, color: "var(--t-text-tertiary)" }),
  menuPortal: (base) => ({ ...base, zIndex: 200 }),
  menu: (provided) => ({
    ...provided,
    zIndex: 200,
    marginTop: 4,
    backgroundColor: "var(--t-bg-raised)",
    color: "var(--t-text-primary)",
    border: "none",
    borderRadius: 10,
    boxShadow: "var(--t-shadow-e2)",
  }),
  menuList: (base) => ({ ...base, padding: 4, maxHeight: 312 }),
  option: (base, state) => ({
    ...base,
    minHeight: 32,
    padding: "6px 8px",
    borderRadius: 6,
    fontSize: 14,
    backgroundColor: state.isFocused ? "var(--t-overlay-hover)" : "transparent",
    fontWeight: state.isSelected ? 600 : 400,
    color: state.isDisabled
      ? "var(--t-text-disabled)"
      : "var(--t-text-primary)",
    ":active": { backgroundColor: "var(--t-overlay-pressed)" },
  }),
  placeholder: (base) => ({
    ...base,
    color: "var(--t-text-tertiary)",
  }),
  noOptionsMessage: (base) => ({
    ...base,
    fontSize: 12,
    color: "var(--t-text-secondary)",
  }),
};

export const Select: React.FC<SelectProps> = React.memo(
  ({
    value,
    options,
    placeholder,
    disabled,
    isLoading,
    isClearable = true,
    onChange,
    onBlur,
    className = "",
    isCreatable,
    formatCreateLabel,
    onCreateOption,
  }) => {
    const selectValue = React.useMemo(() => {
      if (!value) return null;
      const existing = options.find((option) => option.value === value);
      if (existing) return existing;
      return { value, label: value, isDisabled: false };
    }, [value, options]);

    const handleChange = (
      option: SingleValue<SelectOption>,
      action: ActionMeta<SelectOption>,
    ) => {
      onChange(option?.value ?? null, action);
    };

    const sharedProps: Partial<ReactSelectProps<SelectOption, false>> = {
      className,
      classNamePrefix: "app-select",
      value: selectValue,
      options,
      onChange: handleChange,
      placeholder,
      isDisabled: disabled,
      isLoading,
      onBlur,
      isClearable,
      styles: selectStyles,
    };

    if (isCreatable) {
      return (
        <CreatableSelect<SelectOption, false>
          {...sharedProps}
          onCreateOption={onCreateOption}
          formatCreateLabel={formatCreateLabel}
        />
      );
    }

    return <SelectComponent<SelectOption, false> {...sharedProps} />;
  },
);

Select.displayName = "Select";
