import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { expandBar, openSideTab, waitFor } from "./harness.ts";
import { actor, afterPpLines, atLp22Sizes, bar, cell, DESK, dm, dmCdp, dmSocket, groupIn, measureIn, openGroup, ops, panelFile, panelOf, pastLineEnd, resize, run, sectionIn, setUp, SHEET, shots, tapToken } from "./tokenpanelRoom.ts";

/** FU39-C: a separate room for life, conditions, fight buttons and quick numbers (CISPEED-F6, E2E-SPLIT). */
panelFile("life, conditions, fight buttons and quick numbers", () => {
  test("fu31-h. dying Thorn's Revive, Stabilize and Mark dead leave no button alone under the others, in line within 1 px at live play 22's sizes (LP22-ALIGN-4)", async () => {
    const hp = dmSocket.state!.characters[run.thorn.characterId]!.actor.hp;
    // Down to 0 exactly: damage past the maximum would kill outright.
    await ops.send({ t: "actor.hp", target: { characterId: run.thorn.characterId }, change: { kind: "damage", amount: hp.cur + hp.temp } });
    await waitFor("Thorn dying", () => (dmSocket.state?.characters[run.thorn.characterId]?.actor.life === "dying" ? true : null));
    try {
      const off = await atLp22Sizes(async (at) => {
        const thorn = await panelOf(dm, run.thorn.at, "Thorn");
        const life = thorn.locator("[data-life-controls]");
        await life.getByRole("button", { name: "Mark dead" }).waitFor();
        await shots.take(dm, `fu31-dying-${at.replace(/ /g, "")}`);
        return measureIn(life.locator("xpath=.."), `dying Thorn's Hit Points at ${at}`);
      });
      assert.deepEqual(off, [], "out of line by more than 1 px");
    } finally {
      await ops.send({ t: "actor.life", target: { characterId: run.thorn.characterId }, life: "alive" });
      await ops.send({ t: "actor.hp", target: { characterId: run.thorn.characterId }, change: { kind: "set", cur: hp.cur, temp: hp.temp } });
    }
  });

  test("fu31-i. a counted condition's row is as tall as a plain one: Exhaustion 2 with its − and + beside Poisoned, on the goblin and on a desk on Thorn's page, in line within 1 px at live play 22's sizes (LP22-ALIGN-5, FU31 review F8)", async () => {
    const added = [randomUUID(), randomUUID()];
    const thorn = [randomUUID(), randomUUID()];
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblin.id }, effect: { id: added[0]!, key: "exhaustion", level: 2 } });
    await ops.send({ t: "actor.effect.add", target: { tokenId: run.goblin.id }, effect: { id: added[1]!, key: "poisoned" } });
    await ops.send({ t: "actor.effect.add", target: { characterId: run.thorn.characterId }, effect: { id: thorn[0]!, key: "exhaustion", level: 2 } });
    await ops.send({ t: "actor.effect.add", target: { characterId: run.thorn.characterId }, effect: { id: thorn[1]!, key: "poisoned" } });
    try {
      const off = await atLp22Sizes(async (at) => {
        const goblin = await panelOf(dm, run.goblin.at, "Goblin 4");
        const conditions = sectionIn(groupIn(goblin, "Combat"), "Conditions");
        await conditions.getByRole("button", { name: /one more$/ }).waitFor();
        await shots.take(dm, `fu31-conditions-${at.replace(/ /g, "")}`);
        const rows = await conditions.locator("li").evaluateAll((items) => items.map((li) => `${((li as unknown as { textContent: string | null }).textContent ?? "").trim().slice(0, 14)} ${(li as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect().height.toFixed(1)}`));
        console.log(`fu31-i ${at}: ${rows.join(" | ")}`);
        const lines = await measureIn(conditions, `the goblin's Conditions at ${at}`);
        if (!at.startsWith("1440") && !at.startsWith("1280")) return lines;
        await openSideTab(dm, "Characters");
        const page = dm.getByRole("tabpanel", { name: "Characters" });
        await page.locator(`[data-opener="character:${run.thorn.characterId}"]`).click();
        await openGroup(page, "Combat");
        const own = sectionIn(groupIn(page, "Combat"), "Conditions");
        await own.getByRole("button", { name: /one more$/ }).waitFor();
        await own.scrollIntoViewIfNeeded();
        await shots.take(dm, `fu31-conditions-thorn-${at.replace(/ /g, "")}`);
        return [...lines, ...(await measureIn(own, `Thorn's Conditions at ${at}`))];
      });
      assert.deepEqual(off, [], "out of line by more than 1 px");
    } finally {
      for (const effectId of added) await ops.send({ t: "actor.effect.remove", target: { tokenId: run.goblin.id }, effectId }).catch((err: unknown) => console.error("fu31-i: a condition stayed", err));
      for (const effectId of thorn) await ops.send({ t: "actor.effect.remove", target: { characterId: run.thorn.characterId }, effectId }).catch((err: unknown) => console.error("fu31-i: a condition stayed on Thorn", err));
    }
  });

  test("fu31-j. with no fight, the side panel's Start a fight with leaves no button alone under the others, at 1440 x 900 and 1280 x 800, at 85%, 100%, 115% and 130% (LP22-ALIGN-6)", async () => {
    const off: string[] = [];
    try {
      for (const scale of [0.85, 1, 1.15, 1.3]) {
        for (const [i, size] of [{ width: 1440, height: 900 }, DESK].entries()) {
          const at = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
          if (i === 0) await setUp(dm, dmCdp, { ...size, scale }, null);
          else await resize(dm, dmCdp, size);
          await openSideTab(dm, "Initiative");
          const start = dm.locator("section").filter({ has: dm.getByRole("heading", { name: "Start a fight with", exact: true }) }).last();
          await start.getByRole("button", { name: "Nobody yet", exact: true }).waitFor();
          off.push(...(await measureIn(start, `Start a fight with at ${at}`)));
        }
      }
    } finally {
      await setUp(dm, dmCdp, DESK, null);
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("fu31-m. the item after Passive Perception sits beside it wherever it fits: the panel's header for the dragon and Swift, and the window's summary for a five-speed scout with its Sheet link, at 1280 x 800, 390 x 844 and 480 x 320 at 130%, and the scout at 390 x 844 at 130% and 320 x 568 (FU31 review F1)", async () => {
    const scout = { id: randomUUID(), at: cell(6, 4) };
    await ops.send({ t: "token.create", token: { id: scout.id, sceneId: run.sceneId, size: "medium", visibility: "all", x: scout.at.x, y: scout.at.y, disposition: "hostile", kind: "monster", name: "Climbing Scout", actor: { inline: actor({ ac: 14, speeds: { walk: 40, burrow: 20, climb: 40, fly: 80, swim: 30 }, passivePerception: 23, sheetUrl: SHEET }) } } });
    await waitFor("the scout", () => dmSocket.state?.tokens[scout.id]);
    const off: string[] = [];
    try {
      for (const size of [
        { ...DESK, label: "1280 x 800" },
        { width: 390, height: 844, scale: 1, label: "390 x 844" },
        { width: 480, height: 320, scale: 1.3, insets: { side: 47, bottom: 21 }, label: "480 x 320 at 130%" },
        // Narrower summaries, for the scout alone, where its five speeds, PP and Sheet take two lines or three.
        { width: 390, height: 844, scale: 1.3, label: "390 x 844 at 130%", scoutOnly: true },
        { width: 320, height: 568, scale: 1, label: "320 x 568", scoutOnly: true },
      ]) {
        await setUp(dm, dmCdp, size, null);
        for (const [at, name] of "scoutOnly" in size ? [] : ([
          [run.dragon.at, "Adult White Dragon"],
          [run.swift.at, "Swift"],
        ] as const)) {
          const panel = await panelOf(dm, at, name);
          off.push(...(await afterPpLines(panel.locator("[data-quick-numbers]"), `${size.label}, ${name}'s panel header`)));
          await shots.take(dm, `fu31-after-pp-${size.width}-${name.split(" ")[0]!.toLowerCase()}`);
          for (let i = 0; i < 3 && (await panel.count()) > 0 && (await panel.getByText("Tap a token to see it here.").count()) === 0; i++) await dm.keyboard.press("Escape");
        }
        await dm.keyboard.press("Escape");
        await tapToken(dm, scout.at);
        const b = bar(dm, "Climbing Scout");
        await b.waitFor();
        await expandBar(b);
        const more = b.getByRole("button", { name: "More stats", exact: true });
        if ((await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
        off.push(...(await afterPpLines(b.locator("[data-vitals]"), `${size.label}, the scout's summary`)));
        await shots.take(dm, `fu31-after-pp-${size.width}-${Math.round(size.scale * 100)}-scout`);
        await dm.keyboard.press("Escape");
      }
    } finally {
      await ops.send({ t: "token.delete", tokenId: scout.id });
      await setUp(dm, dmCdp, DESK, null);
    }
    assert.deepEqual(off, [], "an item alone after Passive Perception");
  });

  test("fu31-q. no quick number runs past its line's end: the dragon's and Swift's panel headers and window summaries, the window narrowed 1 px at a time from 430 to 320 px wide, at 100% and 130% (FU31 review F10)", async () => {
    const off: string[] = [];
    const settled = () =>
      dm.evaluate(() => {
        const g = globalThis as unknown as { requestAnimationFrame(fn: () => void): number };
        return new Promise<void>((done) => g.requestAnimationFrame(() => g.requestAnimationFrame(done)));
      });
    // From 430 px down, so the band where a speed just stays beside AC, or its last mode beside it, is crossed for every creature at one of the sizes.
    const sweep = async (lines: Locator, label: string) => {
      let shown = 0;
      for (let width = 430; width >= 320; width--) {
        await dm.setViewportSize({ width, height: 844 });
        await settled();
        if ((await lines.count()) === 0) continue;
        shown++;
        off.push(...(await pastLineEnd(lines, `${label} at ${width} px`)));
      }
      assert.ok(shown > 100, `${label}: shown at only ${shown} of 111 widths`);
    };
    try {
      for (const scale of [1, 1.3]) {
        for (const [at, name] of [
          [run.dragon.at, "Adult White Dragon"],
          [run.swift.at, "Swift"],
        ] as const) {
          const where = `${name} at ${Math.round(scale * 100)}%`;
          await setUp(dm, dmCdp, { width: 430, height: 844, scale }, null);
          const panel = await panelOf(dm, at, name);
          await sweep(panel.locator("[data-quick-numbers]"), `${where}, the panel header`);
          await shots.take(dm, `fu31-header-sweep-${name.split(" ")[0]!.toLowerCase()}-${Math.round(scale * 100)}`);
          await setUp(dm, dmCdp, { width: 430, height: 844, scale }, null);
          await tapToken(dm, at);
          const b = bar(dm, name);
          await b.waitFor();
          await expandBar(b);
          const more = b.getByRole("button", { name: "More stats", exact: true });
          if ((await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
          await sweep(b.locator("[data-vitals]"), `${where}, the window's summary`);
        }
      }
    } finally {
      await setUp(dm, dmCdp, DESK, null);
    }
    assert.deepEqual(off, [], "a unit past its line's end");
  });
});
