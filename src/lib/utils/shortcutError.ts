import type { TFunction } from "i18next";

/**
 * A key that could not be set, in words a person understands (S2): taken by
 * another program (Windows refused the system shortcut), already used by
 * another action here, or anything else with the raw reason.
 */
export const shortcutErrorText = (error: unknown, t: TFunction): string => {
  const raw = String(error);
  if (/already registered/i.test(raw))
    return t("settings.general.shortcut.errors.taken");
  if (/already in use/i.test(raw))
    return t("settings.general.shortcut.errors.duplicate");
  return t("settings.general.shortcut.errors.set", { error: raw });
};
