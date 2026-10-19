import { useEffect, useState } from "react";

/** Whether a CSS media query matches, kept in sync with the window. */
export const useMediaQuery = (query: string): boolean => {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
};

/**
 * Narrow work area: the sidebar becomes a rail of icons (VISUAL_DESIGN_SYSTEM
 * §7.4). The same width is in tishe.css; at the minimum window size this is
 * a zoom of about 135 % and more.
 */
export const RAIL_QUERY = "(max-width: 519px)";
