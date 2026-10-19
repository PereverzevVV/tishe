import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  Check,
  CircleAlert,
  Copy,
  FolderOpen,
  MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { useSettings } from "@/hooks/useSettings";
import { useNavigationStore } from "@/stores/navigationStore";
import { formatDayGroup, formatTime } from "@/lib/utils/humanize";
import { Page } from "../shell/Page";
import { AudioPlayer, AudioPlayerGroup } from "../ui/AudioPlayer";
import { Button } from "../ui/Button";
import { Menu, useMenu } from "../ui/Menu";
import { Segments } from "../ui/Segments";
import { SettingsGroup } from "../ui/SettingsGroup";
import { ServiceLine } from "../ui/ServiceLine";
import { Spinner } from "../ui/Spinner";
import { Tag } from "../ui/Badge";
import { TextLink } from "../ui/TextLink";
import { Keycaps } from "../ui/Keycap";
import { HistoryLimit } from "../settings/HistoryLimit";
import { RecordingRetentionPeriodSelector } from "../settings/RecordingRetentionPeriod";
import { copyToClipboard } from "../settings/history/clipboard";
import { formatKeyCombination } from "@/lib/utils/keyboard";

/**
 * «История» (UX_INTERACTION_ARCHITECTURE S4): return to what was dictated and
 * copy it. Storage settings sit right here, behind «Изменить» on the line
 * that says how many dictations are kept. Entries are grouped by day.
 */

const PAGE_SIZE = 30;
const UNDO_MS = 6000;
const STORAGE_FOLD = "history-storage";

export const HistoryPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const osType = useOsType();
  const { settings } = useSettings();
  const storageOpen = useNavigationStore((s) => !!s.folds[STORAGE_FOLD]);
  const setFold = useNavigationStore((s) => s.setFold);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);
  // Deletions wait for the «Вернуть» toast to close (Destructive Actions).
  const pendingDeletes = useRef(new Map<number, number>());

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const loadPage = useCallback(async (cursor?: number) => {
    const isFirstPage = cursor === undefined;
    if (!isFirstPage && loadingRef.current) return;
    loadingRef.current = true;
    if (isFirstPage) setLoading(true);
    try {
      const result = await commands.getHistoryEntries(
        cursor ?? null,
        PAGE_SIZE,
      );
      if (result.status === "ok") {
        const { entries: newEntries, has_more } = result.data;
        setEntries((prev) =>
          isFirstPage ? newEntries : [...prev, ...newEntries],
        );
        setHasMore(has_more);
      }
    } catch (error) {
      console.error("Failed to load history entries:", error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  // «Загружаю историю…» only after 300 ms (§10, rule 8).
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), 300);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed[0].isIntersecting) {
          const last = entriesRef.current[entriesRef.current.length - 1];
          if (last) void loadPage(last.id);
        }
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadPage]);

  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const payload: HistoryUpdatePayload = event.payload;
      if (payload.action === "added") {
        setEntries((prev) => [payload.entry, ...prev]);
      } else if (payload.action === "updated") {
        setEntries((prev) =>
          prev.map((e) => (e.id === payload.entry.id ? payload.entry : e)),
        );
      }
      // "deleted" and "toggled" are handled by optimistic updates only.
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Leaving the page commits deletions that are still waiting.
  useEffect(() => {
    const pending = pendingDeletes.current;
    return () => {
      pending.forEach((timer, id) => {
        window.clearTimeout(timer);
        void commands.deleteHistoryEntry(id);
      });
      pending.clear();
    };
  }, []);

  const toggleSaved = async (id: number) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
    );
    try {
      const result = await commands.toggleHistoryEntrySaved(id);
      if (result.status !== "ok") throw new Error(String(result.error));
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
      );
    }
  };

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status === "ok") {
          if (osType === "linux") {
            const fileData = await readFile(result.data);
            const blob = new Blob([fileData], { type: "audio/wav" });
            return URL.createObjectURL(blob);
          }
          return convertFileSrc(result.data, "asset");
        }
        return null;
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  const deleteEntry = (entry: HistoryEntry) => {
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    const timer = window.setTimeout(async () => {
      pendingDeletes.current.delete(entry.id);
      try {
        const result = await commands.deleteHistoryEntry(entry.id);
        if (result.status !== "ok") void loadPage();
      } catch (error) {
        console.error("Failed to delete entry:", error);
        toast.error(t("settings.history.deleteError"));
        void loadPage();
      }
    }, UNDO_MS);
    pendingDeletes.current.set(entry.id, timer);
    toast(t("history.deleted"), {
      duration: UNDO_MS,
      action: {
        label: t("ui.undo"),
        onClick: () => {
          window.clearTimeout(pendingDeletes.current.get(entry.id));
          pendingDeletes.current.delete(entry.id);
          setEntries((prev) =>
            [...prev, entry].sort((a, b) => b.timestamp - a.timestamp),
          );
        },
      },
    });
  };

  const retry = async (id: number) => {
    const result = await commands.retryHistoryEntryTranscription(id);
    if (result.status !== "ok") throw new Error(String(result.error));
  };

  const openRecordingsFolder = async () => {
    try {
      const result = await commands.openRecordingsFolder();
      if (result.status !== "ok") throw new Error(String(result.error));
    } catch (error) {
      console.error("Failed to open recordings folder:", error);
    }
  };

  // «Хранятся последние 50 диктовок» / «Удаляются через 2 недели» / «не удаляются».
  const retention = settings?.recording_retention_period ?? "preserve_limit";
  const limit = settings?.history_limit ?? 50;
  const storageText =
    retention === "never"
      ? t("history.storage.never")
      : retention === "preserve_limit"
        ? t("history.storage.limit", { count: limit })
        : t(`history.storage.${retention}`);

  const dictationKey = settings?.bindings?.transcribe?.current_binding ?? "";

  // Group entries by day.
  const groups: { title: string; items: HistoryEntry[] }[] = [];
  const byTime = [...entries].sort((a, b) => b.timestamp - a.timestamp);
  for (const entry of byTime) {
    const title = formatDayGroup(entry.timestamp * 1000, t, i18n.language);
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.items.push(entry);
    else groups.push({ title, items: [entry] });
  }

  let content: React.ReactNode;
  if (loading) {
    content = showLoading ? (
      <div className="t-empty">
        <Spinner size={16} />
        <div className="t-empty-text">{t("settings.history.loading")}</div>
      </div>
    ) : null;
  } else if (entries.length === 0) {
    content = (
      <div className="t-empty">
        <div className="t-empty-title">{t("history.empty.title")}</div>
        <div className="t-empty-text">
          {dictationKey ? (
            <span className="inline-flex flex-wrap items-center justify-center gap-1">
              {t("history.empty.textBefore")}
              <Keycaps combo={formatKeyCombination(dictationKey, osType)} />
              {t("history.empty.textAfter")}
            </span>
          ) : (
            t("history.empty.textNoKey")
          )}
        </div>
      </div>
    );
  } else {
    content = (
      <AudioPlayerGroup>
        {groups.map((group) => (
          <div
            key={group.title}
            className="t-list"
            role="list"
            aria-label={group.title}
          >
            <h2 className="t-list-title">{group.title}</h2>
            {group.items.map((entry, index) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                last={index === group.items.length - 1}
                onToggleSaved={() => void toggleSaved(entry.id)}
                getAudioUrl={getAudioUrl}
                onDelete={() => deleteEntry(entry)}
                onRetry={retry}
              />
            ))}
          </div>
        ))}
        <div ref={sentinelRef} className="h-1" />
      </AudioPlayerGroup>
    );
  }

  return (
    <Page section="history" title={t("sidebar.history")}>
      <div className="t-work t-wide">
        <div className="t-work-side">
          <div className="t-section" data-anchor="history-storage">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <ServiceLine
                className="mt-0"
                action={
                  <TextLink
                    aria-expanded={storageOpen}
                    onClick={() => setFold(STORAGE_FOLD, !storageOpen)}
                  >
                    {storageOpen ? t("ui.hide") : t("ui.change")}
                  </TextLink>
                }
              >
                {storageText}
              </ServiceLine>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void openRecordingsFolder()}
              >
                <FolderOpen aria-hidden="true" />
                {t("settings.history.openFolder")}
              </Button>
            </div>
            {storageOpen && (
              <div className="mt-3">
                <SettingsGroup title={t("history.storage.title")}>
                  <HistoryLimit grouped />
                  <RecordingRetentionPeriodSelector grouped />
                </SettingsGroup>
              </div>
            )}
          </div>
        </div>
        <div className="t-work-main">{content}</div>
      </div>
    </Page>
  );
};

interface HistoryRowProps {
  entry: HistoryEntry;
  last: boolean;
  onToggleSaved: () => void;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  onDelete: () => void;
  onRetry: (id: number) => Promise<void>;
}

const HistoryRow: React.FC<HistoryRowProps> = ({
  entry,
  last,
  onToggleSaved,
  getAudioUrl,
  onDelete,
  onRetry,
}) => {
  const { t, i18n } = useTranslation();
  const menu = useMenu();
  const edited = !!entry.post_processed_text?.trim();
  const [version, setVersion] = useState<"edited" | "raw">(
    edited ? "edited" : "raw",
  );
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  const text =
    version === "edited" && edited
      ? (entry.post_processed_text ?? "")
      : entry.transcription_text;
  const hasText = text.trim().length > 0;

  useEffect(() => {
    const el = textRef.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  const loadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const copy = async () => {
    if (!hasText) return;
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.error(t("settings.history.copyError"));
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const retranscribe = async () => {
    try {
      setRetrying(true);
      await onRetry(entry.id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      toast.error(t("settings.history.retranscribeError"));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`t-item ${last ? "t-item-last" : ""}`} role="listitem">
      <div className="min-w-0">
        <div className="t-item-meta flex items-center gap-2">
          <span>{formatTime(entry.timestamp * 1000, i18n.language)}</span>
          {entry.saved && <Tag>{t("history.savedTag")}</Tag>}
          {entry.post_process_requested && !edited && (
            <Tag>{t("history.editingSkipped")}</Tag>
          )}
        </div>
        {retrying ? (
          <div className="t-item-status mt-1">
            <Spinner size={14} />
            {t("settings.history.transcribing")}
          </div>
        ) : hasText ? (
          <>
            <p
              ref={textRef}
              className={`t-type-prose t-selectable mt-1 whitespace-pre-wrap break-words ${
                expanded ? "" : "line-clamp-3"
              }`}
            >
              {text}
            </p>
            {(overflowing || expanded) && (
              <Button
                variant="quiet"
                size="sm"
                className="-ms-2"
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? t("history.showLess") : t("history.showMore")}
              </Button>
            )}
          </>
        ) : (
          <div className="t-item-status t-item-status-error mt-1">
            <CircleAlert className="t-icon-danger" aria-hidden="true" />
            <span>{t("history.failed")}</span>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void retranscribe()}
            >
              {t("history.retry")}
            </Button>
          </div>
        )}
        {edited && !retrying && (
          <div className="mt-2">
            <Segments
              size="sm"
              mode="pressed"
              ariaLabel={t("history.version")}
              value={version}
              onChange={(v) => setVersion(v as "edited" | "raw")}
              options={[
                { value: "edited", label: t("history.versionEdited") },
                { value: "raw", label: t("history.versionRaw") },
              ]}
            />
          </div>
        )}
        <AudioPlayer onLoadRequest={loadAudio} className="mt-2 w-full" />
      </div>
      <div className="t-item-acts">
        <Button
          variant="quiet"
          size="sm"
          icon
          disabled={!hasText || retrying}
          aria-label={copied ? t("ui.copied") : t("history.copy")}
          title={copied ? t("ui.copied") : t("history.copy")}
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
        <Button
          ref={menu.anchorRef}
          variant="quiet"
          size="sm"
          icon
          aria-label={t("history.more")}
          title={t("history.more")}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
        <Menu
          anchor={menu.anchorRef.current}
          open={menu.open}
          onClose={menu.close}
          align="end"
          checkable
          items={[
            {
              value: "save",
              label: t("history.keep"),
              description: t("history.keepDescription"),
              selected: entry.saved,
              disabled: retrying,
              onSelect: onToggleSaved,
            },
            {
              value: "retry",
              label: t("history.retry"),
              disabled: retrying,
              onSelect: () => void retranscribe(),
            },
            {
              value: "delete",
              label: t("history.delete"),
              danger: true,
              separatorBefore: true,
              disabled: retrying,
              onSelect: onDelete,
            },
          ]}
        />
      </div>
    </div>
  );
};
