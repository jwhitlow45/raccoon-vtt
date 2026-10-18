/**
 * The starter packs (docs/design-v1-starter-art.md): sets of openly
 * licensed art from one artist or project, which a DM picks from a Starter
 * tab of its own wherever art is chosen. The catalog itself is
 * shared/starterArt.ts and the stamps' list shared/starterStamps.ts, both
 * written by `node scripts/starter-art.ts` from scripts/starter-art.json.
 * This module holds their shapes and the rules that read them, apart from
 * the data, so the room's code can name a starter work without loading
 * the whole catalog: the client loads it with the panels it preloads, and
 * only the server and the About page import it at once.
 *
 * A pick of a map, token or handout copies the shipped file into the room
 * as an ordinary asset, marked with its work's key and carrying its credit
 * (section 5). A stamp stays a reference to its file in public/stamps, as
 * the shipped stamps are.
 */
import type { LicenseId } from "./licenses.ts";
import type { AssetCredit } from "./protocol.ts";

/** Where a work may be used: the three asset kinds a pick copies into, and the builder's stamps. */
export const STARTER_USES = ["map", "token", "handout", "stamp"] as const;
export type StarterUse = (typeof STARTER_USES)[number];

/** The asset kinds a pick can copy a work into. A stamp is never copied. */
export const STARTER_KINDS = ["map", "token", "handout"] as const;
export type StarterKind = (typeof STARTER_KINDS)[number];

/**
 * A work's key, `<pack>/<work>`, as an asset row's `starter` column and the
 * pick route carry it. Both parts are slugs, so a key is never a path.
 */
export const STARTER_KEY = /^[a-z0-9-]{1,40}\/[a-z0-9-]{1,40}$/;

/** A work's credit, as CREDITS.md, the About page and a picked image's credit give it. */
export type StarterCredit = {
  /** The work's own title, as its page names it. */
  title: string;
  author: string;
  /** The work's own page, where its license is stated. */
  source: string;
  license: LicenseId;
  /** Everything the build changed, as the license asks, worded for a reader. */
  changes: string;
  /** The line the author asks for, in the author's words, when they ask for one. */
  attribution?: string;
};

export type StarterWork = {
  /** `<pack>/<work>`, unique across the catalog. */
  key: string;
  /** The number the contact sheets give it, such as DY-01. */
  id: string;
  name: string;
  /** The heading it sits under inside its pack, such as "Taverns and inns". */
  category: string;
  tags: readonly string[];
  uses: readonly StarterUse[];
  /** The served path of the file: `/starter/<pack>/<work>.<ext>`, or `/stamps/<key>.webp` for a stamp. */
  file: string;
  /** SHA-256 of the file as shipped, in hex. A pick uploads these bytes, so its asset row has the same hash. */
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  /** The 256 px thumbnail's served path. Stamps have none: the stamp file is small enough to show. */
  thumb?: string;
  /**
   * A map's drawn grid on the file as shipped: the square's size in pixels,
   * where a line crosses near the top left when the build found it, and
   * feet per square when the map or its page says.
   */
  grid?: { cellPx: number; originPx?: { x: number; y: number }; feetPerCell?: number };
  /** A paper map's grid color: the app's white grid vanishes on white paper (section 7). */
  gridColor?: string;
  /** A stamp's key in the stamp list and the footprint it takes, in cells. */
  stamp?: { key: string; w: number; h: number };
  /** The original's size, before the build resized it. */
  original: { width: number; height: number };
  credit: StarterCredit;
};

export type StarterPack = {
  /** A slug, the first part of each of its works' keys and its folder under public/starter. */
  id: string;
  title: string;
  author: string;
  authorUrl?: string;
  /** The pack's page, where its license is stated. */
  page: string;
  /** A Wayback snapshot of that page that shows the license. */
  wayback: string;
  /** The pack's license, or each license its works carry when they differ. */
  licenses: readonly LicenseId[];
  /** What the build changed, for the pack as a whole. */
  changes: string;
  /** The credit line the author asks for, in the author's words, when they ask for one. */
  attribution?: string;
  /**
   * What the author says about credit when it is a note rather than a line
   * to print ("Not required. ... asks, as a courtesy, that the artist is
   * credited."). CREDITS.md gives it. A pick's credit line never carries it.
   */
  attributionNote?: string;
  works: readonly StarterWork[];
};

/** A starter stamp as the board knows it without the catalog, beside the shipped stamps of shared/stamps.ts. */
export type StarterStamp = { key: string; name: string; w: number; h: number; pack: string };

export type FoundWork = { pack: StarterPack; work: StarterWork };

/** Every work of a catalog by its key. */
export function indexWorks(packs: readonly StarterPack[]): ReadonlyMap<string, FoundWork> {
  const index = new Map<string, FoundWork>();
  for (const pack of packs) for (const work of pack.works) index.set(work.key, { pack, work });
  return index;
}

/**
 * The packs a place shows, each holding only its works of these uses, in
 * catalog order. A pack with none is left out.
 */
export function packsFor(packs: readonly StarterPack[], uses: readonly StarterUse[]): StarterPack[] {
  const wanted = new Set(uses);
  return packs.flatMap((pack) => {
    const works = pack.works.filter((work) => work.uses.some((use) => wanted.has(use)));
    return works.length > 0 ? [{ ...pack, works }] : [];
  });
}

/** A pack's categories in the order its works first name them. */
export function categoriesOf(pack: StarterPack): string[] {
  return [...new Set(pack.works.map((work) => work.category))];
}

/**
 * The works whose name, category, tags or pack hold every word typed, in
 * catalog order. Matching is on whole-word prefixes, so "owl" finds the
 * owlbear and not a bowl.
 */
export function searchWorks(packs: readonly StarterPack[], query: string): FoundWork[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found: FoundWork[] = [];
  for (const pack of packs) {
    for (const work of pack.works) {
      if (words.length === 0) {
        found.push({ pack, work });
        continue;
      }
      const text = [work.name, work.category, pack.title, pack.author, ...work.tags].join(" ").toLowerCase();
      const starts = text.split(/[^a-z0-9]+/).filter(Boolean);
      if (words.every((word) => starts.some((start) => start.startsWith(word)))) found.push({ pack, work });
    }
  }
  return found;
}

/**
 * The license as an image credit names it: Openverse's codes, since a
 * picked image keeps its credit in the same shape as an Openverse import's
 * (docs/design-v1-dm-tools.md 3.13). A public domain dedication is not a
 * Creative Commons tool, so it has a code of its own.
 */
export const CREDIT_LICENSE: Record<LicenseId, { license: string; licenseVersion?: string }> = {
  "CC0-1.0": { license: "cc0", licenseVersion: "1.0" },
  "CC-BY-3.0": { license: "by", licenseVersion: "3.0" },
  "CC-BY-4.0": { license: "by", licenseVersion: "4.0" },
  "CC-BY-SA-3.0": { license: "by-sa", licenseVersion: "3.0" },
  "CC-BY-SA-4.0": { license: "by-sa", licenseVersion: "4.0" },
  "public-domain-dedication": { license: "public-domain" },
  MIT: { license: "mit" },
  ISC: { license: "isc" },
  "OFL-1.1": { license: "ofl", licenseVersion: "1.1" },
  original: { license: "original" },
};

/**
 * The credit a picked image keeps on its asset row. It comes from the
 * shipped catalog, never from a request. The size is the file's as shipped,
 * the image as the room received it, so the credit says "Resized" only when
 * the room's copy differs from it, as an import's does.
 *
 * The room keeps every image as WebP, so a work shipped as PNG, such as an
 * ink map in four gray levels, says that change too. A public domain
 * dedication links the snapshot of the page that makes it, since the live
 * page may no longer show the statement. The attribution is the line the
 * author asks for, else "<title> by <author>", never a pack's note about
 * credit.
 */
export function starterAssetCredit({ pack, work }: FoundWork): AssetCredit {
  const license = CREDIT_LICENSE[work.credit.license];
  const attribution = work.credit.attribution ?? pack.attribution;
  const reencoded = work.file.endsWith(".webp") ? "" : " Converted to WebP for this room.";
  return {
    title: work.credit.title,
    creator: work.credit.author,
    ...license,
    landingUrl: work.credit.license === "public-domain-dedication" ? pack.wayback : work.credit.source,
    attribution: attribution ?? `${work.credit.title} by ${work.credit.author}`,
    changes: `${work.credit.changes}${reencoded}`,
    originalWidth: work.width,
    originalHeight: work.height,
  };
}
