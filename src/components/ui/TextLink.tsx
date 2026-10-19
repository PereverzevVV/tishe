import React from "react";

/**
 * Navigation link (VISUAL_DESIGN_SYSTEM §3.3, VD-79): only for going
 * somewhere else — another section, another setting, help, the browser.
 * Primary colour, always underlined. Actions in place are quiet buttons.
 */
export const TextLink: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement>
> = ({ className = "", children, type = "button", ...props }) => (
  <button type={type} className={`t-link ${className}`} {...props}>
    {children}
  </button>
);
