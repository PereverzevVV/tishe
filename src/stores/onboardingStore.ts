import { create } from "zustand";

/**
 * «Быстрый старт» on «Расшифровка»: the checklist a new person sees after the
 * first-run screen (model, dictation, a recording, optional editing). It
 * stays until it is done or hidden, across runs of the program, so it is
 * kept in the window's local storage. People who updated from an earlier
 * version never get it.
 */
const KEY = "tishe.quickStart";
const DICTATED_KEY = "tishe.quickStart.dictated";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the checklist lives for this run only.
  }
};

interface OnboardingStore {
  quickStart: boolean;
  /** A dictation has landed since the checklist opened. */
  dictated: boolean;
  openQuickStart: () => void;
  closeQuickStart: () => void;
  markDictated: () => void;
}

export const useOnboardingStore = create<OnboardingStore>()((set) => ({
  quickStart: read(KEY) === "open",
  dictated: read(DICTATED_KEY) === "1",
  openQuickStart: () => {
    write(KEY, "open");
    set({ quickStart: true });
  },
  closeQuickStart: () => {
    write(KEY, "closed");
    set({ quickStart: false });
  },
  markDictated: () => {
    write(DICTATED_KEY, "1");
    set({ dictated: true });
  },
}));
