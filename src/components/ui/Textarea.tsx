import React from "react";

/** Multi-line field (§12.2): min 96 high, grows only vertically. */
interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: "default" | "compact";
}

export const Textarea: React.FC<TextareaProps> = ({
  className = "",
  variant: _variant,
  ...props
}) => <textarea className={`t-field ${className}`} {...props} />;
