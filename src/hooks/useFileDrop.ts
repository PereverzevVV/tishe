import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useDropStore } from "@/stores/dropStore";
import { useFileTranscriptionStore } from "@/stores/fileTranscriptionStore";
import { useNavigationStore } from "@/stores/navigationStore";
import { isMediaPath } from "@/lib/media";
import { fileName } from "@/lib/utils/humanize";

/**
 * Drag and drop of recordings onto the window (owner-approved capability,
 * UX_ARCHITECTURE_PROPOSAL; VISUAL_DESIGN_SYSTEM §12.25). Tauri's native
 * handler delivers file paths; HTML drag events never fire while it is on.
 */
export const useFileDrop = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) return;
    let rejectTimer: number | undefined;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const { setDragging, setRejected } = useDropStore.getState();
      const payload = event.payload;
      if (payload.type === "enter") {
        setDragging(true, payload.paths);
      } else if (payload.type === "over") {
        if (!useDropStore.getState().dragging) setDragging(true);
      } else if (payload.type === "leave") {
        setDragging(false);
      } else if (payload.type === "drop") {
        setDragging(false);
        const media = payload.paths.filter(isMediaPath);
        const other = payload.paths.filter((p) => !isMediaPath(p));
        if (media.length) {
          useFileTranscriptionStore.getState().addFiles(media);
          const nav = useNavigationStore.getState();
          if (nav.section !== "transcription") nav.open("transcription");
        }
        window.clearTimeout(rejectTimer);
        setRejected(other.map(fileName));
        if (other.length)
          rejectTimer = window.setTimeout(() => setRejected([]), 6000);
      }
    });
    return () => {
      window.clearTimeout(rejectTimer);
      unlisten.then((fn) => fn());
    };
  }, [enabled]);
};
