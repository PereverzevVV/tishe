/**
 * Builds src-tauri/licenses/THIRD_PARTY_NOTICES.txt: the license texts of
 * everything the Windows installer ships (Tishe's own LICENSE, Rust crates
 * linked into the exe, the JS bundled into the UI, native libraries next to
 * the exe) plus attributions for the models the app downloads.
 *
 *   bun scripts/notices/gen-notices.ts
 *
 * Needs `cargo install cargo-about --locked --features cli` and `bun install`.
 * Re-run after changing Cargo.lock, bun.lock, the ffmpeg or llama.cpp builds,
 * or the model catalog, and commit the result (DOCUMENTATION §8).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const here = import.meta.dir;
const out = join(root, "src-tauri", "licenses", "THIRD_PARTY_NOTICES.txt");
const manifest = join(root, "src-tauri", "Cargo.toml");

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rule = (title: string, ch = "=") =>
  `\n\n${ch.repeat(78)}\n${title}\n${ch.repeat(78)}\n\n`;

// ---------- Rust crates (cargo-about) ----------

type AboutCrate = { name: string; version: string; repository?: string };
type AboutLicense = {
  id: string;
  name: string;
  text: string;
  used_by: { crate: AboutCrate }[];
};

function rustSection(): string {
  const json = execFileSync(
    "cargo",
    [
      "about",
      "generate",
      "--format",
      "json",
      "-c",
      join(here, "about.toml"),
      "--manifest-path",
      manifest,
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const { licenses } = JSON.parse(json) as { licenses: AboutLicense[] };
  const parts: string[] = [];
  for (const lic of licenses) {
    const crates = lic.used_by
      .map(({ crate }) => `${crate.name} ${crate.version}`)
      .filter((c) => !c.startsWith("handy ")) // Tishe itself: see LICENSE above
      .sort();
    if (crates.length === 0) continue;
    parts.push(
      `${lic.name} (${lic.id})\nUsed by: ${crates.join(", ")}\n\n${lic.text.trim()}\n`,
    );
  }
  return parts.join(`\n${"-".repeat(78)}\n\n`);
}

/** Native C/C++ code vendored inside the transcribe-cpp-sys crate (transcribe.dll, ggml-*.dll). */
function vendoredSection(): string {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--manifest-path", manifest],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  ) as { packages: { name: string; version: string; manifest_path: string }[] };
  const sys = meta.packages.find((p) => p.name === "transcribe-cpp-sys");
  if (!sys) throw new Error("transcribe-cpp-sys is not in cargo metadata");
  const dir = dirname(sys.manifest_path);
  const files: [string, string][] = [
    ["transcribe.cpp (transcribe.dll)", "LICENSE"],
    ["ggml (ggml-*.dll)", "ggml/LICENSE"],
    ["miniz (inside transcribe.dll)", "src/third_party/miniz/LICENSE"],
    [
      "Silero VAD (inside transcribe.dll)",
      "src/third_party/silero_vad/LICENSE",
    ],
  ];
  return files
    .map(
      ([title, rel]) =>
        `${title}, from transcribe-cpp-sys ${sys.version}\n\n${read(join(dir, rel)).trim()}\n`,
    )
    .join(`\n${"-".repeat(78)}\n\n`);
}

// ---------- JS packages bundled into the UI ----------

type Pkg = {
  name: string;
  version: string;
  license?: string | { type: string };
  dependencies?: Record<string, string>;
};

function findPackageDir(name: string, from: string): string | null {
  // Node resolution: walk up from the requiring package's folder.
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function licenseText(dir: string): string | null {
  const file = readdirSync(dir).find((f) =>
    /^(licen[cs]e|copying)(\.|$|-)/i.test(f),
  );
  return file ? read(join(dir, file)).trim() : null;
}

function jsSection(): string {
  const rootPkg = JSON.parse(read(join(root, "package.json"))) as Pkg;
  const seen = new Map<string, { pkg: Pkg; text: string | null }>();
  const queue: [string, string][] = Object.keys(rootPkg.dependencies ?? {}).map(
    (n) => [n, root],
  );
  while (queue.length > 0) {
    const [name, from] = queue.shift()!;
    const dir = findPackageDir(name, from);
    if (!dir) continue; // optional dependency for another platform
    const pkg = JSON.parse(read(join(dir, "package.json"))) as Pkg;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.set(key, { pkg, text: licenseText(dir) });
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      queue.push([dep, dir]);
  }
  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { pkg, text }]) => {
      const id =
        typeof pkg.license === "object" ? pkg.license.type : pkg.license;
      return `${key} (${id ?? "see package"})\n\n${text ?? `License: ${id}`}\n`;
    })
    .join(`\n${"-".repeat(78)}\n\n`);
}

// ---------- Native programs shipped next to the exe ----------

function staticSection(): string {
  const s = (f: string) => read(join(here, "static", f)).trim();
  return [
    `ONNX Runtime (Microsoft), linked into the Tishe executable through the ort crate\n\n${s("onnxruntime-LICENSE.txt")}\n\n${s("onnxruntime-ThirdPartyNotices.txt")}\n`,
    `llama.cpp (llama\\llama-server.exe and its DLLs, including libomp.dll)\nThe full license texts of llama.cpp and the libraries it bundles are in\nllama\\LICENSE-llama.cpp.txt next to the program.\n`,
    `FFmpeg (ffmpeg\\ffmpeg.exe), LGPL build, run as a separate program\nThe license text and the link to the source code of this exact build are in\nffmpeg\\ next to the program (see scripts/fetch-ffmpeg.ps1).\n`,
    `NSIS (the installer)\nCopyright (C) 1999-2025 Contributors. Licensed under the zlib/libpng license:\n\n${s("zlib-license.txt")}\n`,
  ].join(`\n${"-".repeat(78)}\n\n`);
}

// ---------- Assemble ----------

const text =
  `Tishe — third-party notices\n` +
  `Generated by scripts/notices/gen-notices.ts. Do not edit by hand.\n` +
  `\nTishe is based on Handy (https://github.com/cjpais/Handy).` +
  rule("Tishe license") +
  read(join(root, "LICENSE")).trim() +
  rule("Native components shipped with Tishe") +
  vendoredSection() +
  `\n${"-".repeat(78)}\n\n` +
  staticSection() +
  rule("Rust crates linked into the Tishe executable") +
  "Tishe uses these crates unmodified. The source code of each one, including\n" +
  "the MPL-2.0 ones, is available at https://crates.io/crates/<name>/<version>.\n\n" +
  rustSection() +
  rule("JavaScript packages bundled into the Tishe interface") +
  jsSection() +
  rule("Models") +
  read(join(here, "static", "models.txt")).trim() +
  "\n";

writeFileSync(out, text);
console.log(`Wrote ${out} (${(text.length / 1024).toFixed(0)} KB)`);
