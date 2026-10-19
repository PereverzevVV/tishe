import type { AppSettings } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * Whether a setting differs from its default, and how to put the default
 * back — the «изменено» mark and reset of a row inside a fold
 * (UX_INTERACTION_ARCHITECTURE, Progressive Disclosure, rule 3).
 */
export const useSettingChange = (
  key?: keyof AppSettings,
): { changed: boolean; reset?: () => void } => {
  const settings = useSettingsStore((s) => s.settings);
  const defaults = useSettingsStore((s) => s.defaultSettings);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  if (!key || !settings || !defaults) return { changed: false };
  const value = settings[key];
  const fallback = defaults[key];
  if (value === undefined || fallback === undefined) return { changed: false };
  const changed = JSON.stringify(value) !== JSON.stringify(fallback);
  return {
    changed,
    reset: changed ? () => void updateSetting(key, fallback) : undefined,
  };
};
