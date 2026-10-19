import { create } from "zustand";

/**
 * Files dragged over the window (VISUAL_DESIGN_SYSTEM §12.25): the whole
 * field shows «Отпустите, чтобы добавить» with what will happen to the
 * files; dropped media go to the «Расшифровка» queue from any page; other
 * files get a short note.
 */
interface DropStore {
  dragging: boolean;
  /** Paths being dragged, known from the moment they enter the window. */
  paths: string[];
  /** Names of dropped files that are not audio or video, shown for 6 s. */
  rejected: string[];
  setDragging: (dragging: boolean, paths?: string[]) => void;
  setRejected: (names: string[]) => void;
}

export const useDropStore = create<DropStore>()((set) => ({
  dragging: false,
  paths: [],
  rejected: [],
  setDragging: (dragging, paths) =>
    set((s) => ({
      dragging,
      paths: dragging ? (paths ?? s.paths) : [],
    })),
  setRejected: (rejected) => set({ rejected }),
}));
