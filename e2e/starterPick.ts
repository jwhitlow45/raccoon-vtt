import assert from "node:assert/strict";
import type { APIRequestContext, Locator } from "playwright-core";
import { packsFor, type FoundWork, type StarterUse, type StarterWork } from "#shared/starter.ts";
import { STARTER_PACKS } from "#shared/starterArt.ts";

/**
 * Picking a starter work in the Starter tab (docs/design-v1-starter-art.md
 * 4), for the e2e files of the places that offer one. The work is chosen
 * from the shipped catalog, so a step names a real pack and a real work
 * whatever the packs hold.
 */

/** The first work a place of `use` shows that passes `test`, as the tab lists them. */
export function starterWork(use: StarterUse, test: (work: StarterWork) => boolean = () => true): FoundWork {
  for (const pack of packsFor(STARTER_PACKS, [use])) {
    const work = pack.works.find(test);
    if (work) return { pack, work };
  }
  assert.fail(`no starter work for ${use} passes the test`);
}

/** How many packs and works a place of `use` shows, as the line over its tiles says. */
export function starterCounts(use: StarterUse): { packs: number; works: number } {
  const packs = packsFor(STARTER_PACKS, [use]);
  return { packs: packs.length, works: packs.reduce((n, p) => n + p.works.length, 0) };
}

/**
 * Chooses the work in the browser inside `within`: by its pack and its
 * category, opening the pack's fold when the place shows more than one, or
 * by searching its name. Then Use, unless `use` is false.
 */
export async function chooseStarterWork(within: Locator, found: FoundWork, how: "browse" | "search", use = true): Promise<void> {
  const { pack, work } = found;
  const search = within.getByRole("searchbox", { name: "Search the starter packs" });
  await search.waitFor();
  let tiles: Locator;
  if (how === "search") {
    await search.fill(work.name);
    tiles = within.getByRole("list", { name: pack.title, exact: true });
  } else {
    const fold = within.getByRole("button", { name: pack.title, exact: true });
    if ((await fold.count()) > 0 && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
    tiles = within.getByRole("list", { name: `${pack.title}: ${work.category}`, exact: true });
  }
  await tiles.getByRole("button", { name: work.name, exact: true }).first().click();
  // The credit under the tiles names the pack and its author.
  await within.getByText(`${pack.title}, by ${work.credit.author},`, { exact: false }).first().waitFor();
  if (use) await within.getByRole("button", { name: "Use", exact: true }).click();
}

/** The room's row for an image, as the library lists it, with its starter mark and credit. */
export async function assetRow(request: APIRequestContext, origin: string, roomId: string, id: string): Promise<{ id: string; kind: string; starter?: string; credit?: { creator?: string; title?: string } } | undefined> {
  const res = await request.get(`${origin}/api/rooms/${roomId}/assets`);
  assert.ok(res.ok(), `listing the room's images answered ${res.status()}`);
  const { assets } = (await res.json()) as { assets: { id: string; kind: string; starter?: string; credit?: { creator?: string; title?: string } }[] };
  return assets.find((a) => a.id === id);
}
