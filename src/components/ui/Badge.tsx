import React from "react";

/**
 * Tag (VISUAL_DESIGN_SYSTEM §12.19): always neutral. The old colour variants
 * are accepted and ignored — there are no coloured or semantic tags.
 */
interface BadgeProps {
  children: React.ReactNode;
  variant?: "primary" | "success" | "secondary";
  className?: string;
  title?: string;
}

const Badge: React.FC<BadgeProps> = ({ children, className = "", title }) => (
  <span className={`t-tag ${className}`} title={title}>
    {children}
  </span>
);

export const Tag = Badge;
export default Badge;
