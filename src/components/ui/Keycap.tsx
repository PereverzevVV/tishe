import React from "react";

/** Key (VISUAL_DESIGN_SYSTEM §12.20): one keycap per key, joined with «+». */
export const Keycaps: React.FC<{ combo: string; className?: string }> = ({
  combo,
  className = "",
}) => {
  const keys = combo
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean);
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {keys.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          {i > 0 && <span aria-hidden="true">+</span>}
          <span className="t-keycap">{k}</span>
        </React.Fragment>
      ))}
    </span>
  );
};
