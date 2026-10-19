import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CircleAlert,
  Clock,
  MoreHorizontal,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import {
  RESULTS_KEPT,
  useFileTranscriptionStore,
  type FileTranscriptionProgress,
  type QueueItem,
} from "@/stores/fileTranscriptionStore";
import { rowAnchor } from "@/lib/queueSignals";
import { Button } from "@/components/ui/Button";
import { Menu, useMenu } from "@/components/ui/Menu";
import { ProgressLine } from "@/components/ui/ProgressLine";
import { Spinner } from "@/components/ui/Spinner";
import { localizeFileError } from "@/lib/fileErrors";
import {
  fileName,
  formatDurationShort,
  formatWhen,
  middleEllipsis,
} from "@/lib/utils/humanize";

/**
 * Queue and results as one list (VISUAL_DESIGN_SYSTEM §12.15, S1): running and
 * waiting files first, then problems, then finished files, newest first.
 * Rows are not click targets; their actions are buttons on the right. A
 * finished file has no icon — only what runs or needs attention has one.
 * Finished documents are kept between runs (CF7); one that was moved or
 * deleted shows «Документ не найден» and only «Убрать из списка».
 */

const RESULTS_SHOWN = 3;

const order = (item: QueueItem): number =>
  ({ running: 0, pending: 1, error: 2, cancelled: 2, done: 3 })[item.status];

interface FileListProps {
  stageText: (p: FileTranscriptionProgress | null) => string;
  remaining: number | null;
}

export const FileList: React.FC<FileListProps> = ({ stageText, remaining }) => {
  const { t } = useTranslation();
  const items = useFileTranscriptionStore((s) => s.items);
  const progress = useFileTranscriptionStore((s) => s.progress);
  const running = useFileTranscriptionStore((s) => s.running);
  const removeItem = useFileTranscriptionStore((s) => s.removeItem);
  const clearFinished = useFileTranscriptionStore((s) => s.clearFinished);
  const restoreItems = useFileTranscriptionStore((s) => s.restoreItems);
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => {
        const d = order(a) - order(b);
        if (d !== 0) return d;
        if (a.status === "done" && b.status === "done")
          return (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
        return 0;
      }),
    [items],
  );

  const results = sorted.filter((i) => i.status === "done");
  const others = sorted.filter((i) => i.status !== "done");
  const visibleResults = showAll ? results : results.slice(0, RESULTS_SHOWN);
  const rows = [...others, ...visibleResults];
  const finished = items.filter(
    (i) => i.status !== "pending" && i.status !== "running",
  );

  // Removing from the list is reversible: «Вернуть» in a toast (Destructive
  // Actions, class «Обратимо»). Files on disk are never touched.
  const removeWithUndo = (removed: QueueItem[], apply: () => void) => {
    apply();
    toast(
      removed.length === 1
        ? t("transcription.list.removedOne")
        : t("transcription.list.removedMany", { count: removed.length }),
      {
        duration: 6000,
        action: {
          label: t("ui.undo"),
          onClick: () => restoreItems(removed),
        },
      },
    );
  };

  if (items.length === 0) return null;

  return (
    <div className="t-section">
      <div
        className="t-list"
        role="list"
        aria-label={t("transcription.list.label")}
      >
        {rows.map((item, index) => (
          <FileRow
            key={item.id}
            item={item}
            last={index === rows.length - 1}
            progress={item.status === "running" ? progress : null}
            stageText={stageText}
            remaining={item.status === "running" ? remaining : null}
            onRemove={() =>
              item.status === "pending"
                ? removeItem(item.id)
                : removeWithUndo([item], () => removeItem(item.id))
            }
          />
        ))}
      </div>
      {showAll && results.length > RESULTS_SHOWN && (
        <p className="t-type-caption t-text-tertiary mt-2">
          {t("transcription.list.keptNote", { count: RESULTS_KEPT })}
        </p>
      )}
      {(results.length > RESULTS_SHOWN ||
        (finished.length > 0 && !running)) && (
        <div className="t-list-more">
          {results.length > RESULTS_SHOWN && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => setShowAll((s) => !s)}
            >
              {showAll
                ? t("transcription.list.showFewer")
                : t("transcription.list.showAll", { count: results.length })}
            </Button>
          )}
          {finished.length > 0 && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => removeWithUndo(finished, clearFinished)}
            >
              {t("fileTranscription.queue.clearFinished")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

interface FileRowProps {
  item: QueueItem;
  last: boolean;
  progress: FileTranscriptionProgress | null;
  stageText: (p: FileTranscriptionProgress | null) => string;
  remaining: number | null;
  onRemove: () => void;
}

const FileRow: React.FC<FileRowProps> = ({
  item,
  last,
  progress,
  stageText,
  remaining,
  onRemove,
}) => {
  const { t, i18n } = useTranslation();
  const name = fileName(item.inputPath);
  const shortName = middleEllipsis(name);
  const menu = useMenu();
  const [notesOpen, setNotesOpen] = useState(false);
  const checkResults = useFileTranscriptionStore((s) => s.checkResults);
  const result = item.result;

  // A document that disappeared since the last check: the row says so at once.
  const openDocument = async (reveal: boolean) => {
    if (!result) return;
    const res = await commands.openTranscriptFile(result.output_path, reveal);
    if (res.status === "error") await checkResults();
  };

  const nameEl = (
    <div className="t-item-name" title={item.inputPath}>
      {shortName}
    </div>
  );

  let body: React.ReactNode;
  let acts: React.ReactNode = null;

  if (item.status === "running") {
    const pct = Math.round((progress?.fraction ?? 0) * 100);
    body = (
      <>
        {nameEl}
        <div className="t-item-status">
          <Spinner size={14} />
          <span>
            {stageText(progress)}
            {remaining !== null &&
              ` · ${t("transcription.list.remaining", {
                time: formatDurationShort(remaining, t),
              })}`}
          </span>
        </div>
        <ProgressLine value={pct} label={name} />
      </>
    );
    acts = <div className="t-item-num">{t("ui.percent", { n: pct })}</div>;
  } else if (item.status === "pending") {
    body = (
      <>
        {nameEl}
        <div className="t-item-status t-text-tertiary">
          <Clock className="t-icon-tertiary" aria-hidden="true" />
          {t("transcription.list.waiting")}
        </div>
      </>
    );
    acts = (
      <Button
        variant="quiet"
        size="sm"
        icon
        aria-label={t("transcription.list.removeFile", { name })}
        title={t("transcription.list.removeFile", { name })}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </Button>
    );
  } else if (item.status === "error") {
    body = (
      <>
        {nameEl}
        <div className="t-item-status t-item-status-error">
          <CircleAlert className="t-icon-danger" aria-hidden="true" />
          <span title={item.error ?? undefined}>
            {localizeFileError(item.error ?? "", t)}
          </span>
        </div>
      </>
    );
    acts = (
      <Button variant="quiet" size="sm" onClick={onRemove}>
        {t("transcription.list.remove")}
      </Button>
    );
  } else if (item.status === "cancelled") {
    body = (
      <>
        {nameEl}
        <div className="t-item-status t-text-tertiary">
          <Square className="t-icon-tertiary" aria-hidden="true" />
          {t("transcription.list.cancelled")}
        </div>
      </>
    );
    acts = (
      <Button variant="quiet" size="sm" onClick={onRemove}>
        {t("transcription.list.remove")}
      </Button>
    );
  } else if (result && item.missing) {
    body = (
      <>
        {nameEl}
        <div className="t-item-status">
          <AlertTriangle className="t-icon-warning" aria-hidden="true" />
          <span>{t("transcription.list.missing")}</span>
        </div>
        <div className="t-item-meta t-selectable">{result.output_path}</div>
      </>
    );
    acts = (
      <Button variant="quiet" size="sm" onClick={onRemove}>
        {t("transcription.list.removeFromList")}
      </Button>
    );
  } else if (result) {
    const recipe = [
      item.recipe?.speakers ? t("transcription.list.recipeSpeakers") : null,
      item.recipe?.editing ? t("transcription.list.recipeEditing") : null,
      item.recipe?.cloud ? t("transcription.list.recipeCloud") : null,
    ].filter(Boolean);
    const meta = [
      item.finishedAt ? formatWhen(item.finishedAt, t, i18n.language) : null,
      formatDurationShort(result.duration_secs, t),
      t("transcription.list.parts", { count: result.parts }),
      t("transcription.list.chars", {
        count: result.characters,
        n: result.characters.toLocaleString(i18n.language),
      }),
      recipe.length ? recipe.join(", ") : null,
    ].filter(Boolean);
    const notes = result.warnings.length;
    body = (
      <>
        {nameEl}
        <div className="t-item-meta">{meta.join(" · ")}</div>
        <div className="t-item-meta">{result.output_path}</div>
        {notes > 0 && (
          <>
            <Button
              variant="quiet"
              size="sm"
              className="t-item-notes"
              aria-expanded={notesOpen}
              onClick={() => setNotesOpen((o) => !o)}
            >
              <AlertTriangle className="t-icon-warning" aria-hidden="true" />
              {t("transcription.list.notes", { count: notes })}
            </Button>
            {notesOpen && (
              <ul className="t-item-meta mt-1 list-disc ps-4">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </>
    );
    acts = (
      <>
        <Button
          variant="secondary"
          size="sm"
          aria-label={t("transcription.list.openDocument", {
            name: fileName(result.output_path),
          })}
          onClick={() => void openDocument(false)}
        >
          {t("fileTranscription.result.open")}
        </Button>
        <Button
          ref={menu.anchorRef}
          variant="quiet"
          size="sm"
          icon
          aria-label={t("transcription.list.more", { name })}
          title={t("transcription.list.more", { name })}
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
          items={[
            {
              value: "reveal",
              label: t("fileTranscription.result.reveal"),
              onSelect: () => void openDocument(true),
            },
            {
              value: "remove",
              label: t("transcription.list.removeFromList"),
              separatorBefore: true,
              onSelect: onRemove,
            },
          ]}
        />
      </>
    );
  }

  return (
    <div
      className={`t-item ${last ? "t-item-last" : ""}`}
      role="listitem"
      data-anchor={rowAnchor(item)}
    >
      <div className="min-w-0">{body}</div>
      <div className="t-item-acts">{acts}</div>
    </div>
  );
};
