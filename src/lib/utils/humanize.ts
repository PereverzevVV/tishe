import type { TFunction } from "i18next";

/**
 * Short, human formats for the interface: «58 мин», «1 ч 32 мин»,
 * «сегодня 14:02», «860 МБ». Units come from translations (ui.units.*).
 */

/** «58 мин», «1 ч 32 мин», «40 с». */
export const formatDurationShort = (secs: number, t: TFunction): string => {
  const total = Math.max(0, Math.round(secs));
  if (total < 60) return t("ui.units.sec", { n: total });
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h === 0) return t("ui.units.min", { n: m });
  if (m === 0) return t("ui.units.hour", { n: h });
  return t("ui.units.hourMin", { h, m });
};

/** «00:21:03» for a running clock. */
export const formatClock = (secs: number): string => {
  const total = Math.max(0, Math.round(secs));
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** «сегодня 14:02», «вчера 18:20», «8 окт. 14:02». */
export const formatWhen = (
  ms: number,
  t: TFunction,
  locale: string,
): string => {
  const date = new Date(ms);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (sameDay(date, now)) return t("ui.when.today", { time });
  if (sameDay(date, yesterday)) return t("ui.when.yesterday", { time });
  const day = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
  return `${day} ${time}`;
};

/** Day heading for grouped lists: «Сегодня», «Вчера», «8 октября». */
export const formatDayGroup = (
  ms: number,
  t: TFunction,
  locale: string,
): string => {
  const date = new Date(ms);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, now)) return t("ui.when.todayTitle");
  if (sameDay(date, yesterday)) return t("ui.when.yesterdayTitle");
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
};

/** Time of day only: «14:32». */
export const formatTime = (ms: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));

/** «860 МБ», «5,3 ГБ» from bytes. */
export const formatBytes = (bytes: number, t: TFunction, locale: string) => {
  const mb = bytes / 1e6;
  if (mb >= 1000) {
    const gb = mb / 1000;
    return t("ui.units.gb", {
      n: gb.toLocaleString(locale, { maximumFractionDigits: gb >= 10 ? 0 : 1 }),
    });
  }
  return t("ui.units.mb", {
    n: mb.toLocaleString(locale, { maximumFractionDigits: mb >= 100 ? 0 : 1 }),
  });
};

/** Same from megabytes (ASR catalog sizes are in MB of 1024² bytes). */
export const formatMb = (sizeMb: number, t: TFunction, locale: string) =>
  formatBytes(sizeMb * 1024 * 1024, t, locale);

/** File name from a path, either separator. */
export const fileName = (path: string): string => {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(idx + 1) : path;
};

/**
 * Middle ellipsis that keeps the extension («лекция-по-фин…ам.mp3»,
 * VISUAL_DESIGN_SYSTEM §12.15). CSS cannot cut in the middle.
 */
export const middleEllipsis = (name: string, max = 48): string => {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const keep = max - ext.length - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  const stem = ext ? name.slice(0, dot) : name;
  return `${stem.slice(0, head)}…${stem.slice(stem.length - tail)}${ext}`;
};

/** «русский», «English» — the language name in the interface language. */
export const languageName = (code: string, locale: string): string => {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code);
    if (name && name !== code) return name;
  } catch {
    // unknown code or no Intl.DisplayNames
  }
  return code;
};
