import i18n from "@/i18n";

export interface ReleaseNote {
  version: string;
  markdown: string;
}

interface ReleaseNoteRecord {
  version: string;
  markdown: string;
  /** Tishe: `<version>.<lang>.md` next to `<version>.md` (the English one). */
  localized: Record<string, string>;
}

interface FindReleaseNoteOptions {
  currentVersion: string;
  lastSeenVersion: string;
}

const releaseNoteModules = import.meta.glob<string>(
  "../../content/release-notes/*.md",
  {
    eager: true,
    import: "default",
    query: "?raw",
  },
);

const releaseNotesByVersion = new Map<string, ReleaseNoteRecord>();

const parseVersion = (version: string): [number, number, number] | null => {
  const normalized = version.trim().replace(/^v/i, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;

  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

for (const [path, markdown] of Object.entries(releaseNoteModules)) {
  const match = path.match(
    /release-notes\/(\d+\.\d+\.\d+)(?:\.([a-zA-Z-]+))?\.md$/,
  );
  if (!match) continue;

  const version = match[1];
  const lang = match[2];

  if (!parseVersion(version)) continue;

  const record = releaseNotesByVersion.get(version) ?? {
    version,
    markdown: "",
    localized: {},
  };
  if (lang) record.localized[lang] = markdown;
  else record.markdown = markdown;
  releaseNotesByVersion.set(version, record);
}

/** The note in the program's language, else the default (English) one. */
const inLanguage = (record: ReleaseNoteRecord): ReleaseNote => {
  const lang = i18n.language ?? "";
  const markdown =
    record.localized[lang] ??
    record.localized[lang.split("-")[0]] ??
    (record.markdown || Object.values(record.localized)[0] || "");
  return { version: record.version, markdown };
};

const compareVersions = (a: string, b: string) => {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  if (!parsedA || !parsedB) return 0;

  for (let index = 0; index < parsedA.length; index += 1) {
    if (parsedA[index] !== parsedB[index]) {
      return parsedA[index] - parsedB[index];
    }
  }

  return 0;
};

export const findReleaseNoteToShow = ({
  currentVersion,
  lastSeenVersion,
}: FindReleaseNoteOptions): ReleaseNote | null => {
  if (!parseVersion(currentVersion)) return null;

  const hasValidLastSeenVersion = parseVersion(lastSeenVersion) !== null;
  const candidate = Array.from(releaseNotesByVersion.values())
    .filter((note) => compareVersions(note.version, currentVersion) <= 0)
    .filter(
      (note) =>
        !hasValidLastSeenVersion ||
        compareVersions(note.version, lastSeenVersion) > 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version))[0];

  if (!candidate) return null;

  return inLanguage(candidate);
};

export const findLatestReleaseNote = (): ReleaseNote | null => {
  const candidate = Array.from(releaseNotesByVersion.values()).sort((a, b) =>
    compareVersions(b.version, a.version),
  )[0];

  if (!candidate) return null;

  return inLanguage(candidate);
};
