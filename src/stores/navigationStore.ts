import { create } from "zustand";

/**
 * Navigation between sections (UX_INTERACTION_ARCHITECTURE, Global Navigation).
 *
 * The sidebar is flat; depth is section → fold → dialog. A deep link
 * («Изменить», «Что делать», a status-bar part) opens the target section,
 * unfolds the fold that holds the target, scrolls the target group into the
 * top third, highlights it for 1.5 s and focuses its title. A back row then
 * returns to the place the link was pressed.
 */

export type SectionId =
  | "transcription"
  | "dictation"
  | "meetings"
  | "history"
  | "models"
  | "llm"
  | "app"
  | "next"
  | "about"
  | "debug";

export interface DeepLink {
  /** `data-anchor` of the target group or row. */
  target?: string;
  /** Fold that holds the target; it is opened and stays open. */
  fold?: string;
}

interface BackPoint {
  section: SectionId;
  scrollTop: number;
}

interface NavigationStore {
  section: SectionId;
  /** Set only after a deep link; the back row shows while it is set. */
  back: BackPoint | null;
  /** Pending target to reveal on the newly shown page. */
  pending: DeepLink | null;
  /** Fold open state, remembered between visits and launches. */
  folds: Record<string, boolean>;
  /** Scroll position of each section for this run of the program. */
  scroll: Partial<Record<SectionId, number>>;
  /** Results finished while «Расшифровка» was not on screen. */
  unseenResults: boolean;

  /** Sidebar navigation: no back row. */
  open: (section: SectionId) => void;
  /** Deep link from inside the window: shows the back row. */
  link: (section: SectionId, to?: DeepLink) => void;
  /**
   * Open a section at a group or row from outside the window (a
   * notification, «Что делать» in the overlay): no back row.
   */
  reveal: (section: SectionId, target?: string, fold?: string) => void;
  goBack: () => void;
  setFold: (id: string, open: boolean) => void;
  rememberScroll: (section: SectionId, top: number) => void;
  consumePending: () => DeepLink | null;
  setUnseenResults: (value: boolean) => void;
}

const FOLDS_KEY = "tishe.folds";

const loadFolds = (): Record<string, boolean> => {
  try {
    const raw = localStorage.getItem(FOLDS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    // localStorage may be unavailable; folds then start closed.
  }
  return {};
};

const saveFolds = (folds: Record<string, boolean>) => {
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(folds));
  } catch {
    // ignore
  }
};

export const useNavigationStore = create<NavigationStore>()((set, get) => ({
  section: "transcription",
  back: null,
  pending: null,
  folds: loadFolds(),
  scroll: {},
  unseenResults: false,

  open: (section) =>
    set({
      section,
      back: null,
      pending: null,
      unseenResults: section === "transcription" ? false : get().unseenResults,
    }),

  link: (section, to) => {
    const { section: from, scroll, folds } = get();
    const nextFolds =
      to?.fold && !folds[to.fold] ? { ...folds, [to.fold]: true } : folds;
    if (nextFolds !== folds) saveFolds(nextFolds);
    set({
      section,
      // A link inside the same page needs no way back.
      back:
        from === section
          ? get().back
          : { section: from, scrollTop: scroll[from] ?? 0 },
      pending: to ?? null,
      folds: nextFolds,
      unseenResults: section === "transcription" ? false : get().unseenResults,
    });
  },

  reveal: (section, target, fold) => {
    const { folds } = get();
    const nextFolds = fold && !folds[fold] ? { ...folds, [fold]: true } : folds;
    if (nextFolds !== folds) saveFolds(nextFolds);
    set({
      section,
      back: null,
      pending: target ? { target, fold } : null,
      folds: nextFolds,
      unseenResults: section === "transcription" ? false : get().unseenResults,
    });
  },

  goBack: () => {
    const { back } = get();
    if (!back) return;
    set((s) => ({
      section: back.section,
      back: null,
      pending: null,
      scroll: { ...s.scroll, [back.section]: back.scrollTop },
    }));
  },

  setFold: (id, open) => {
    const folds = { ...get().folds, [id]: open };
    saveFolds(folds);
    set({ folds });
  },

  rememberScroll: (section, top) =>
    set((s) => ({ scroll: { ...s.scroll, [section]: top } })),

  consumePending: () => {
    const { pending } = get();
    if (pending) set({ pending: null });
    return pending;
  },

  setUnseenResults: (value) => set({ unseenResults: value }),
}));
