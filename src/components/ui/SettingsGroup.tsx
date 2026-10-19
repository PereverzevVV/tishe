import React, { useId } from "react";

/**
 * Settings group (§12.14): a caption title and a grey container without a
 * border; rows inside are separated by lines that start at the text edge.
 */
interface SettingsGroupProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Deep-link target id (navigation store). */
  anchor?: string;
  className?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  children,
  anchor,
  className = "",
}) => {
  const titleId = useId();
  return (
    <section
      className={`t-group-block ${className}`}
      data-anchor={anchor}
      aria-labelledby={title ? titleId : undefined}
    >
      {title && (
        <h2 className="t-group-title" id={titleId} tabIndex={-1}>
          {title}
        </h2>
      )}
      {description && <p className="t-group-desc">{description}</p>}
      <div className="t-group">{children}</div>
    </section>
  );
};
