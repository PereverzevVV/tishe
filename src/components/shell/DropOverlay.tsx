import React from "react";
import { useTranslation } from "react-i18next";
import { FileAudio, FileX } from "lucide-react";
import { useDropStore } from "@/stores/dropStore";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { isMediaPath } from "@/lib/media";
import { fileName, middleEllipsis } from "@/lib/utils/humanize";

/**
 * Files over the window (VISUAL_DESIGN_SYSTEM §12.25, owner 2026-10-09: no
 * blue frame). The work area is veiled with the window background and shows
 * a dashed target, the platform's "drop here" sign, with what will happen to
 * these particular files: how many go to the queue and how many will not.
 */
export const DropOverlay: React.FC = () => {
  const { t } = useTranslation();
  const dragging = useDropStore((s) => s.dragging);
  const paths = useDropStore((s) => s.paths);
  const items = useFileTranscriptionStore((s) => s.items);
  if (!dragging) return null;

  const queued = new Set(
    items
      .filter((i) => i.status === "pending" || i.status === "running")
      .map((i) => i.inputPath),
  );
  const allMedia = paths.filter(isMediaPath);
  const media = allMedia.filter((p) => !queued.has(p));
  const other = paths.length - allMedia.length;
  const none = paths.length > 0 && allMedia.length === 0;

  let text: string;
  if (none) text = t("transcription.drop.noneText");
  else if (allMedia.length > 0 && media.length === 0)
    text =
      allMedia.length === 1
        ? t("transcription.drop.alreadyOne", {
            name: middleEllipsis(fileName(allMedia[0]), 48),
          })
        : t("transcription.drop.alreadyMany");
  else if (media.length === 1)
    text = t("transcription.drop.oneText", {
      name: middleEllipsis(fileName(media[0]), 48),
    });
  else if (media.length > 1)
    text = t("transcription.drop.manyText", { count: media.length });
  else text = t("transcription.drop.anyText");

  return (
    <div
      className="t-drop-over"
      data-state={none ? "none" : "ok"}
      role="status"
      aria-live="polite"
    >
      <div className="t-drop-over-target">
        <span className="t-drop-over-icon" aria-hidden="true">
          {none ? <FileX /> : <FileAudio />}
        </span>
        <span className="t-drop-over-title">
          {none
            ? t("transcription.drop.noneTitle")
            : t("transcription.drop.release")}
        </span>
        <span className="t-drop-over-text">{text}</span>
        {!none && other > 0 && (
          <span className="t-drop-over-note">
            {t("transcription.drop.otherNote", { count: other })}
          </span>
        )}
      </div>
    </div>
  );
};
