import React from "react";

/** Text field (VISUAL_DESIGN_SYSTEM §12.2): 32 high, 1 px control border. */
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Kept for callers; both variants are 32 high (§8.1). */
  variant?: "default" | "compact";
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", variant: _variant, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={`t-field ${className}`}
      aria-invalid={invalid || undefined}
      {...props}
    />
  ),
);
Input.displayName = "Input";
