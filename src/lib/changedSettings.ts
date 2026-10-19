import type { AppSettings } from "@/bindings";

/**
 * How many of the given settings differ from their defaults — the
 * «изменено: N» counter of a fold (UX_INTERACTION_ARCHITECTURE, Progressive
 * Disclosure, rule 3).
 */
export const countChanged = (
  settings: AppSettings | null,
  defaults: AppSettings | null,
  keys: (keyof AppSettings)[],
): number => {
  if (!settings || !defaults) return 0;
  return keys.filter((key) => {
    const a = settings[key];
    const b = defaults[key];
    if (a === undefined || b === undefined) return false;
    return JSON.stringify(a) !== JSON.stringify(b);
  }).length;
};
