import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettings } from "../../hooks/useSettings";
import {
  TISHE_RELEASE,
  fetchLatestRelease,
  isNewerRelease,
  type LatestRelease,
} from "@/lib/release";

type Answer = "checking" | "upToDate" | "failed" | null;

/**
 * Status-bar part «Вышла версия …» (VISUAL_DESIGN_SYSTEM §12.13: shown only
 * when it says something true). Replaces Handy's self-updater, which would
 * install Handy over Tishe: Tishe asks its own GitHub releases once per start
 * and on «Проверить сейчас» / the tray item, and links to the release page.
 * Off with the «Проверять обновления» setting.
 */
export const ReleaseNotice: React.FC = () => {
  const { t } = useTranslation();
  const { settings, isLoading, updateChecksLocked } = useSettings();
  const enabled =
    !isLoading &&
    updateChecksLocked === false &&
    (settings?.update_checks_enabled ?? false);
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [answer, setAnswer] = useState<Answer>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  const check = useCallback(async (manual: boolean) => {
    if (manual) setAnswer("checking");
    try {
      const found = await fetchLatestRelease();
      const newer =
        found && isNewerRelease(found.release, TISHE_RELEASE) ? found : null;
      setLatest(newer);
      if (manual) setAnswer(newer ? null : "upToDate");
    } catch (error) {
      console.warn("Release check failed:", error);
      if (manual) setAnswer("failed");
    }
    if (manual) {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setAnswer(null), 4000);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLatest(null);
      setAnswer(null);
      return;
    }
    void check(false);
    const unlisten = listen("check-for-updates", () => void check(true));
    return () => {
      clearTimeout(hideTimer.current);
      void unlisten.then((fn) => fn());
    };
  }, [enabled, check]);

  if (!enabled) return null;
  if (latest)
    return (
      <button
        type="button"
        className="t-status-part"
        title={t("release.openPage")}
        onClick={() => void openUrl(latest.url)}
      >
        {t("release.available", { release: latest.release })}
      </button>
    );
  if (answer === "checking")
    return <span className="t-status-part">{t("footer.checkingUpdates")}</span>;
  if (answer === "upToDate")
    return <span className="t-status-part">{t("release.upToDate")}</span>;
  if (answer === "failed")
    return <span className="t-status-part">{t("release.checkFailed")}</span>;
  return null;
};
