/**
 * Writes shared/srd/tokenIcons.ts, the default token of every SRD monster
 * (docs/design-v1-starter-art.md section 6), from the reviewed table beside
 * this script. Run by hand when the table changes:
 *
 *   node scripts/srd-token-icons.ts
 *
 * The table, scripts/srd-token-icons.json, is the source a reviewer reads:
 * one row a monster in monsters.json's order, with its game-icons.net icon,
 * the disk's color, how close the icon comes to the creature (`exact`,
 * `close` or `generic`) and why it was picked. The disk is colored by
 * creature type, and a chromatic or metallic dragon by the color in its
 * name. Only the icon and the color reach the app. The rest stays here for
 * the next review.
 *
 * A row the app could not draw stops the run before anything is written:
 * an id the SRD data lacks, an icon the shipped set lacks, a color the icon
 * picker does not offer, or an SRD monster with no row. So the module never
 * names an icon that would fall back to initials, and a DM who opens the
 * picker on a default finds its color among the swatches.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ICON_COLORS } from "../client/features/images/iconColors.ts";
import { GAME_ICONS_DIR } from "../shared/gameIcons.ts";
import { ICON_KEY_RE } from "../shared/imageRef.ts";

const ROOT = join(import.meta.dirname, "..");
export const TABLE = join(ROOT, "scripts", "srd-token-icons.json");
export const MODULE = join(ROOT, "shared", "srd", "tokenIcons.ts");

export type Match = "exact" | "close" | "generic";
export type TokenIconRow = { srdId: string; icon: string; color: string; match: Match; why: string };

const MATCHES: ReadonlySet<string> = new Set<Match>(["exact", "close", "generic"]);

/** The table as committed, every field checked for its shape. */
export function parseTable(json: unknown): TokenIconRow[] {
  if (!Array.isArray(json)) throw new Error("the table is not an array");
  return json.map((raw, i) => {
    const row = raw as Partial<Record<keyof TokenIconRow, unknown>> | null;
    const { srdId, icon, color, match, why } = row ?? {};
    if (typeof srdId !== "string" || typeof icon !== "string" || typeof color !== "string" || typeof why !== "string" || typeof match !== "string" || !MATCHES.has(match)) {
      throw new Error(`row ${i + 1} is not { srdId, icon, color, match, why }: ${JSON.stringify(raw)}`);
    }
    return { srdId, icon, color, match: match as Match, why };
  });
}

/** What the app knows: the SRD's ids in order, the shipped icons' keys, the disk colors the picker offers. */
export type Known = { srdIds: readonly string[]; icons: ReadonlySet<string>; colors: readonly string[] };

/** Every way the table disagrees with the app, one line each, or none. */
export function tableProblems(rows: readonly TokenIconRow[], known: Known): string[] {
  const problems: string[] = [];
  const ids = new Set(known.srdIds);
  const colors = new Set(known.colors);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.srdId)) problems.push(`${row.srdId} has two rows`);
    seen.add(row.srdId);
    if (!ids.has(row.srdId)) problems.push(`${row.srdId} is not an SRD monster`);
    if (!ICON_KEY_RE.test(row.icon)) problems.push(`${row.srdId}: ${row.icon} is not an icon key`);
    else if (!known.icons.has(row.icon)) problems.push(`${row.srdId}: ${row.icon} is not in the shipped icon set`);
    if (!colors.has(row.color)) problems.push(`${row.srdId}: ${row.color} is not a disk color the picker offers`);
  }
  for (const id of known.srdIds) if (!seen.has(id)) problems.push(`${id} has no row`);
  return problems;
}

/** shared/srd/tokenIcons.ts for these rows, in their order. */
export function tokenIconsModule(rows: readonly TokenIconRow[]): string {
  const lines = rows.map((r) => `  ${JSON.stringify(r.srdId)}: { icon: ${JSON.stringify(r.icon)}, color: ${JSON.stringify(r.color)} },`);
  return `/**
 * Written by \`node scripts/srd-token-icons.ts\` from scripts/srd-token-icons.json. Do not edit by hand.
 *
 * The default token of every SRD monster (docs/design-v1-starter-art.md
 * section 6): a shipped game-icons.net icon on a disk colored by its
 * creature type. A room's own image for the monster wins over it
 * (client/features/monsters/images.ts). Nothing here is stored in a room,
 * so a room made before the defaults existed shows them too.
 */
import type { IconImage, SrdId } from "../model.ts";

export const SRD_TOKEN_ICONS: Readonly<Record<SrdId, Readonly<IconImage>>> = {
${lines.join("\n")}
};
`;
}

/** The app's side of the check, read from the files it ships. */
export function readKnown(): Known {
  const monsters = JSON.parse(readFileSync(join(ROOT, "shared", "srd", "monsters.json"), "utf8")) as { srdId: string }[];
  const index = JSON.parse(readFileSync(join(ROOT, "public", ...GAME_ICONS_DIR.split("/").filter(Boolean), "index.json"), "utf8")) as { authors: { id: string; icons: string[] }[] };
  const icons = new Set(index.authors.flatMap((a) => a.icons.map((name) => `${a.id}/${name}`)));
  return { srdIds: monsters.map((m) => m.srdId), icons, colors: ICON_COLORS };
}

export function readTable(): TokenIconRow[] {
  return parseTable(JSON.parse(readFileSync(TABLE, "utf8")));
}

function main(): void {
  const rows = readTable();
  const problems = tableProblems(rows, readKnown());
  if (problems.length > 0) throw new Error(`the table disagrees with the app:\n${problems.join("\n")}`);
  writeFileSync(MODULE, tokenIconsModule(rows));
  const counts = new Map<Match, number>();
  for (const r of rows) counts.set(r.match, (counts.get(r.match) ?? 0) + 1);
  console.log(`${rows.length} monsters, ${new Set(rows.map((r) => r.icon)).size} distinct icons: ${[...counts].map(([m, n]) => `${n} ${m}`).join(", ")}`);
}

if (import.meta.main) main();
