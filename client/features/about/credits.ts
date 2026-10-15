import { CREDITS, LICENSES, TOKEN_ICONS, type Credit, type CreditGroup, type LicenseId } from "#shared/credits.ts";

/**
 * The About page's credits, shaped for display from shared/credits.ts, the
 * same list CREDITS.md carries. CC BY asks for the title, the author, the
 * source, the license and what was changed, so every row keeps all five.
 * A note shared by a whole group (every game-icons.net icon had the same
 * mechanical change) is said once above the group instead of on each row.
 */

export type CreditRow = {
  key: string;
  title: string;
  author: string;
  authorUrl: string | null;
  /** A web page, or null when the source is a file in this repository. */
  sourceUrl: string | null;
  source: string;
  license: { id: LicenseId; name: string; url: string | null };
  changes: string | null;
};

export type CreditSection = { id: CreditGroup["id"]; heading: string; changes: string | null; rows: CreditRow[] };

const isWeb = (url: string | undefined): url is string => url !== undefined && /^https?:\/\//.test(url);

function row(credit: Credit, sharedChanges: string | null): CreditRow {
  const license = LICENSES[credit.license];
  return {
    key: credit.files.join("|"),
    title: credit.title,
    author: credit.author,
    authorUrl: isWeb(credit.authorUrl) ? credit.authorUrl : null,
    sourceUrl: isWeb(credit.source) ? credit.source : null,
    source: credit.source,
    license: { id: credit.license, name: license.name, url: license.url },
    changes: sharedChanges === null ? credit.changes : null,
  };
}

export function creditSections(groups: CreditGroup[] = CREDITS): CreditSection[] {
  return groups.map((group) => {
    const first = group.credits[0]?.changes ?? null;
    const shared = group.credits.length > 1 && group.credits.every((c) => c.changes === first) ? first : null;
    return { id: group.id, heading: group.heading, changes: shared, rows: group.credits.map((c) => row(c, shared)) };
  });
}

export type TokenIconAuthorRow = { id: string; name: string; url: string | null; icons: number; license: LicenseId };
export type TokenIconLicense = { id: LicenseId; name: string; url: string | null; icons: number; authors: string[] };

export type TokenIconsSection = {
  heading: string;
  /** The mention game-icons.net asks for: "Icons made by {author}. Available on https://game-icons.net". */
  madeBy: string;
  site: string;
  changes: string;
  licenses: TokenIconLicense[];
  /** Most icons first, so the few who made most of the set lead the list. */
  authors: TokenIconAuthorRow[];
};

/**
 * The About page's "Token icons" group (docs/design-v1-dm-tools.md 3.12):
 * one line naming the authors as the site asks, each license with how many
 * icons it covers, and every author with their count. 4,180 rows, one per
 * icon, would bury every other credit, and the picker credits each icon
 * where it is chosen.
 */
export function tokenIconsSection(credit: typeof TOKEN_ICONS = TOKEN_ICONS): TokenIconsSection {
  const named = credit.leadAuthors.flatMap((id) => credit.authors.find((a) => a.id === id)?.name ?? []);
  const others = credit.authors.length - named.length;
  const madeBy = `Icons made by ${named.join(", ")}${others > 0 ? ` and ${others} ${others === 1 ? "other" : "others"}` : ""}.`;
  const licenses = new Map<LicenseId, TokenIconLicense>();
  for (const author of credit.authors) {
    const entry = licenses.get(author.license) ?? { id: author.license, ...LICENSES[author.license], icons: 0, authors: [] };
    entry.icons += author.icons;
    entry.authors.push(author.name);
    licenses.set(author.license, entry);
  }
  const authors = credit.authors
    .map((a) => ({ id: a.id, name: a.name, url: isWeb(a.url) ? a.url : null, icons: a.icons, license: a.license }))
    .sort((a, b) => b.icons - a.icons || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return {
    heading: credit.heading,
    madeBy,
    site: credit.site,
    changes: credit.changes,
    licenses: [...licenses.values()].sort((a, b) => b.icons - a.icons),
    authors,
  };
}

/** "A, B and C". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
