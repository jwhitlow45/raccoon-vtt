import { LICENSES } from "#shared/licenses.ts";
import { categoriesOf, searchWorks, type FoundWork, type StarterPack, type StarterWork } from "#shared/starter.ts";

/**
 * What the Starter tab shows (docs/design-v1-starter-art.md 4), apart from
 * React so it is tested: a pack's line, its works by category, a search's
 * results by pack, and the credit under the chosen tile.
 */

/** A search shows at most this many tiles, so a word that matches most of the catalog never mounts hundreds at once. */
export const SEARCH_SHOWN = 60;

const count = (n: number) => `${n} ${n === 1 ? "work" : "works"}`;

/** The license names a pack's works carry, in the order the pack lists them. */
export function packLicenses(pack: Pick<StarterPack, "licenses">): string {
  return pack.licenses.map((id) => LICENSES[id].name).join(" and ");
}

/** The line under a pack's name: "Oozejar, CC BY-SA 4.0, 60 works". */
export function packLine(pack: StarterPack): string {
  return `${pack.author}, ${packLicenses(pack)}, ${count(pack.works.length)}`;
}

export type Category = { name: string; works: StarterWork[] };

/** A pack's works under their categories, in the order the pack first names each. */
export function byCategory(pack: StarterPack): Category[] {
  return categoriesOf(pack).map((name) => ({ name, works: pack.works.filter((w) => w.category === name) }));
}

export type SearchGroups = { groups: { pack: StarterPack; works: StarterWork[] }[]; total: number; shown: number };

/** A search's results (searchWorks) by pack, in catalog order, cut at `cap` tiles. */
export function searchGroups(packs: readonly StarterPack[], query: string, cap: number = SEARCH_SHOWN): SearchGroups {
  const found = searchWorks(packs, query);
  const groups: SearchGroups["groups"] = [];
  for (const { pack, work } of found.slice(0, cap)) {
    const last = groups.at(-1);
    if (last && last.pack.id === pack.id) last.works.push(work);
    else groups.push({ pack, works: [work] });
  }
  return { groups, total: found.length, shown: Math.min(found.length, cap) };
}

/** The line over the tiles, read out as it changes. */
export function resultLine(input: { packs: readonly StarterPack[]; query: string; search: SearchGroups | null }): string {
  const { search } = input;
  if (!search || !input.query.trim()) {
    const works = input.packs.reduce((n, p) => n + p.works.length, 0);
    return `${input.packs.length} ${input.packs.length === 1 ? "pack" : "packs"}, ${count(works)}.`;
  }
  if (search.total === 0) return "Nothing matches. Try fewer or shorter words.";
  if (search.shown < search.total) return `${search.total} works match. The first ${search.shown} are shown, so type more to narrow it.`;
  return `${search.total === 1 ? "1 work matches" : `${search.total} works match`}.`;
}

/** The picture a tile shows: the 256 px thumbnail, or a stamp's own small file. */
export function tileSource(work: Pick<StarterWork, "thumb" | "file">): string {
  return work.thumb ?? work.file;
}

export type WorkCredit = { name: string; pack: string; author: string; license: string; licenseUrl: string | null };

/**
 * The credit under the chosen tile: the work's name, its pack, and the
 * author and license of the work itself, which in a pack of mixed licenses
 * (Flare's portraits) differ from work to work.
 */
export function workCredit({ pack, work }: FoundWork): WorkCredit {
  const license = LICENSES[work.credit.license];
  return { name: work.name, pack: pack.title, author: work.credit.author, license: license.name, licenseUrl: license.url };
}

/** The work under a key among the packs shown, or null. */
export function findShown(packs: readonly StarterPack[], key: string | null): FoundWork | null {
  if (!key) return null;
  for (const pack of packs) {
    const work = pack.works.find((w) => w.key === key);
    if (work) return { pack, work };
  }
  return null;
}
