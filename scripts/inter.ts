/**
 * Makes the interface font in public/fonts/ from Inter's own release. Run by
 * hand when the pin changes:
 *
 *   node scripts/inter.ts
 *
 * It needs Python 3 (`python3`, or the interpreter named by PYTHON) and the
 * network. Nothing is added to package.json: the subsetter, fonttools, runs
 * once from a throwaway virtual environment at a pinned version and is
 * deleted with it.
 *
 * Steps: download the release's zip from github.com/rsms/inter, check it
 * against the pinned SHA-256, take the two variable fonts and the license
 * out of it, and subset each font to the characters in
 * client/lib/interFont.ts as WOFF2. For each file the subsetter runs as
 *
 *   python -I -m fontTools.subset InterVariable.ttf \
 *     --unicodes=U+0020-007E,U+00A0-017F,U+2000-206F,U+2190-2199,U+2212 \
 *     --layout-features+=tnum --flavor=woff2 \
 *     --output-file=<a work folder>/InterVariable.woff2
 *
 * and the result is named for the first 8 hex digits of its SHA-256
 * (InterVariable-8a540aa8.woff2), since the server lets browsers keep the
 * files for good (server/http/static.ts). The script prints the names,
 * which INTER_FILES, globals.css and index.html then take, and
 * interFont.test.ts checks that each name matches its file.
 *
 * Both axes stay (weight 100 to 900 and optical size 14 to 32), so every
 * weight the theme uses comes from one file. `tnum` joins fonttools'
 * default features because Inter's digits are proportional unless asked,
 * and `font-variant-numeric: tabular-nums` asks. The license goes beside
 * the fonts unchanged, as the SIL Open Font License requires of a copy.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yauzl from "yauzl";
import { INTER_UNICODE_RANGE, INTER_VERSION } from "../client/lib/interFont.ts";

const RELEASE = {
  url: `https://github.com/rsms/inter/releases/download/v${INTER_VERSION}/Inter-${INTER_VERSION}.zip`,
  sha256: "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e",
};

/** Exact versions, at least two weeks old when pinned. brotli writes the WOFF2 compression. */
const PIP_PINS = ["fonttools==4.66.1", "brotli==1.2.0"];

/** Zip entry, and the name it takes in public/fonts/ before its hash. */
const FONTS: [entry: string, out: string][] = [
  ["InterVariable.ttf", "InterVariable"],
  ["InterVariable-Italic.ttf", "InterVariable-Italic"],
];
const LICENSE: [entry: string, out: string] = ["LICENSE.txt", "Inter-LICENSE.txt"];

const OUT_DIR = join(import.meta.dirname, "..", "public", "fonts");

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The named entries of a zip, read into memory. Fails if one is missing. */
function readZipEntries(zip: Buffer, names: readonly string[]): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, Buffer>();
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, file) => {
      if (err) return reject(err);
      file.on("error", reject);
      file.on("end", () => {
        const missing = names.filter((n) => !found.has(n));
        if (missing.length > 0) reject(new Error(`not in the zip: ${missing.join(", ")}`));
        else resolve(found);
      });
      file.on("entry", (entry: yauzl.Entry) => {
        if (!names.includes(entry.fileName)) return file.readEntry();
        file.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", reject);
          stream.on("end", () => {
            found.set(entry.fileName, Buffer.concat(chunks));
            file.readEntry();
          });
        });
      });
      file.readEntry();
    });
  });
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

if (import.meta.main) {
  const zip = await download(RELEASE.url);
  const got = sha256(zip);
  if (got !== RELEASE.sha256) {
    throw new Error(`${RELEASE.url} changed upstream (sha256 ${got}). Re-check its license before re-pinning.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  // The last run's files, whose names a new subset would not reuse.
  for (const name of readdirSync(OUT_DIR)) if (name.endsWith(".woff2")) rmSync(join(OUT_DIR, name));
  const work = mkdtempSync(join(tmpdir(), "raccoon-inter-"));
  try {
    const entries = await readZipEntries(zip, [...FONTS.map(([entry]) => entry), LICENSE[0]]);
    for (const [name, data] of entries) writeFileSync(join(work, name), data);

    const venv = join(work, "venv");
    execFileSync(process.env.PYTHON ?? "python3", ["-I", "-m", "venv", venv], { stdio: "inherit" });
    const python = join(venv, "bin", "python");
    execFileSync(python, ["-I", "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--only-binary=:all:", ...PIP_PINS], { stdio: "inherit" });

    for (const [entry, out] of FONTS) {
      const subset = join(work, `${out}.woff2`);
      execFileSync(
        python,
        [
          "-I",
          "-m",
          "fontTools.subset",
          join(work, entry),
          `--unicodes=${INTER_UNICODE_RANGE.join(",")}`,
          "--layout-features+=tnum",
          "--flavor=woff2",
          `--output-file=${subset}`,
        ],
        { stdio: "inherit" },
      );
      const data = readFileSync(subset);
      const hash = sha256(data);
      const name = `${out}-${hash.slice(0, 8)}.woff2`;
      writeFileSync(join(OUT_DIR, name), data);
      console.log(`/fonts/${name}  ${data.length} bytes  sha256 ${hash}`);
    }
    console.log("Give these names to INTER_FILES (client/lib/interFont.ts), the @font-face rules (client/globals.css) and the preload (client/index.html).");
    writeFileSync(join(OUT_DIR, LICENSE[1]), entries.get(LICENSE[0])!);
    console.log(`${LICENSE[1]}  copied from the release`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
