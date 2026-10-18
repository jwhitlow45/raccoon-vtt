import { useCallback, useEffect, useState } from "react";
import { LICENSES } from "#shared/licenses.ts";
import { GAME_ICON_AUTHORS, GAME_ICONS_DIR, type GameIconAuthor } from "#shared/gameIcons.ts";
import { ICON_KEY_RE } from "#shared/imageRef.ts";
import type { ImageRef } from "#shared/model.ts";
import { preloadInBackground } from "../../lib/retryableLazy.ts";

/**
 * Shipped game-icons.net tokens (docs/design-v1-dm-tools.md 3.12). An icon
 * is a key, `<author>/<name>`, and a disk color. Its art is a file of one
 * path under public/game-icons, fetched only when something shows it and
 * then kept by the browser for good, since the folder is named by the
 * pinned commit.
 *
 * "Works offline" means the icons need no outside service: the index the
 * picker searches loads with the panels the room preloads once connected,
 * so a device that later loses its connection can still search and pick
 * one, and the edit queues like any other. A token whose icon file has not
 * arrived draws its initials on the disk, and a picker tile the device
 * never fetched shows the icon's name.
 */

// ---------------------------------------------------------------- the index

export type IconEntry = {
  key: string;
  author: string;
  name: string;
  /** "Wolf head", from the name "wolf-head". */
  title: string;
  /** Lowercase words of the name and the author, which the search matches against. */
  words: readonly string[];
};

export type IconCatalog = { entries: readonly IconEntry[]; byKey: ReadonlyMap<string, IconEntry> };

const AUTHORS: ReadonlyMap<string, GameIconAuthor> = new Map(GAME_ICON_AUTHORS.map((a) => [a.id, a]));

/** "wolf-head" reads "Wolf head". */
export function iconTitle(name: string): string {
  const words = name.split("-").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The index as the build writes it, `{commit, authors: [{id, icons}]}`.
 * Anything that is not a valid key is left out rather than trusted, and an
 * author the app's credits do not know is left out too, so nothing reaches
 * the picker without a credit to show.
 */
export function parseIconIndex(json: unknown): IconCatalog {
  const authors = (json as { authors?: unknown } | null)?.authors;
  if (!Array.isArray(authors)) throw new Error("not an icon index");
  const entries: IconEntry[] = [];
  for (const raw of authors) {
    const id = (raw as { id?: unknown } | null)?.id;
    const icons = (raw as { icons?: unknown } | null)?.icons;
    if (typeof id !== "string" || !Array.isArray(icons)) continue;
    const author = AUTHORS.get(id);
    if (!author) continue;
    const authorWords = [...new Set([...wordsOf(id), ...wordsOf(author.name)])];
    for (const name of icons) {
      if (typeof name !== "string") continue;
      const key = `${id}/${name}`;
      if (!ICON_KEY_RE.test(key)) continue;
      entries.push({ key, author: id, name, title: iconTitle(name), words: [...wordsOf(name), ...authorWords] });
    }
  }
  entries.sort(byTitle);
  return { entries, byKey: new Map(entries.map((e) => [e.key, e])) };
}

function byTitle(a: IconEntry, b: IconEntry): number {
  return a.title.localeCompare(b.title, "en", { sensitivity: "base" }) || a.author.localeCompare(b.author);
}

/**
 * The icons that match every word typed, best first. A word matches when a
 * word of the icon's name or author starts with it ("drag" finds "dragon",
 * "lorc" the author), or, from three letters, when the name holds it
 * anywhere ("ragon"). A plural also matches its singular ("goblins").
 * Names that are the word itself come first, then those where it starts a
 * word, and shorter names before longer ones, so "goblin" leads "goblin
 * head". An empty search lists every icon by title.
 */
export function searchIcons(catalog: IconCatalog, query: string): IconEntry[] {
  const typed = wordsOf(query);
  if (typed.length === 0) return [...catalog.entries];
  const scored: { entry: IconEntry; score: number }[] = [];
  for (const entry of catalog.entries) {
    let score = 0;
    let matched = true;
    for (const word of typed) {
      const s = wordScore(entry, word);
      if (s === null) {
        matched = false;
        break;
      }
      score += s;
    }
    if (matched) scored.push({ entry, score: score * 100 + entry.name.split("-").length });
  }
  scored.sort((a, b) => a.score - b.score || byTitle(a.entry, b.entry));
  return scored.map((s) => s.entry);
}

/** 0 for a whole word, 1 for the start of one, 2 inside the name, or null for no match. */
function wordScore(entry: IconEntry, word: string): number | null {
  const forms = word.length > 3 && word.endsWith("s") ? [word, word.slice(0, -1)] : [word];
  let best: number | null = null;
  for (const form of forms) {
    for (const w of entry.words) {
      if (w === form) return 0;
      if (w.startsWith(form)) best = Math.min(best ?? 1, 1);
    }
    if (best === null && form.length >= 3 && entry.name.replace(/-/g, "").includes(form)) best = 2;
  }
  return best;
}

/** Where an icon's file is served, or null for a key that is not one. */
export function iconUrl(key: string): string | null {
  return ICON_KEY_RE.test(key) ? `${GAME_ICONS_DIR}/${key}.svg` : null;
}

/**
 * The credit shown where an icon is chosen, as the design words it: "Wolf
 * head by Lorc, CC BY 3.0". It reads the author table shipped with the app,
 * so it shows offline and before the index loads. Null for an author the
 * table does not know.
 */
export function iconCredit(key: string): { title: string; author: string; license: string; licenseUrl: string | null; text: string } | null {
  const [id, name] = key.split("/");
  const author = id ? AUTHORS.get(id) : undefined;
  if (!author || !name) return null;
  const license = LICENSES[author.license];
  const title = iconTitle(name);
  return { title, author: author.name, license: license.name, licenseUrl: license.url, text: `${title} by ${author.name}, ${license.name}` };
}

let indexLoad: Promise<IconCatalog> | null = null;
let indexReady: IconCatalog | null = null;
const indexListeners = new Set<() => void>();

/** Fetches the index once. A failed load is forgotten, so the next asks again. */
export function loadIconIndex(): Promise<IconCatalog> {
  indexLoad ??= fetch(`${GAME_ICONS_DIR}/index.json`, { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`the icon index answered ${res.status}`);
      const catalog = parseIconIndex(await res.json());
      indexReady = catalog;
      for (const listener of indexListeners) listener();
      return catalog;
    })
    .catch((err: unknown) => {
      indexLoad = null;
      throw err;
    });
  return indexLoad;
}

// Both roles may pick icons, for their own characters and tokens.
preloadInBackground(loadIconIndex, ["dm", "player"]);

export type IndexState = { status: "loading" } | { status: "ready"; catalog: IconCatalog } | { status: "failed"; retry(): void };

/** The index for the picker: ready at once when the background load finished, else loading, or failed with a retry. */
export function useIconIndex(): IndexState {
  const [, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const start = useCallback(() => {
    setFailed(false);
    loadIconIndex().catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    indexListeners.add(listener);
    if (!indexReady) start();
    return () => {
      indexListeners.delete(listener);
    };
  }, [start]);
  if (indexReady) return { status: "ready", catalog: indexReady };
  return failed ? { status: "failed", retry: start } : { status: "loading" };
}

// ---------------------------------------------------------------- one icon's art

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\se-]+$/;
const SHIPPED = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512" width="512" height="512"><path d="([^"]+)"\/><\/svg>\s*$/;

/** The one path of a shipped icon file, or null for anything else (a page, an error, a file of another shape). */
export function iconPathData(svg: string): string | null {
  const d = SHIPPED.exec(svg)?.[1];
  return d && PATH_DATA.test(d) ? d : null;
}

/** A loaded icon's path, or `missing` for a key the server has no file for. */
type Glyph = { d: string } | "missing";

const glyphs = new Map<string, Glyph>();
const glyphLoads = new Map<string, Promise<Glyph>>();

/**
 * One fetch per icon for the whole page. A 404 or a file that is not an
 * icon is remembered as missing, since asking again finds the same. A
 * network failure is not remembered, so the next ask (on reconnecting)
 * tries again.
 */
export function loadGlyph(key: string): Promise<Glyph> {
  const done = glyphs.get(key);
  if (done) return Promise.resolve(done);
  let pending = glyphLoads.get(key);
  if (!pending) {
    const url = iconUrl(key);
    pending = (
      url
        ? fetch(url, { credentials: "same-origin" }).then(async (res): Promise<Glyph> => {
            if (res.status === 404) return "missing";
            if (!res.ok) throw new Error(`icon ${key} answered ${res.status}`);
            const d = iconPathData(await res.text());
            return d ? { d } : "missing";
          })
        : Promise.resolve<Glyph>("missing")
    ).then(
      (glyph) => {
        glyphs.set(key, glyph);
        glyphLoads.delete(key);
        return glyph;
      },
      (err: unknown) => {
        glyphLoads.delete(key);
        throw err;
      },
    );
    glyphLoads.set(key, pending);
  }
  return pending;
}

export type GlyphState = { status: "ready"; d: string } | { status: "loading" } | { status: "missing" } | { status: "offline" };

function stateOf(glyph: Glyph | undefined): GlyphState | null {
  if (!glyph) return null;
  return glyph === "missing" ? { status: "missing" } : { status: "ready", d: glyph.d };
}

/**
 * An icon's path for drawing. `offline` when the fetch failed, which it
 * tries again when the browser says it is back online. A key the server
 * does not have is `missing` for good, and draws as initials, as a stamp
 * key the client does not know draws as a dashed box.
 */
export function useIconGlyph(key: string | null): GlyphState {
  const [state, setState] = useState<{ key: string; state: GlyphState } | null>(null);
  useEffect(() => {
    if (key === null || glyphs.has(key)) return;
    let live = true;
    const attempt = () => {
      loadGlyph(key).then(
        (glyph) => live && setState({ key, state: stateOf(glyph)! }),
        () => live && setState({ key, state: { status: "offline" } }),
      );
    };
    attempt();
    window.addEventListener("online", attempt);
    return () => {
      live = false;
      window.removeEventListener("online", attempt);
    };
  }, [key]);
  if (key === null) return { status: "missing" };
  return stateOf(glyphs.get(key)) ?? (state?.key === key ? state.state : { status: "loading" });
}

/** What a token or a portrait shows: its upload once decoded, an icon's glyph once its file is here, or else initials. */
export type ImageFace = "upload" | "glyph" | "initials";

export function imageFace(image: ImageRef | null | undefined, uploadReady: boolean, glyph: GlyphState): ImageFace {
  if (!image) return "initials";
  if ("assetId" in image) return uploadReady ? "upload" : "initials";
  return glyph.status === "ready" ? "glyph" : "initials";
}

/** Forgets every loaded icon file, for tests. */
export function resetGlyphsForTest(): void {
  glyphs.clear();
  glyphLoads.clear();
}

const paths = new Map<string, Path2D>();

/** One Path2D per icon, shared by every token that wears it, so a crowd of goblins parses the path once. */
export function iconPath2D(key: string, d: string): Path2D {
  let path = paths.get(key);
  if (!path) {
    path = new Path2D(d);
    paths.set(key, path);
  }
  return path;
}

// ---------------------------------------------------------------- the disk

// The swatches live in a module of their own, which a Node script can read without this file's browser code.
export { DEFAULT_ICON_COLOR, ICON_COLORS, ICON_NEUTRALS } from "./iconColors.ts";

const NEAR_BLACK = "#16161a";
const WHITE = "#ffffff";

function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return null;
  const channel = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(m[1]!) + 0.7152 * channel(m[2]!) + 0.0722 * channel(m[3]!);
}

/**
 * The glyph's color on a disk: white or near-black, whichever has the
 * higher contrast ratio with it (WCAG's relative luminance). Worked out on
 * the device, never stored.
 */
export function glyphColor(disk: string): string {
  const l = luminance(disk);
  if (l === null) return WHITE;
  const dark = luminance(NEAR_BLACK)!;
  return (1.05 / (l + 0.05)) >= (l + 0.05) / (dark + 0.05) ? WHITE : NEAR_BLACK;
}

/**
 * The glyph's side on a disk `w` by `h`: inside the circle a token clips to,
 * or most of a square object, since the art runs close to its 512 px edges.
 */
export function glyphSide(w: number, h: number, shape: "circle" | "square"): number {
  return Math.min(w, h) * (shape === "circle" ? 0.68 : 0.82);
}
