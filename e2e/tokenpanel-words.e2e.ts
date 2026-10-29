import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { waitFor } from "./harness.ts";
import { loneLastWord } from "./helpers/wraps.ts";
import { actor, cell, DESK, dm, dmCdp, dmSocket, groupIn, measureIn, openGroup, ops, panelFile, panelOf, player, playerCdp, playerSocket, run, setUp, shots } from "./tokenpanelRoom.ts";

/** FU39-C: a separate room for wrapped kind and size words (CISPEED-F6, E2E-SPLIT). */
panelFile("wrapped kind and size words", () => {
  test("fu33-a. no unit or word stands alone on a wrapped last line: the kind lines of the hound, a companion, and of the goblin, Thorn and the bear, and Pat's locked Size in his Stats, in line within 1 px at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, and the hound's and Pat's line with the window narrowed 1 px at a time from 430 to 320 px (FU32-FT-ALONE)", async () => {
    const hound = { id: randomUUID(), at: cell(6, 4) };
    await ops.send({ t: "token.create", token: { id: hound.id, sceneId: run.sceneId, size: "medium", visibility: "all", x: hound.at.x, y: hound.at.y, disposition: "ally", kind: "monster", name: "Hound", companion: { of: run.thorn.characterId, turn: "shared" }, actor: { inline: actor({ ac: 13, hp: { cur: 11, max: 11, temp: 0 } }) } } });
    await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { locked: true } });
    await waitFor("the hound, and Thorn locked for Pat", () => (dmSocket.state?.tokens[hound.id] && playerSocket.state?.tokens[run.thorn.id]?.locked ? true : null));
    const off: string[] = [];
    const lone = async (el: Locator, what: string) => {
      const word = await loneLastWord(el);
      if (word !== null) off.push(`${what}: "${word}" alone on its last line`);
    };
    const lockedSize = (panel: Locator) => groupIn(panel, "Stats").getByText(/^Medium \(5 ft\), locked by the DM$/);
    try {
      for (const view of [1440, 390, 320].flatMap((width) => [1, 1.3].map((scale) => ({ width, height: { 1440: 900, 390: 844, 320: 568 }[width]!, scale })))) {
        const at = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
        await setUp(dm, dmCdp, view, null);
        for (const [where, name] of [
          [hound.at, "Hound"],
          [run.goblin.at, "Goblin 4"],
          [run.thorn.at, "Thorn"],
          [run.bear.at, "Brown Bear"],
        ] as const) {
          const panel = await panelOf(dm, where, name);
          const kind = panel.locator("[data-creature-header] [data-kind-line]").first();
          await lone(kind, `${name}'s kind line at ${at}`);
          off.push(...(await measureIn(kind, `${name}'s kind line at ${at}`)));
          if (name === "Hound") await shots.take(dm, `fu33-kind-line-${view.width}-${Math.round(view.scale * 100)}`);
        }
        await setUp(player, playerCdp, view, null);
        const thorn = await panelOf(player, run.thorn.at, "Thorn");
        await openGroup(thorn, "Stats");
        await lone(lockedSize(thorn), `Pat's locked Size at ${at}`);
        off.push(...(await measureIn(groupIn(thorn, "Stats"), `Pat's Stats at ${at}`)));
      }
      // Every width between, so the one where the last word just wraps is crossed.
      const settled = (page: typeof dm) =>
        page.evaluate(() => {
          const g = globalThis as unknown as { requestAnimationFrame(fn: () => void): number };
          return new Promise<void>((done) => g.requestAnimationFrame(() => g.requestAnimationFrame(done)));
        });
      for (const scale of [1, 1.3]) {
        await setUp(dm, dmCdp, { width: 430, height: 844, scale }, null);
        const kind = (await panelOf(dm, hound.at, "Hound")).locator("[data-creature-header] [data-kind-line]").first();
        await setUp(player, playerCdp, { width: 430, height: 844, scale }, null);
        const thorn = await panelOf(player, run.thorn.at, "Thorn");
        await openGroup(thorn, "Stats");
        for (let width = 430; width >= 320; width--) {
          for (const [page, el, what] of [
            [dm, kind, "the hound's kind line"],
            [player, lockedSize(thorn), "Pat's locked Size"],
          ] as const) {
            await page.setViewportSize({ width, height: 844 });
            await settled(page);
            await lone(el, `${what} at ${width} px at ${Math.round(scale * 100)}%`);
          }
        }
      }
    } finally {
      await ops.send({ t: "token.delete", tokenId: hound.id });
      await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { locked: false } });
      await setUp(dm, dmCdp, DESK, null);
      await setUp(player, playerCdp, DESK, null);
    }
    assert.deepEqual(off, [], "a word alone, or out of line by more than 1 px");
  });
});
