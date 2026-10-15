/**
 * Builds the token icon set from game-icons.net (docs/design-v1-dm-tools.md
 * 3.12). Run by hand when the pin in shared/credits.ts changes:
 *
 *   node scripts/game-icons.ts [an empty scratch folder]
 *
 * It only converts existing art, never draws any. It fetches the game-icons
 * repository at the pinned commit with git into the scratch folder (a new
 * temporary one when none is given) and checks the commit's tree hash
 * against GAME_ICONS_TREE below, so every file is exactly the one reviewed.
 * GitHub's archive downloads have no stable checksum, which is why it is a
 * git fetch. The files are read out of git's object store with `cat-file`,
 * never checked out, so nothing in the repository runs or is configured.
 *
 * It then writes:
 *
 * - `public/game-icons/<commit8>/<author>/<name>.svg`, one white-path icon
 *   with its black background square dropped and an explicit size, so the
 *   canvas and a CSS mask both read it as one shape. The first 8 characters
 *   of the commit are in the path, so a new pin changes every URL and the
 *   server can serve the folder as immutable.
 * - `public/game-icons/<commit8>/index.json`, every author with their name,
 *   link and license, and every icon as its author and name. The picker
 *   searches it.
 * - `shared/gameIcons.ts`, the folder's path and the author table, which
 *   shared/credits.ts and the About page read.
 *
 * Every author's license comes from the repository's license.txt, which
 * marks the CC0 authors, plus "Various artists", which it does not list and
 * whose icon pages on game-icons.net say CC0. A folder that neither names
 * stops the build, so a new author is never shipped without a credit.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GAME_ICONS_COMMIT } from "../shared/credits.ts";
import { GAME_ICON_SHAPE, PATH_DATA } from "./icons.ts";

const REPOSITORY = "https://github.com/game-icons/icons";

/** `git rev-parse <GAME_ICONS_COMMIT>^{tree}`, read when the pin was reviewed on 2026-10-14. */
export const GAME_ICONS_TREE = "819b975fa234b1ef75cc345b9a2856bed8f2a5a4";

const ROOT = join(import.meta.dirname, "..");

export type IconLicense = "CC-BY-3.0" | "CC0-1.0";

/**
 * Each author folder and the name license.txt gives it. The folder names do
 * not follow the names closely enough to derive one from the other
 * ("heavenly-dog" is "HeavenlyDog", "lucasms" is "Lucas").
 */
const AUTHOR_FOLDERS: Record<string, string> = {
  andymeneely: "Andy Meneely",
  aussiesim: "Aussiesim",
  "carl-olsen": "Carl Olsen",
  "caro-asercion": "Caro Asercion",
  cathelineau: "Cathelineau",
  catsu: "Catsu",
  darkzaitzev: "DarkZaitzev",
  delapouite: "Delapouite",
  faithtoken: "Faithtoken",
  felbrigg: "Felbrigg",
  generalace135: "GeneralAce135",
  guard13007: "Guard13007",
  "heavenly-dog": "HeavenlyDog",
  irongamer: "Irongamer",
  "john-colburn": "John Colburn",
  "john-redman": "John Redman",
  "kier-heyl": "Kier Heyl",
  lorc: "Lorc",
  "lord-berandas": "Lord Berandas",
  lucasms: "Lucas",
  "pepijn-poolman": "Pepijn Poolman",
  "pierre-leducq": "Pierre Leducq",
  priorblue: "PriorBlue",
  quoting: "Quoting",
  rihlsul: "Rihlsul",
  sbed: "Sbed",
  seregacthtuf: "SeregaCthtuf",
  skoll: "Skoll",
  sparker: "Sparker",
  spencerdub: "SpencerDub",
  starseeker: "Starseeker",
  "viscious-speed": "Viscious Speed",
  willdabeast: "Willdabeast",
  zajkonur: "Zajkonur",
  zeromancer: "Zeromancer",
};

/** Authors license.txt does not list, with the license their icon pages state. */
const EXTRA_AUTHORS: Record<string, { name: string; license: IconLicense }> = {
  // https://game-icons.net/1x1/various-artists/infinity.html says "CC0".
  "various-artists": { name: "Various artists", license: "CC0-1.0" },
};

/**
 * Folders that are not one author's icons. `badges` holds 59 badge frames
 * drawn on a 256 px circle, not icons in the 512 px square every icon uses.
 */
const NOT_AUTHOR_FOLDERS: ReadonlySet<string> = new Set(["badges"]);

const FOLDER = /^[a-z0-9-]{1,40}$/;
const NAME = /^[a-z0-9-]{1,60}$/;

export type IndexAuthor = { id: string; name: string; url?: string; license: IconLicense; icons: string[] };
export type IconIndex = { commit: string; authors: IndexAuthor[] };

/**
 * license.txt's author list: lines like `- Lorc, http://lorcblog.blogspot.com`,
 * `- PriorBlue` or `- Zeromancer - CC0`.
 */
export function parseLicenseText(text: string): Map<string, { url?: string; cc0: boolean }> {
  const out = new Map<string, { url?: string; cc0: boolean }>();
  for (const raw of text.split(/\r?\n/)) {
    const line = /^-\s+(.+?)\s*$/.exec(raw)?.[1];
    if (!line) continue;
    const cc0 = /\s-\s*CC0$/i.test(line);
    const [name, url] = line.replace(/\s-\s*CC0$/i, "").split(/,\s*/, 2);
    if (!name) continue;
    out.set(name.trim(), { ...(url && /^https?:\/\/\S+$/.test(url.trim()) ? { url: url.trim() } : {}), cc0 });
  }
  return out;
}

/** "wolf-head" reads "Wolf head". */
export function iconTitle(name: string): string {
  const words = name.split("-").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The shipped form of an icon: its one path with no fill, which reads as
 * opaque black, so a CSS mask and the canvas both take its shape, and an
 * explicit size, since an SVG with only a viewBox has none.
 */
export function shippedIconSvg(d: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="${d}"/></svg>\n`;
}

/**
 * The icon set from the repository's files: the index, and each icon's
 * shipped SVG by its key (`<author>/<name>`). Throws on anything it was not
 * reviewed to expect: an unknown folder, a file of another shape, a name the
 * key rule refuses, or an author license.txt no longer lists.
 */
export function buildIconSet(files: ReadonlyArray<{ path: string; text: string }>, commit: string): { index: IconIndex; svgs: Map<string, string> } {
  const licenseText = files.find((f) => f.path === "license.txt")?.text;
  if (licenseText === undefined) throw new Error("license.txt is missing");
  const listed = parseLicenseText(licenseText);
  const authors = new Map<string, IndexAuthor>();
  const svgs = new Map<string, string>();

  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length === 1) continue; // README, license.txt, the repository's own scripts
    const folder = parts[0]!;
    if (NOT_AUTHOR_FOLDERS.has(folder)) continue;
    if (parts.length !== 2) throw new Error(`${file.path}: an icon nested deeper than <author>/<name>.svg`);
    const fileName = parts[1]!;
    if (!fileName.endsWith(".svg")) throw new Error(`${file.path}: not an SVG`);
    const name = fileName.slice(0, -".svg".length);
    if (!FOLDER.test(folder) || !NAME.test(name)) throw new Error(`${file.path}: not a valid icon key`);

    let author = authors.get(folder);
    if (!author) {
      author = authorFor(folder, listed);
      authors.set(folder, author);
    }
    const d = GAME_ICON_SHAPE.exec(file.text)?.[1];
    if (!d) throw new Error(`${file.path}: unexpected game-icons.net SVG shape`);
    if (!PATH_DATA.test(d)) throw new Error(`${file.path}: unexpected characters in path data`);
    author.icons.push(name);
    svgs.set(`${folder}/${name}`, shippedIconSvg(d));
  }

  const sorted = [...authors.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const author of sorted) author.icons.sort();
  return { index: { commit, authors: sorted }, svgs };
}

function authorFor(folder: string, listed: Map<string, { url?: string; cc0: boolean }>): IndexAuthor {
  const extra = EXTRA_AUTHORS[folder];
  if (extra) return { id: folder, name: extra.name, license: extra.license, icons: [] };
  const name = AUTHOR_FOLDERS[folder];
  if (!name) throw new Error(`author folder ${folder} is in neither license.txt's table nor this script's: credit it before shipping it`);
  const entry = listed.get(name);
  if (!entry) throw new Error(`license.txt no longer lists ${name} (folder ${folder})`);
  return { id: folder, name, ...(entry.url ? { url: entry.url } : {}), license: entry.cc0 ? "CC0-1.0" : "CC-BY-3.0", icons: [] };
}

/** shared/gameIcons.ts, the one file the app imports from this build. */
export function gameIconsModule(index: IconIndex, dir: string): string {
  const authors = index.authors.map((a) => {
    const fields = [`id: ${JSON.stringify(a.id)}`, `name: ${JSON.stringify(a.name)}`];
    if (a.url) fields.push(`url: ${JSON.stringify(a.url)}`);
    fields.push(`license: ${JSON.stringify(a.license)}`, `icons: ${a.icons.length}`);
    return `  { ${fields.join(", ")} },`;
  });
  const total = index.authors.reduce((n, a) => n + a.icons.length, 0);
  return `/**
 * Written by \`node scripts/game-icons.ts\`. Do not edit by hand.
 *
 * The token icons from game-icons.net (docs/design-v1-dm-tools.md 3.12):
 * where the app serves them, and each author with their license and how
 * many of their icons ship. The icons themselves and their index are files
 * under public/, fetched only when shown, so this module stays small.
 */

export type GameIconAuthor = { id: string; name: string; url?: string; license: "CC-BY-3.0" | "CC0-1.0"; icons: number };

/** The served folder, named by the first 8 characters of the pinned commit so a new pin never meets an old cached file. */
export const GAME_ICONS_DIR = ${JSON.stringify(dir)};

export const GAME_ICONS_TOTAL = ${total};

export const GAME_ICON_AUTHORS: readonly GameIconAuthor[] = [
${authors.join("\n")}
];
`;
}

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  // No hooks and no templates: the fetched repository configures nothing here.
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Every blob's text, read in one `git cat-file --batch` so 4,000 files cost one process. */
function readBlobs(cwd: string, blobs: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd, stdio: ["pipe", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const out = Buffer.concat(chunks);
      const texts = new Map<string, string>();
      let at = 0;
      for (const sha of blobs) {
        const end = out.indexOf(0x0a, at);
        const header = out.subarray(at, end).toString("utf8").split(" ");
        if (header[0] !== sha || header[1] !== "blob") return reject(new Error(`unexpected cat-file header for ${sha}`));
        const size = Number(header[2]);
        texts.set(sha, out.subarray(end + 1, end + 1 + size).toString("utf8"));
        at = end + 1 + size + 1;
      }
      resolve(texts);
    });
    child.stdin.end(blobs.join("\n") + "\n");
  });
}

async function fetchRepository(scratch: string): Promise<Array<{ path: string; text: string }>> {
  const repo = join(scratch, "icons.git");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--quiet", "--bare"]);
  await git(repo, ["fetch", "--quiet", "--depth", "1", REPOSITORY, GAME_ICONS_COMMIT]);
  const commit = (await git(repo, ["rev-parse", "FETCH_HEAD"])).trim();
  if (commit !== GAME_ICONS_COMMIT) throw new Error(`fetched ${commit}, expected ${GAME_ICONS_COMMIT}`);
  const tree = (await git(repo, ["rev-parse", "FETCH_HEAD^{tree}"])).trim();
  if (tree !== GAME_ICONS_TREE) throw new Error(`the commit's tree is ${tree}, expected ${GAME_ICONS_TREE}`);

  const entries = (await git(repo, ["ls-tree", "-r", "-z", "FETCH_HEAD"]))
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, sha] = (meta ?? "").split(" ");
      if (!path || !sha || type !== "blob" || !/^100(644|755)$/.test(mode ?? "")) throw new Error(`unexpected tree entry ${line}`);
      return { path, sha };
    });
  const texts = await readBlobs(repo, entries.map((e) => e.sha));
  return entries.map((e) => ({ path: e.path, text: texts.get(e.sha) ?? "" }));
}

async function main(): Promise<void> {
  const given = process.argv[2];
  if (given && (await readdir(given).catch(() => [])).length > 0) throw new Error(`${given} is not empty. Give an empty scratch folder.`);
  const scratch = given ?? (await mkdtemp(join(tmpdir(), "game-icons-")));
  const files = await fetchRepository(scratch);
  const { index, svgs } = buildIconSet(files, GAME_ICONS_COMMIT);

  const dir = `/game-icons/${GAME_ICONS_COMMIT.slice(0, 8)}`;
  const out = join(ROOT, "public", ...dir.split("/").filter(Boolean));
  // Only the pinned commit's folder ships. An older pin's files go with it.
  await rm(join(ROOT, "public", "game-icons"), { recursive: true, force: true });
  for (const author of index.authors) await mkdir(join(out, author.id), { recursive: true });
  for (const [key, svg] of svgs) await writeFile(join(out, `${key}.svg`), svg);
  await writeFile(join(out, "index.json"), JSON.stringify(index));
  await writeFile(join(ROOT, "shared", "gameIcons.ts"), gameIconsModule(index, dir));

  const cc0 = index.authors.filter((a) => a.license === "CC0-1.0");
  console.log(`${svgs.size} icons by ${index.authors.length} authors into public${dir}`);
  console.log(`CC0: ${cc0.map((a) => `${a.name} (${a.icons.length})`).join(", ")}`);
  if (!given) await rm(scratch, { recursive: true, force: true });
}

if (import.meta.main) await main();
