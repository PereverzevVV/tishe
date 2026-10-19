import React from "react";
import { LoaderCircle } from "lucide-react";

/** Waiting indicator (§12.24): a ¾ ring, tertiary, one turn per second. */
export const Spinner: React.FC<{ size?: number; className?: string }> = ({
  size = 14,
  className = "",
}) => (
  <LoaderCircle
    width={size}
    height={size}
    className={`t-spinner ${className}`}
    aria-hidden="true"
  />
);
