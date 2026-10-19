/** Tishe's public repository: source code, releases and issues. */
export const TISHE_REPO = "PereverzevVV/tishe";
export const TISHE_REPO_URL = `https://github.com/${TISHE_REPO}`;
/** Tishe's author, Viktor Pereverzev, on GitHub. */
export const AUTHOR_URL = "https://github.com/PereverzevVV";

/**
 * The Tishe release this build belongs to, as the date of the release
 * (`YYYY.MM.DD`, optionally `.N` for a second release that day). The app
 * version stays equal to the Handy version it is based on (0.9.8), so
 * releases are told apart by this date. Set it to the release date when
 * building a release installer; the GitHub release tag is `v` + this value.
 */
export const TISHE_RELEASE = "2026.10.19";

export type LatestRelease = { release: string; url: string };

/** `v2026.10.15` → [2026, 10, 15]; null for tags that are not release dates. */
export const parseRelease = (tag: string): number[] | null => {
  const m = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/.exec(tag.trim());
  if (!m) return null;
  return m.slice(1).map((p) => (p === undefined ? 0 : Number(p)));
};

/** True when release tag `tag` is newer than `current`. */
export const isNewerRelease = (tag: string, current: string): boolean => {
  const a = parseRelease(tag);
  const b = parseRelease(current);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
};

/**
 * The newest published Tishe release on GitHub: the highest date tag among
 * releases that are neither drafts nor pre-releases. Tags that are not dates
 * (e.g. the `build-deps` release with ffmpeg) are ignored even if someone
 * forgets to mark them as a pre-release. One small request to
 * api.github.com; nothing about the user's recordings or texts is sent.
 */
export const fetchLatestRelease = async (): Promise<LatestRelease | null> => {
  const res = await fetch(
    `https://api.github.com/repos/${TISHE_REPO}/releases?per_page=20`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (res.status === 404) return null; // repository not published yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const list = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    draft?: boolean;
    prerelease?: boolean;
  }[];
  let best: LatestRelease | null = null;
  for (const r of list) {
    if (r.draft || r.prerelease || !r.tag_name || !parseRelease(r.tag_name))
      continue;
    const release = r.tag_name.replace(/^v/, "");
    if (!best || isNewerRelease(release, best.release)) {
      best = {
        release,
        url: r.html_url ?? `${TISHE_REPO_URL}/releases/tag/${r.tag_name}`,
      };
    }
  }
  return best;
};
