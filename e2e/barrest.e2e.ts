import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { actor, bar, BOUNDS, browser, checks, columnOver, coveredIn, dm, dmCdp, dmSocket, EDGE_TOKENS, firstEmpty, frame, frameSteps, freeTop, hitAt, homeTokens, middle, oneMoveUp, openClear, openOn, openPanel, ops, panTo, panTwo, pat, patCdp, patContext, patOps, patSocket, PHONE, PHONES, type Placed, rectOf, restFile, run, server, setUp, shots, startCams, startProbe, steady, stopCams, stopProbe, tokenRect, view } from "./barrestRoom.ts";
import { barControl, expandBar, multiSelect, pickTool, readCamera, sleep, Touches, touchSwipe, waitFor, wholeInReach } from "./harness.ts";

/**
 * The token action bar at rest on a phone held upright
 * (docs/design-v1-bar-compact.md): a strip at the foot of the map that
 * stays put as the map pans and keeps every token in reach, and Expand,
 * which shows the whole bar.
 *
 * The room is the design's measuring room (section 1): a 30 x 20 map
 * with Pat's Thorn in its middle, goblins below and right of him, and a
 * token of each size at the edges and corners (e2e/barrestRoom.ts). The
 * DM and Pat each play from a phone. Frame steps carry `br-f-` and
 * content steps `br-c-`. br-f-5's edge and corner sweep runs in three
 * files of its own, one pass each (barrest-edges-*.e2e.ts), so the CI
 * shards can run them beside this one.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven, which it shares
 * with the phone files, since the runs go one after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

restFile(null, () => {
  // ------------------------------------------------------------ br-f: the frame (lane F)

  frameSteps(() => {
    test("br-f-1. at 390 x 844 the strip opens at 662 to 776 on its first frame, and pans, a pinch and a tap on another token leave its box", async () => {
      await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { defaultView: { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5, zoom: 44 } } });
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = { top: 662, bottom: 776, left: 8, right: 382 };
      // The swipes and the pinch start on the column right of every token in view, so none drags a token.
      const free = 370;
      const at = await middle(pat, run.thorn);
      const before = await readCamera(pat);
      await startProbe(pat);
      await pat.touchscreen.tap(at.x, at.y);
      await bar(pat, "Thorn").waitFor();
      assert.deepEqual(await stopProbe(pat), [strip], "the strip opened at its place, on its first frame, and stayed");
      assert.deepEqual(await readCamera(pat), before, "Thorn mid-screen: no map move");
      assert.equal(await bar(pat, "Thorn").getAttribute("data-bar-state"), "rest");
      await shots.take(pat, "br-f-1-rest-390");
      // Pans of 120 and 240 px, up and down, and a pinch: the box on every frame is the strip's.
      for (const dy of [-120, 240, -120]) {
        await startProbe(pat);
        await touchSwipe(patCdp, { x: free, y: 300 }, { x: free, y: 300 + dy }, { steps: 12 });
        assert.deepEqual(await stopProbe(pat, 600), [strip], `a pan of ${dy} px moved the strip`);
      }
      await startProbe(pat);
      const touches = new Touches(patCdp);
      await touches.start([
        { x: free, y: 260, id: 1 },
        { x: free, y: 340, id: 2 },
      ]);
      for (let i = 1; i <= 8; i++)
        await touches.move([
          { x: free, y: 260 - i * 6, id: 1 },
          { x: free, y: 340 + i * 6, id: 2 },
        ]);
      await touches.end();
      assert.deepEqual(await stopProbe(pat, 600), [strip], "a pinch moved the strip");
      // A tap on another token shows it in the same strip.
      await setUp(pat, { ...PHONE, scale: 1 });
      const again = await middle(pat, run.thorn);
      await pat.touchscreen.tap(again.x, again.y);
      await bar(pat, "Thorn").waitFor();
      const goblin = await middle(pat, run.goblin1);
      await startProbe(pat);
      await pat.touchscreen.tap(goblin.x, goblin.y);
      await bar(pat, "Goblin 1").waitFor();
      assert.deepEqual(await stopProbe(pat), [strip], "another token's strip stands where Thorn's did");
    });

    test("br-f-3. a whisper keeps above the strip, a stack placed low under the column's card takes its place anew above it as the strip opens, and the column stacks over the strip only where its cards leave the band whole, nothing drawn over the band", async () => {
      await homeTokens();
      // Pat's strip rests, and a whisper keeps above it, 60 px clear of its top.
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      await ops.send({ t: "log.whisper", to: [run.patId], text: "You hear chanting." });
      const whisper = pat.locator("[data-toast]").filter({ hasText: "You hear chanting." }).first();
      await whisper.waitFor();
      const w = await rectOf(whisper);
      assert.ok(w.bottom <= strip.top - 60 + 0.5, `the whisper reaches down to ${w.bottom}, under the strip's top less 60 (${strip.top - 60})`);
      assert.deepEqual(await rectOf(frame(pat)), strip, "the whisper moved the strip");
      await shots.take(pat, "br-f-3-whisper");

      const pats = await patOps();
      try {
        // At 320 x 568 at 130% a toast under the DM's concentration card stands low, past the strip's top less 60, so it takes its place anew as the strip opens.
        const z = 1.3;
        await setUp(dm, { width: 320, height: 568, scale: z });
        await checks([run.goblin1]);
        await dm.locator('[data-alert="concentration"]').first().waitFor();
        // The card's short "d20" and its Passed and Failed share one side padding, so its words sit as far in as theirs do (FU24-A1).
        assert.deepEqual(alignmentLines(await measureAlignment(dm.locator('[data-alert="concentration"]').first()), "the concentration card at 320 x 568 at 130%"), []);
        await pats.send({ t: "log.whisper", to: [dmSocket.you!.memberId], text: "Behind the altar." });
        const low = dm.locator("[data-toast]").filter({ hasText: "Behind the altar." }).first();
        await low.waitFor();
        const before = await rectOf(low);
        const small = await openClear(dm, [run.thorn, run.lantern, run.goblin2, run.barrel]);
        const floor = small.top - 60 * z;
        assert.ok(before.bottom > floor, `the toast stood at ${before.bottom}, not low: the step tests nothing (floor ${floor})`);
        await sleep(300);
        const after = await rectOf(low);
        assert.ok(after.bottom <= floor + 0.5, `the low toast stays at ${after.bottom}, under the strip's top less 60 (${floor})`);
        await shots.take(dm, "br-f-3-low-anew");
      } finally {
        pats.close();
      }

      // The DM's strip at 390 x 844, then a concentration check: the strip stays, the card stacks over it with the band left, or the summary row stands for it.
      await setUp(dm, { ...PHONE, scale: 1 });
      const dmStrip = await openOn(dm, run.thorn);
      await checks([run.goblin1]);
      await dm.locator('[data-alert="concentration"]').first().waitFor();
      await sleep(300);
      assert.deepEqual(await rectOf(frame(dm)), dmStrip, "a concentration card moved the strip");
      for (const [view, cards] of [
        [{ ...PHONE, scale: 1 }, [run.goblin1, run.goblin2]],
        [{ width: 320, height: 568, scale: 1.3 }, [run.goblin1, run.goblin2]],
      ] as const) {
        const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
        await setUp(dm, view);
        await checks([...cards]);
        await dm.locator('[data-alert="concentration"]').nth(1).waitFor({ state: "attached" });
        // With no bar the two cards may stand over Thorn: the first token clear of them opens the strip.
        const s = await openClear(dm, [run.thorn, run.goblin2, run.lantern, run.goblin1, run.barrel]);
        await sleep(300);
        // The band: the 44 px above the strip's own 8 px gap, across the strip.
        const bottom = s.top - 8 * view.scale;
        const band = { left: s.left, right: s.right, top: bottom - 44 * view.scale, bottom };
        assert.deepEqual(await coveredIn(dm, band), [], `${label}: something takes a tap in the band`);
        assert.deepEqual(await columnOver(dm, band), [], `${label}: the column draws over the band`);
        await shots.take(dm, `br-f-3-band-${view.width}`);
      }
    });

    test("br-f-6. Fit, Find my token, a tracker row, the party panel and the outliner after Ruler each land their token above the strip, with one clearing move at most", async () => {
      await homeTokens();
      // Pat's Find my token, with Thorn panned under his own strip.
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 195, y: strip.top + 40 });
      await pat.getByRole("button", { name: "Find my token" }).click();
      await sleep(600);
      const found = await tokenRect(pat, run.thorn);
      assert.ok(found.bottom <= strip.top, `Find my token left Thorn under the strip: ${JSON.stringify({ found, strip })}`);

      // The DM's Fit, with Goblin 2's strip open: no token under the strip.
      await setUp(dm, { ...PHONE, scale: 1 });
      const dmStrip = await openOn(dm, run.goblin2);
      await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
      await sleep(600);
      for (const t of [run.thorn, run.goblin1, run.goblin2, ...EDGE_TOKENS]) {
        const r = await tokenRect(dm, t);
        assert.ok(r.bottom <= dmStrip.top + 0.5, `Fit left ${t.name} under the strip: ${JSON.stringify({ r, dmStrip })}`);
      }
      await shots.take(dm, "br-f-6-fit");

      // A tracker row, the party panel and the outliner, each with its token first panned under the strip.
      await ops.send({
        t: "encounter.start",
        entries: [
          { id: randomUUID(), tokenId: run.goblin1.id, value: 15 },
          { id: randomUUID(), tokenId: run.goblin2.id, value: 12 },
          { id: randomUUID(), tokenId: run.thorn.id, value: 5 },
        ],
      });
      try {
        const opens: { name: string; t: Placed; open(): Promise<void> }[] = [
          {
            name: "a tracker row",
            t: run.goblin2,
            open: async () => {
              const sheet = await openPanel(dm, "Initiative");
              await sheet.getByRole("button", { name: /^Goblin 2/ }).first().click();
            },
          },
          {
            name: "the party panel",
            t: run.thorn,
            open: async () => {
              const sheet = await openPanel(dm, "Party");
              await sheet.getByRole("button", { name: /^Thorn/ }).first().click();
            },
          },
          {
            name: "the outliner after Ruler",
            t: run.goblin1,
            open: async () => {
              await pickTool(dm, "Ruler");
              const sheet = await openPanel(dm, "Outliner");
              await sheet.getByLabel("Search the scene").fill("Goblin 1");
              await sheet.getByRole("button", { name: /^Goblin 1/ }).first().click();
            },
          },
        ];
        for (const o of opens) {
          await setUp(dm, { ...PHONE, scale: 1 });
          const s = await openOn(dm, run.barrel);
          await panTo(dm, dmCdp, { x: o.t.x + 0.5, y: o.t.y + 0.5 }, { x: 195, y: s.top + 40 });
          await o.open();
          await bar(dm, o.t.name).waitFor();
          await sleep(800);
          await startCams(dm);
          const cams = await stopCams(dm, 1_000);
          assert.equal(cams.length, 1, `${o.name}: the map still moves after it landed: ${JSON.stringify(cams)}`);
          const r = await tokenRect(dm, o.t);
          const now = await rectOf(frame(dm));
          assert.ok(r.bottom <= now.top, `${o.name} left ${o.t.name} under the strip: ${JSON.stringify({ r, now })}`);
          await shots.take(dm, `br-f-6-${o.name.replaceAll(" ", "-")}`);
        }
      } finally {
        await ops.send({ t: "encounter.end" });
      }
    });

    test("br-f-7. Expand grows the bar up from the strip's foot and Collapse brings the strip back with focus on Expand, it lasts through another token and a drag, Close ends it, a turn of the phone and back rests, Expand shows only from F = 294, and a stored Larger is removed", async () => {
      await homeTokens();
      await dm.evaluate(() => localStorage.setItem("rvtt.tokenBarLarger", "1"));
      await setUp(dm, { ...PHONE, scale: 1 });
      assert.equal(await dm.evaluate(() => localStorage.getItem("rvtt.tokenBarLarger")), null, "the stored Larger was kept");
      const strip = await openOn(dm, run.thorn);
      const thorn = bar(dm, "Thorn");
      assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "a stored Larger opened the bar expanded");
      await startCams(dm);
      await thorn.getByRole("button", { name: "Expand", exact: true }).click();
      await waitFor("the bar to expand", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
      const big = await steady(dm);
      const cams = await stopCams(dm, 600);
      assert.ok(cams.length <= 2, `Expand moved the map more than once: ${JSON.stringify(cams)}`);
      assert.equal(big.bottom, strip.bottom, "the expanded bar left the strip's foot");
      const h = big.bottom - big.top;
      // Two thirds of 843, the layout's height, caps it: 562 (docs/design-v1-bar-compact.md 5.1).
      assert.ok(h > 114 && h <= 563, `expanded ${h} px`);
      const t = await tokenRect(dm, run.thorn);
      assert.ok(t.bottom <= big.top, `the expanded bar covers Thorn: ${JSON.stringify({ t, big })}`);
      await shots.take(dm, "br-f-7-expanded");

      // A pinch leaves the height.
      const touches = new Touches(dmCdp);
      await touches.start([
        { x: 30, y: 120, id: 1 },
        { x: 30, y: 180, id: 2 },
      ]);
      for (let i = 1; i <= 6; i++)
        await touches.move([
          { x: 30, y: 120 - i * 5, id: 1 },
          { x: 30, y: 180 + i * 5, id: 2 },
        ]);
      await touches.end();
      await sleep(400);
      assert.deepEqual(await rectOf(frame(dm)), big, "a pinch changed the expanded bar");

      // Another token keeps it expanded.
      const goblin = await middle(dm, run.goblin1);
      if (goblin.y < big.top) {
        await dm.touchscreen.tap(goblin.x, goblin.y);
        await bar(dm, "Goblin 1").waitFor();
        assert.equal(await bar(dm, "Goblin 1").getAttribute("data-bar-state"), "expanded", "another token rested the bar");
        await dm.touchscreen.tap((await middle(dm, run.thorn)).x, (await middle(dm, run.thorn)).y);
        await thorn.waitFor();
      }

      // Collapse: the strip, the map unmoved, focus on Expand.
      const before = await readCamera(dm);
      await thorn.getByRole("button", { name: "Collapse", exact: true }).click();
      await waitFor("the bar to rest", async () => ((await thorn.getAttribute("data-bar-state")) === "rest" ? true : null));
      assert.deepEqual(await steady(dm), strip, "Collapse left another box than the strip");
      assert.deepEqual(await readCamera(dm), before, "Collapse moved the map");
      // Its name is its aria-label or its words, which it keeps hidden from sight when the chevron stands alone (D-261024-46).
      assert.equal(await dm.evaluate(() => { const a = (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement; return a ? (a.getAttribute("aria-label") ?? a.textContent?.trim() ?? null) : null; }), "Expand", "focus after Collapse");

      // Close ends it: the next bar rests.
      await thorn.getByRole("button", { name: "Expand", exact: true }).click();
      await waitFor("the bar to expand", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
      await thorn.getByRole("button", { name: /^Close/ }).first().click();
      await thorn.waitFor({ state: "detached" });
      await openOn(dm, run.thorn);
      assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "the bar opened expanded after Close");

      // A turn of the phone with the strip held docks the bar, and back upright it rests again.
      await dm.setViewportSize({ width: 844, height: 390 });
      await sleep(600);
      assert.notEqual(await thorn.getAttribute("data-bar-mode"), "span", "on its side the bar still spans");
      await dm.setViewportSize({ width: 390, height: 844 });
      await waitFor("the strip again", async () => ((await thorn.getAttribute("data-bar-mode")) === "span" && (await thorn.getAttribute("data-bar-state")) === "rest" ? true : null), 5_000);
      assert.equal(await dm.evaluate(() => localStorage.getItem("rvtt.tokenBarLarger")), null, "Expand wrote the stored Larger");

      // Expand is drawn from F = 294, the free area's height, and not at 293. F 210, a 320 x 440 window at 130%, scrolls instead.
      const offered: string[] = [];
      for (const view of [...[418, 419, 420, 421, 422, 423, 424, 425].map((height) => ({ width: 390, height, scale: 1 })), { width: 320, height: 440, scale: 1.3 }]) {
        await setUp(dm, view);
        const s = await openOn(dm, run.thorn);
        const f = Math.round((s.bottom - (await freeTop(dm, view.scale))) / view.scale);
        const expand = await thorn.getByRole("button", { name: "Expand", exact: true }).count();
        const more = await thorn.getByRole("button", { name: "Scroll for more", exact: true }).count();
        offered.push(`F ${f}: ${expand ? "Expand" : more ? "Scroll for more" : "neither"}`);
        assert.equal(expand > 0, f >= 294, `at F ${f} Expand is ${expand ? "" : "not "}drawn`);
        if (view.scale !== 1) assert.ok(more > 0, `at F ${f} the strip offers no Scroll for more`);
        if (f < 294) assert.equal(await thorn.getAttribute("data-bar-state"), more ? "scrolls" : "rest", `at F ${f} the bar is ${await thorn.getAttribute("data-bar-mode")}, ${await thorn.getAttribute("data-bar-state")}`);
      }
      console.log(offered.join(", "));
    });

    test("br-f-8. the clearing move: a token whose label meets the strip moves up once, a Gargantuan as far as its top allows, a drop in the band once, and Ruler then Select, a gathering tap and a Multi-select removal never; a plain tap from a group counts", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      const free = await freeTop(pat, 1);

      // Goblin 2's foot 10 px above the strip: its label meets it, so the tap moves the map up once.
      await panTo(pat, patCdp, { x: run.goblin2.x + 0.5, y: run.goblin2.y + 1 }, { x: 195, y: strip.top - 10 });
      await startCams(pat);
      const g = await middle(pat, run.goblin2);
      await pat.touchscreen.tap(g.x, g.y);
      await bar(pat, "Goblin 2").waitFor();
      const moved = await stopCams(pat);
      assert.ok(oneMoveUp(moved), `not one move up: ${JSON.stringify(moved)}`);
      const cleared = await tokenRect(pat, run.goblin2);
      assert.ok(cleared.bottom + 30 <= strip.top + 0.5, `Goblin 2's label still meets the strip: ${JSON.stringify({ cleared, strip })}`);
      assert.deepEqual(await rectOf(frame(pat)), strip, "the clearing move moved the strip");

      // The Gargantuan low on the screen clears as far as its top stays in the free area.
      await panTo(pat, patCdp, { x: run.ancient.x + 2, y: run.ancient.y + 2 }, { x: 195, y: strip.top - 20 });
      const a = await middle(pat, run.ancient);
      await pat.touchscreen.tap(a.x, Math.min(a.y, strip.top - 10));
      await bar(pat, "Ancient Black Dragon").waitFor();
      await sleep(800);
      const ancient = await tokenRect(pat, run.ancient);
      assert.ok(ancient.top >= free - 1, `the clearing move took the Gargantuan's top out of the free area: ${JSON.stringify({ ancient, free })}`);
      assert.ok(ancient.bottom + 30 <= strip.top + 0.5 || ancient.top <= free + 1, `the Gargantuan neither clears nor stops at its top: ${JSON.stringify(ancient)}`);

      // Ruler, then Select, with the bar open: it comes back with no map move.
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      await openOn(pat, run.thorn);
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 1 }, { x: 195, y: strip.top - 10 });
      const still = await readCamera(pat);
      await pickTool(pat, "Ruler");
      await pickTool(pat, "Select");
      await bar(pat, "Thorn").waitFor();
      await sleep(600);
      assert.deepEqual(await readCamera(pat), still, "Ruler then Select moved the map");
      // A blackout's end with the selection kept: the map comes back at the scene's view, as always, and the bar with it, with no clearing move, though Thorn stands under the strip there.
      await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { x: run.thorn.x, y: run.thorn.y + 5 } });
      await waitFor("Thorn five cells down", () => (patSocket.state?.tokens[run.thorn.id]?.y === run.thorn.y + 5 ? true : null));
      await ops.send({ t: "view.blackout", blackout: true });
      await pat.getByText("The DM has paused the game.").waitFor();
      await ops.send({ t: "view.blackout", blackout: false });
      await bar(pat, "Thorn").waitFor();
      const back = (await view(pat)).cam;
      await sleep(1_000);
      assert.deepEqual((await view(pat)).cam, back, "the map moved after the blackout's end");
      const under = await tokenRect(pat, { ...run.thorn, y: run.thorn.y + 5 });
      assert.ok(under.bottom + 30 > strip.top, `Thorn stood clear of the strip at the scene's view, so the step tests nothing: ${JSON.stringify({ under, strip })}`);
      await homeTokens();

      // A drop in the band: the bar hides for the drag, comes back, and the map moves once to clear it.
      const from = await middle(pat, run.thorn);
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 195, y: 300 });
      const start = await middle(pat, run.thorn);
      await startCams(pat);
      await touchSwipe(patCdp, start, { x: start.x, y: strip.top - 14 }, { steps: 20, everyMs: 24 });
      await bar(pat, "Thorn").waitFor();
      const dropped = await stopCams(pat, 1_500);
      assert.ok(oneMoveUp(dropped), `the drop did not move the map once: ${JSON.stringify(dropped)}`);
      const landed = await tokenRect(pat, run.thorn);
      assert.ok(landed.bottom + 30 <= strip.top + 0.5, `the dropped token's label meets the strip: ${JSON.stringify({ landed, strip, from })}`);
      await homeTokens();

      // The DM's Multi-select: a gathering tap and a removal never move the map, and a plain tap from the group does (review BC-OPUS-37).
      await setUp(dm, { ...PHONE, scale: 1 });
      await openOn(dm, run.thorn);
      // Multi-select is behind Expand on the DM's strip at 390 x 844, and the strip rests again after, lifted by Multi-select's options row.
      await multiSelect(bar(dm, "Thorn"));
      const lifted = await steady(dm);
      // Two fingers pan Goblin 2 just above the strip, its label meeting it.
      await panTwo(dm, dmCdp, lifted.top - 12 - (await middle(dm, run.goblin2)).y, lifted.top);
      const gathered = await readCamera(dm);
      const g2 = await middle(dm, run.goblin2);
      assert.ok(g2.y < lifted.top - 4 && g2.y + 30 > lifted.top, `Goblin 2 does not stand just above the lifted strip, so the taps test nothing: ${JSON.stringify({ g2, lifted })}`);
      await dm.touchscreen.tap(g2.x, g2.y);
      const group = dm.getByRole("dialog", { name: "2 selected tokens" });
      await group.waitFor();
      await sleep(800);
      assert.deepEqual(await readCamera(dm), gathered, "a gathering tap moved the map");
      await dm.touchscreen.tap(g2.x, g2.y);
      await bar(dm, "Thorn").waitFor();
      await sleep(800);
      assert.deepEqual(await readCamera(dm), gathered, "a removal moved the map");
      await dm.touchscreen.tap(g2.x, g2.y);
      await group.waitFor();
      await (await barControl(group, "Multi-select")).click();
      // Its label meeting the bar again, which an Expand for Multi-select may have moved.
      const over = await steady(dm);
      await panTo(dm, dmCdp, { x: run.goblin2.x + 0.5, y: run.goblin2.y + 1 }, { x: 195, y: over.top - 10 });
      const g3 = await middle(dm, run.goblin2);
      await startCams(dm);
      await dm.touchscreen.tap(g3.x, g3.y);
      await bar(dm, "Goblin 2").waitFor();
      const plain = await stopCams(dm);
      assert.ok(oneMoveUp(plain), `a plain tap from the group did not move the map once: ${JSON.stringify(plain)}`);

      // A duplicate with the bar open opens its copy's bar, one request: the map moves once at most.
      const known = new Set(Object.keys(dmSocket.state?.tokens ?? {}));
      await startCams(dm);
      await (await barControl(bar(dm, "Goblin 2"), "Duplicate")).click();
      const copy = await waitFor("the copy", () => Object.keys(dmSocket.state?.tokens ?? {}).find((id) => !known.has(id)) ?? null);
      try {
        await waitFor("the copy's bar", async () => ((await frame(dm).getAttribute("aria-label")) !== "Goblin 2 actions" ? true : null));
        const copied = await stopCams(dm);
        assert.ok(copied.length === 1 || oneMoveUp(copied), `the duplicate moved the map more than once: ${JSON.stringify(copied)}`);
      } finally {
        await ops.send({ t: "token.delete", tokenId: copy });
        // The copy numbered Goblin 2 as its sibling, a number deleting the copy leaves, so the steps after read its name as it was.
        await ops.send({ t: "token.update", tokenId: run.goblin2.id, patch: { number: null } });
      }
      await shots.take(dm, "br-f-8-group-to-token");
    });

    test("br-f-9. a roll card at the foot lifts the strip by its height and back; in a fight with Multi-select at 320 x 568 at 130% it folds into Roll asked under the strip; Roll asked hides the bar and Actions brings it back; a card while expanded scrolls the strip and it expands again after", async () => {
      await homeTokens();
      const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
      const rollAsked = pat.getByRole("button", { name: /^Roll asked/ });
      const asked: string[] = [];
      const ask = async (): Promise<string> => {
        const id = randomUUID();
        asked.push(id);
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        return id;
      };
      const close = (id: string) => ops.send({ t: "roll.close", rollIds: [id] });
      try {
        // 390 x 844: the strip rises by the card's height, stays 114 tall, and comes back down as it goes.
        await setUp(pat, { ...PHONE, scale: 1 });
        const strip = await openOn(pat, run.thorn);
        let id = await ask();
        await card.waitFor();
        const lifted = await steady(pat);
        const c = await rectOf(card);
        assert.equal(Math.round(lifted.bottom - lifted.top), 114, "the strip's height over the card");
        assert.ok(lifted.bottom <= c.top + 0.5, `the strip meets the card: ${JSON.stringify({ lifted, c })}`);
        assert.ok(Math.abs(strip.bottom - lifted.bottom - (c.bottom - c.top)) <= 2, `the strip rose ${strip.bottom - lifted.bottom}, the card is ${c.bottom - c.top} tall`);
        await shots.take(pat, "br-f-9-card-390");
        await close(id);
        await card.waitFor({ state: "detached" });
        assert.deepEqual(await steady(pat), strip, "the strip did not come back down");

        // 320 x 568 at 130%, in a fight with Multi-select on: the card folds into Roll asked, the strip stays and never turns compact, and both come back.
        await ops.send({
          t: "encounter.start",
          entries: [
            { id: randomUUID(), tokenId: run.goblin1.id, value: 15 },
            { id: randomUUID(), tokenId: run.thorn.id, value: 5 },
          ],
        });
        // The first Next starts the fight, and its turn band shows.
        await ops.send({ t: "encounter.next" });
        try {
          await setUp(pat, { width: 320, height: 568, scale: 1.3 });
          const small = await openOn(pat, run.thorn);
          await (await barControl(bar(pat, "Thorn"), "Multi-select")).click();
          const several = await steady(pat);
          id = await ask();
          await rollAsked.waitFor();
          assert.equal(await card.isVisible(), false, "the card stands under the held strip");
          assert.equal(await frame(pat).getAttribute("data-bar-mode"), "span", "the bar turned compact for the card");
          assert.deepEqual(await steady(pat), several, "the card moved the strip");
          await shots.take(pat, "br-f-9-roll-asked-320");
          await close(id);
          await rollAsked.waitFor({ state: "detached" });
          assert.deepEqual(await steady(pat), several, "the strip moved as the card went");
          assert.ok(small.bottom >= several.bottom, "Multi-select's row lowered the strip");
        } finally {
          await ops.send({ t: "encounter.end" });
        }

        // With no bar the card stands. Thorn's tap then gives the strip, the card folding into Roll asked. The card stands over all but the map's top few px here, so Thorn goes there first, his middle just under the top bar.
        await setUp(pat, { width: 320, height: 568, scale: 1.3 });
        await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 160, y: (await freeTop(pat, 1.3)) + 4 });
        id = await ask();
        await card.waitFor();
        await pat.getByRole("dialog", { name: "The DM asks for a roll" }).getByRole("button", { name: "Later" }).waitFor();
        const m = await middle(pat, run.thorn);
        if (m.y < (await rectOf(card)).top) {
          await pat.touchscreen.tap(m.x, m.y);
          await bar(pat, "Thorn").waitFor();
          assert.equal(await frame(pat).getAttribute("data-bar-mode"), "span", "a card standing opened the bar compact");
          await rollAsked.waitFor();
          // Roll asked hides the bar and keeps Thorn: the card is answered, and Actions brings the strip back.
          await rollAsked.click();
          await card.waitFor();
          await frame(pat).waitFor({ state: "detached" });
          await card.getByLabel("Total Thorn rolled").fill("14");
          await card.getByRole("button", { name: "Send", exact: true }).click();
          await card.waitFor({ state: "detached" });
          // Thorn again, out from under the answer's chip at the top, brings the strip back, the held strip's mode kept.
          await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 160, y: 300 });
          await openOn(pat, run.thorn);
          assert.equal(await frame(pat).getAttribute("data-bar-mode"), "span");
        } else {
          assert.fail(`the card covers Thorn at 320 x 568 at 130%: ${JSON.stringify(m)}`);
        }
        await close(id);

        // 375 x 667, expanded: a card scrolls the strip and keeps expanded, then it expands again, the map unmoved.
        await setUp(pat, { width: 375, height: 667, scale: 1 });
        await openOn(pat, run.thorn);
        const thorn = bar(pat, "Thorn");
        await thorn.getByRole("button", { name: "Expand", exact: true }).click();
        await waitFor("the bar to expand", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
        const big = await steady(pat);
        const cam = await readCamera(pat);
        id = await ask();
        await card.waitFor();
        await waitFor("the strip to scroll", async () => ((await thorn.getAttribute("data-bar-state")) === "scrolls" ? true : null));
        await shots.take(pat, "br-f-9-expanded-card-375");
        await close(id);
        await card.waitFor({ state: "detached" });
        await waitFor("the bar to expand again", async () => ((await thorn.getAttribute("data-bar-state")) === "expanded" ? true : null));
        assert.deepEqual(await steady(pat), big, "the bar came back at another height");
        assert.deepEqual(await readCamera(pat), cam, "the map moved");
      } finally {
        if (asked.length > 0) await ops.send({ t: "roll.close", rollIds: asked });
      }
    });

    test("br-f-10. a compact bar turns into the strip as F reaches 148 and never back, the strip 96 px with its header and quick row whole over a 44 px band, and edge tokens with the summary row showing are panned into the band and tapped", async () => {
      await homeTokens();
      const z = 1.3;
      // 349 px at 130% opens compact, F about 140, and F reaches 148 just past 360 (docs/design-v1-bar-compact.md 3.1, a 320 x 360 window).
      await setUp(pat, { width: 320, height: 349, scale: z });
      await openOn(pat, run.thorn);
      const thorn = bar(pat, "Thorn");
      assert.equal(await thorn.getAttribute("data-bar-mode"), "compact", "F 140 opens compact");
      const cam = await readCamera(pat);
      // The window grows a pixel at a time until F reaches 148, at 360 here, the bars measured as drawn.
      let grown = 360;
      for (; grown <= 368; grown++) {
        await pat.setViewportSize({ width: 320, height: grown });
        await sleep(300);
        if ((await thorn.getAttribute("data-bar-mode")) === "span") break;
      }
      console.log(`br-f-10: the compact bar turned into the strip at 320 x ${grown} at 130%`);
      await waitFor("the strip", async () => ((await thorn.getAttribute("data-bar-mode")) === "span" ? true : null), 3_000);
      const strip = await steady(pat);
      // The map keeps its middle as the window grows, as it always has, and moves no further: no clearing move.
      const now = await readCamera(pat);
      assert.ok(cam && now && now.x === cam.x && Math.abs(now.y - (cam.y + (grown - 349) / 2)) <= 0.5 && now.scale === cam.scale, `turning into the strip moved the map: ${JSON.stringify({ cam, now })}`);
      const free = await freeTop(pat, z);
      const f = (strip.bottom - free) / z;
      assert.ok(f >= 148 && f < 149, `F is ${f}`);
      assert.ok(Math.abs((strip.bottom - strip.top) / z - (f - 52)) <= 1, `the strip is ${(strip.bottom - strip.top) / z} tall at F ${f}`);
      assert.ok(Math.abs((strip.top - 8 * z - free) / z - 44) <= 1.5, `the band is ${(strip.top - 8 * z - free) / z}`);
      // The quick row is the strip's content, checked wherever the strip draws one.
      if ((await thorn.locator("[data-rest-row]").count()) > 0) {
        const row = await rectOf(thorn.locator("[data-rest-row]"));
        assert.ok(row.top >= strip.top && row.bottom <= strip.bottom + 0.5, `the quick row is cut: ${JSON.stringify({ row, strip })}`);
      }
      assert.ok(await wholeInReach(thorn.getByRole("button", { name: /^Close/ }).first()), "the header's Close is cut");
      await shots.take(pat, "br-f-10-strip-148");
      await pat.setViewportSize({ width: 320, height: 349 });
      await sleep(600);
      assert.equal(await thorn.getAttribute("data-bar-mode"), "span", "the strip turned back compact");

      // The DM, a check standing, the summary row in its place: the edge tokens pan into the band and take a tap.
      await setUp(dm, { width: 320, height: grown, scale: z });
      await checks([run.goblin1]);
      await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
      // With no bar the card may stand over Thorn: the first token clear of it opens the strip.
      await openClear(dm, [run.thorn, run.goblin2, run.lantern, run.goblin1, run.barrel]);
      for (let h = grown; h <= grown + 8 && (await frame(dm).getAttribute("data-bar-mode")) !== "span"; h++) {
        await dm.setViewportSize({ width: 320, height: h });
        await sleep(300);
      }
      assert.equal(await frame(dm).getAttribute("data-bar-mode"), "span", "the DM's bar never rests as the strip near F 148");
      const s = await steady(dm);
      const target = { x: (s.left + s.right) / 2, y: s.top - 8 * z - 22 * z };
      const missed: string[] = [];
      for (const t of EDGE_TOKENS) {
        await panTo(dm, dmCdp, { x: t.x + t.cells / 2, y: t.y + t.cells / 2 }, target);
        const r = await tokenRect(dm, t);
        const p = { x: Math.max(r.left + 4, Math.min(r.right - 4, target.x)), y: Math.max(r.top + 4, Math.min(r.bottom - 4, target.y)) };
        if ((await hitAt(dm, p)) !== "CANVAS") {
          missed.push(`${t.name}: ${JSON.stringify(p)} is covered`);
          continue;
        }
        await dm.touchscreen.tap(p.x, p.y);
        try {
          await bar(dm, t.name).waitFor({ timeout: 3_000 });
        } catch {
          missed.push(`${t.name}: the tap at ${JSON.stringify(p)} opened nothing`);
        }
      }
      await shots.take(dm, "br-f-10-summary-row-148");
      assert.deepEqual(missed, []);
    });

    test("br-f-11. where the band is under 96, a toast is one 44 px row over the top bar's row clear of End turn and the band; a tap shows it whole with its time held, Close or Escape shrinks it with what it had left, one waiting meanwhile gets its whole time once drawn, and a blackout leaves none stopped. The DM's trap toast takes the row with an error waiting behind it, and both forms, the note and the summary line up within 1 px", async () => {
      await homeTokens();
      const z = 1.3;
      await ops.send({
        t: "encounter.start",
        entries: [
          { id: randomUUID(), tokenId: run.thorn.id, value: 20 },
          { id: randomUUID(), tokenId: run.goblin1.id, value: 5 },
        ],
      });
      // The first Next starts the fight on Thorn's turn, so End turn stands in the band.
      await ops.send({ t: "encounter.next" });
      try {
        await setUp(pat, { width: 320, height: 440, scale: z });
        const strip = await openOn(pat, run.thorn);
        const rowOf = (text: string | RegExp) => pat.locator('[data-toast-form="row"]').filter({ hasText: text });
        const wholeOf = (text: string | RegExp) => pat.locator('[data-toast-form="whole"]').filter({ hasText: text });
        await ops.send({ t: "log.whisper", to: [run.patId], text: "First whisper." });
        const first = rowOf("First whisper.");
        try {
          await first.waitFor({ timeout: 8_000 });
        } catch (err) {
          await shots.take(pat, "br-f-11-no-row");
          throw err;
        }
        const r = await rectOf(first);
        assert.ok(Math.abs(r.bottom - r.top - 44 * z) <= 1, `the row is ${r.bottom - r.top} tall`);
        const end = await rectOf(pat.getByRole("button", { name: "End turn" }));
        assert.ok(r.bottom <= end.top || r.top >= end.bottom || r.right <= end.left || r.left >= end.right, `the row covers End turn: ${JSON.stringify({ r, end })}`);
        const bottom = strip.top - 8 * z;
        assert.deepEqual(await coveredIn(pat, { left: strip.left, right: strip.right, top: bottom - 44 * z, bottom }), [], "something stands in the band");
        await shots.take(pat, "br-f-11-row");

        // Shown whole, its time stops: it outlasts its 5 s, and a whisper that comes meanwhile waits undrawn.
        await first.getByRole("button").first().click();
        await wholeOf("First whisper.").waitFor();
        await ops.send({ t: "log.whisper", to: [run.patId], text: "Second whisper." });
        await sleep(6_000);
        assert.equal(await wholeOf("First whisper.").count(), 1, "the whole toast ran out while shown whole");
        const second = rowOf("Second whisper.");
        assert.equal(await pat.locator("[data-toast]").filter({ hasText: "Second whisper." }).count(), 0, "the whisper that came meanwhile was drawn");
        await shots.take(pat, "br-f-11-whole");
        // Escape shrinks it, and the one that waited takes the row, its time starting as it draws (docs/design-v1-bar-compact.md 3.5).
        await pat.keyboard.press("Escape");
        await second.waitFor({ timeout: 2_000 });
        await sleep(3_500);
        assert.equal(await second.count(), 1, "the waiting whisper ran out before its time");
        // Close shrinks it as Escape does, its time held while whole and running on after.
        await second.getByRole("button").first().click();
        await wholeOf("Second whisper.").getByRole("button", { name: "Close", exact: true }).click();
        await second.waitFor();
        await second.waitFor({ state: "detached", timeout: 6_000 });
        // A blackout while one shows whole leaves nothing stopped after it (review BARBUILD-ASTRA-04): an error, which no fit drops, Pat's undo of a nudge to Thorn, whom the DM has moved since.
        await pat.keyboard.press("ArrowRight");
        await waitFor("Thorn a square right", () => (patSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x + 1 ? true : null));
        await ops.send({ t: "token.move", tokenId: run.thorn.id, x: run.thorn.x, y: run.thorn.y });
        await waitFor("Thorn back on his square", () => (patSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x ? true : null));
        await pat.keyboard.press("Control+z");
        const refused = rowOf(/ since\./);
        await refused.waitFor({ timeout: 4_000 });
        await refused.getByRole("button").first().click();
        await wholeOf(/ since\./).waitFor();
        await ops.send({ t: "view.blackout", blackout: true });
        await pat.getByText("The DM has paused the game.").waitFor();
        await ops.send({ t: "view.blackout", blackout: false });
        await pat.getByText("The DM has paused the game.").waitFor({ state: "detached" });
        await pat.locator("[data-toast]").filter({ hasText: / since\./ }).waitFor({ state: "detached", timeout: 8_000 });

        // The DM at the same size on Thorn's turn: an error waits behind a trap's toast, which takes the row with Save and damage, and each form, the strip's note and the alerts' summary line up within 1 px (review BB-OPUS-5).
        await setUp(dm, { width: 320, height: 440, scale: z });
        await openOn(dm, run.thorn);
        const dmRow = (text: string | RegExp) => dm.locator('[data-toast-form="row"]').filter({ hasText: text });
        const lined = async (root: Locator, what: string) => assert.deepEqual(alignmentLines(await measureAlignment(root), `${what} at 320 x 440 at 130%`), []);
        // The error: the DM's undo of a nudge to Thorn, whom Pat has moved since, is refused, and the log never sees it.
        await dm.keyboard.press("ArrowRight");
        await waitFor("Thorn a square right", () => (dmSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x + 1 ? true : null));
        const pats = await patOps();
        try {
          await pats.send({ t: "token.move", tokenId: run.thorn.id, x: run.thorn.x, y: run.thorn.y });
        } finally {
          pats.close();
        }
        await waitFor("Thorn back on his square", () => (dmSocket.state?.tokens[run.thorn.id]?.x === run.thorn.x ? true : null));
        await dm.keyboard.press("Control+z");
        const error = dmRow(/ since\./);
        await error.waitFor({ timeout: 4_000 });
        const trapId = randomUUID();
        const walker = randomUUID();
        const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
        await ops.send({ t: "token.create", token: { id: walker, sceneId: run.sceneId, kind: "monster", name: "Scout", x: 1, y: 4, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: actor(7, 15) } } });
        await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Needle Plate", zone: { cells: [{ x: 1, y: 1, w: 1, h: 1 }] }, rig } });
        try {
          await waitFor("the scout and the trap in the DM's view", () => (dmSocket.state?.tokens[walker] && dmSocket.state.traps[trapId] ? true : null));
          await ops.send({ t: "token.move", tokenId: walker, x: 1, y: 1 });
          const trap = dmRow("Needle Plate went off: Scout.");
          await trap.waitFor();
          assert.equal(await dm.locator("[data-toast]").filter({ hasText: / since\./ }).count(), 0, "the error showed beside the trap's toast");
          assert.ok(await wholeInReach(trap.getByRole("button", { name: "Save and damage", exact: true })), "the row's Save and damage is out of reach");
          await lined(trap, "the trap's toast as the row");
          await shots.take(dm, "br-f-11-dm-trap-row");
          await trap.getByRole("button").first().click();
          const whole = dm.locator('[data-toast-form="whole"]').filter({ hasText: "Needle Plate went off: Scout." });
          await whole.waitFor();
          await lined(whole, "the trap's toast whole");
          await shots.take(dm, "br-f-11-dm-trap-whole");
          // Its words dismiss it, and the error that waited takes the row.
          await whole.getByRole("button", { name: "Needle Plate went off: Scout.", exact: true }).click();
          await whole.waitFor({ state: "detached" });
          await error.waitFor({ timeout: 2_000 });
          await lined(error, "the error as the row");
          await shots.take(dm, "br-f-11-dm-error-row");
          // The trap's card stands as the alerts' summary, risen or in the strip's header.
          const header = frame(dm).locator("[data-rest-summary]");
          if ((await header.count()) > 0) await lined(header, "the header's summary button");
          else await lined(dm.getByRole("button", { name: /^Needle Plate/ }).first(), "the risen summary row");
          // The strip's note: a dead goblin's heal line, too long for the title here (3.3).
          await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "dead" });
          await ops.send({ t: "room.update", settings: { healRevives: false } });
          try {
            await bar(dm, "Thorn").getByRole("button", { name: "Close", exact: true }).first().click();
            await panTo(dm, dmCdp, { x: run.goblin2.x + 0.5, y: run.goblin2.y + 0.5 }, { x: 160, y: (await freeTop(dm, z)) + 70 });
            await openOn(dm, run.goblin2);
            const goblin = bar(dm, "Goblin 2");
            await goblin.locator("[data-rest-row] [data-rest-mode]").click();
            // The note stands while the field holds something (review BARBUILD-ASTRA-07).
            await goblin.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("5");
            const note = goblin.locator("[data-rest-note]");
            await note.waitFor();
            await lined(note, "the strip's note");
            await shots.take(dm, "br-f-11-dm-note");
          } finally {
            await ops.send({ t: "room.update", settings: { healRevives: true } });
            await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "alive" });
          }
        } finally {
          for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
          await ops.send({ t: "trap.delete", trapId });
          await ops.send({ t: "token.delete", tokenId: walker });
          await waitFor("the scout and the trap gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] && !dmSocket.state.tokens[walker] ? true : null));
        }
      } finally {
        await ops.send({ t: "encounter.end" });
      }
    });
    test("br-f-12. nothing clips a quick row control's focus ring, the 4 px past it that its 2 px outline and 2 px offset take, the row runs out of nothing sideways, and it lines up within 1 px, at 390 x 844 and 320 x 568 at 130%", async (t) => {
      await homeTokens();
      for (const view of [
        { ...PHONE, scale: 1 },
        { width: 320, height: 568, scale: 1.3 },
      ]) {
        const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
        await setUp(pat, view);
        await openOn(pat, run.thorn);
        const row = frame(pat).locator("[data-rest-row]");
        if ((await row.count()) === 0) {
          // The quick row is the strip's content (the content lane's), drawn once it stands on this frame.
          t.skip("no quick row in the strip");
          return;
        }
        const cut = await row.evaluate((el, ring) => {
          type R = { left: number; top: number; right: number; bottom: number };
          type S = { overflowX: string; overflowY: string; clipPath: string };
          type E = {
            getBoundingClientRect(): R & { width: number };
            offsetWidth: number;
            scrollWidth: number;
            clientWidth: number;
            parentElement: E | null;
            matches(s: string): boolean;
            querySelectorAll(s: string): ArrayLike<E>;
            getAttribute(n: string): string | null;
            textContent: string | null;
          };
          const view = globalThis as unknown as { getComputedStyle(e: E): S };
          const box = el as unknown as E;
          const zoom = box.offsetWidth > 0 ? box.getBoundingClientRect().width / box.offsetWidth : 1;
          const reach = ring * zoom;
          // What clips the row's controls, from the row up to the bar's frame: a box that clips what overflows it, and a clip path, grown by its inset.
          const clips: { by: string; r: R }[] = [];
          for (let a: E | null = box; a && !a.matches('[role="dialog"]'); a = a.parentElement) {
            const cs = view.getComputedStyle(a);
            const r = a.getBoundingClientRect();
            if (cs.overflowX !== "visible" || cs.overflowY !== "visible") clips.push({ by: "overflow", r });
            const inset = /^inset\((-?[\d.]+)px\)$/.exec(cs.clipPath);
            const grow = inset ? -Number(inset[1]) * zoom : 0;
            if (cs.clipPath !== "none") clips.push({ by: `clip path ${cs.clipPath}`, r: { left: r.left - grow, top: r.top - grow, right: r.right + grow, bottom: r.bottom + grow } });
          }
          const out: string[] = [];
          for (const c of Array.from(box.querySelectorAll("[data-rest-shown] :is(button, input, a[href], [tabindex]:not([tabindex='-1']))"))) {
            const b = c.getBoundingClientRect();
            if (b.width === 0) continue;
            for (const { by, r } of clips) {
              if (b.left - reach < r.left - 0.5 || b.right + reach > r.right + 0.5 || b.top - reach < r.top - 0.5 || b.bottom + reach > r.bottom + 0.5)
                out.push(`${c.getAttribute("aria-label") ?? c.textContent ?? "?"}: ${JSON.stringify(b)} cut by the ${by} of ${JSON.stringify(r)}`);
            }
          }
          // Nor does the row run out of its parent sideways, which a box that scrolls would show.
          const parent = box.parentElement;
          if (parent && parent.scrollWidth > parent.clientWidth + 1) out.push(`the row's parent runs over: ${parent.scrollWidth} > ${parent.clientWidth}`);
          return out;
        }, 4);
        assert.deepEqual(cut, [], `${label}: the row clips these controls' focus rings`);
        assert.deepEqual(alignmentLines(await measureAlignment(row), `${label} the quick row`), []);
        await shots.take(pat, `br-f-12-row-${view.width}`);
      }
    });

    test("br-f-13. a toast showing as a turn starts goes under the card the turn brings, a death save card here, so none of the card is under it (review LP20-CC-2)", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const thorn = { characterId: run.thorn.characterId };
      await ops.send({ t: "actor.hp", target: thorn, change: { kind: "damage", amount: 30 } });
      await ops.send({
        t: "encounter.start",
        entries: [
          { id: randomUUID(), tokenId: run.goblin1.id, value: 15 },
          { id: randomUUID(), tokenId: run.thorn.id, value: 5 },
        ],
      });
      // The first Next starts the fight on the goblin's turn, where Pat's column shows no card.
      await ops.send({ t: "encounter.next" });
      try {
        await ops.send({ t: "log.whisper", to: [run.patId], text: "A cold draft." });
        const toast = pat.locator("[data-toast]").filter({ hasText: "A cold draft." }).first();
        await toast.waitFor();
        await ops.send({ t: "encounter.next" });
        const card = pat.getByRole("group", { name: "Death save for Thorn", exact: true }).first();
        await card.waitFor();
        await sleep(800);
        assert.ok(await toast.isVisible(), "the toast went before the card came");
        const t = await rectOf(toast);
        const c = await rectOf(card);
        assert.ok(t.top >= c.bottom - 0.5, `the toast lies over the death save card: ${JSON.stringify({ toast: t, card: c })}`);
        await shots.take(pat, "br-f-13-toast-under-card");
      } finally {
        await ops.send({ t: "encounter.end" });
        await ops.send({ t: "actor.hp", target: thorn, change: { kind: "heal", amount: 30 } });
      }
    });

    test("br-f-14. Multi-select turned on in an expanded bar rests it with no map move, so the map under it is free, and turned off in a group's expanded bar leaves it expanded (D-261024-22)", async () => {
      await homeTokens();
      await setUp(dm, { ...PHONE, scale: 1 });
      await openOn(dm, run.thorn);
      const thorn = bar(dm, "Thorn");
      await expandBar(thorn);
      assert.equal(await thorn.getAttribute("data-bar-state"), "expanded", "Thorn's bar did not expand");
      const cam = await readCamera(dm);
      await thorn.getByRole("button", { name: "Multi-select", exact: true }).click();
      await dm.getByRole("toolbar", { name: "Select options" }).waitFor();
      await waitFor("Thorn's bar to rest", async () => ((await thorn.getAttribute("data-bar-state")) === "rest" ? true : null), 3_000);
      await sleep(400);
      assert.deepEqual(await readCamera(dm), cam, "the rest moved the map");
      await shots.take(dm, "br-f-14-token-rests");

      // Goblin 1 gathered where the map shows it, then the group's bar expanded and Multi-select turned off there.
      const strip = await steady(dm);
      await panTwo(dm, dmCdp, strip.top - 150 - (await middle(dm, run.goblin1)).y, strip.top);
      const g1 = await middle(dm, run.goblin1);
      await dm.touchscreen.tap(g1.x, g1.y);
      const group = dm.getByRole("dialog", { name: "2 selected tokens" });
      await group.waitFor();
      assert.equal(await group.getAttribute("data-bar-state"), "rest", "the group's bar opened expanded");
      await expandBar(group);
      assert.equal(await group.getAttribute("data-bar-state"), "expanded", "the group's bar did not expand");
      await group.getByRole("button", { name: "Multi-select", exact: true }).click();
      await waitFor("Multi-select off", async () => ((await dm.getByRole("toolbar", { name: "Select options" }).count()) === 0 ? true : null), 3_000);
      await sleep(400);
      assert.equal(await group.getAttribute("data-bar-state"), "expanded", "turning Multi-select off rested the group's bar");
      await shots.take(dm, "br-f-14-group-stays");
      await group.getByRole("button", { name: "Deselect all", exact: true }).first().click();
    });

    test("br-f-15. with the bar expanded over its token, Ruler then Select, a blackout's end and a fold's return move no map (D-261024-22)", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      await openOn(pat, run.thorn);
      const thorn = bar(pat, "Thorn");
      // Expanded, with Thorn panned under its cover, so a clearing move would show.
      const underCover = async (): Promise<{ x: number; y: number; scale: number }> => {
        await expandBar(thorn);
        const big = await steady(pat);
        await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: 195, y: big.top + 40 });
        assert.equal(await thorn.getAttribute("data-bar-state"), "expanded", "the bar is not expanded");
        return (await view(pat)).cam;
      };

      // Ruler, then Select: the bar closes and comes back resting, with no map move.
      const ruled = await underCover();
      await pickTool(pat, "Ruler");
      await pickTool(pat, "Select");
      await thorn.waitFor();
      await sleep(600);
      assert.deepEqual((await view(pat)).cam, ruled, "Ruler then Select moved the map");

      // A blackout's end: the map comes back at the scene's view, as always, and nothing moves it after.
      await underCover();
      await ops.send({ t: "view.blackout", blackout: true });
      await pat.getByText("The DM has paused the game.").waitFor();
      await ops.send({ t: "view.blackout", blackout: false });
      await thorn.waitFor();
      const back = (await view(pat)).cam;
      await sleep(1_000);
      assert.deepEqual((await view(pat)).cam, back, "the map moved after the blackout's end");

      // A fold's return: Panels folds the bar onto its sheet's top edge, and as the sheet closes the bar comes back expanded, the map where it stood.
      const folded = await underCover();
      await pat.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
      await pat.getByRole("region", { name: "Panels" }).waitFor();
      await pat.keyboard.press("Escape");
      await pat.getByRole("region", { name: "Panels" }).waitFor({ state: "detached" });
      await thorn.waitFor();
      await sleep(600);
      assert.equal(await thorn.getAttribute("data-bar-state"), "expanded", "the fold's return rested the bar");
      assert.deepEqual((await view(pat)).cam, folded, "the fold's return moved the map");
      await shots.take(pat, "br-f-15-fold-return");
      await thorn.getByRole("button", { name: /^Close/ }).first().click();
    });

    test("br-f-16. a refusal in the scrolling strip brings its header and quick row into view as it comes, and a scroll down after it holds (5.4, review BB-OPUS-1)", async () => {
      await homeTokens();
      const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
      const id = randomUUID();
      const refusal = "You can only deal damage to or heal this creature.";
      await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
      try {
        await setUp(pat, { width: 375, height: 667, scale: 1 });
        await openOn(pat, run.goblin1);
        const goblin = bar(pat, "Goblin 1");
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await card.waitFor();
        await waitFor("the strip to scroll", async () => ((await goblin.getAttribute("data-bar-state")) === "scrolls" ? true : null));
        const scroller = goblin.locator("[data-bar-scroll]");
        const field = goblin.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" });
        await field.fill("=20");
        await waitFor("the refusal", async () => ((await goblin.locator("[data-rest-status]").first().getAttribute("data-rest-sentence")) === refusal ? true : null));
        assert.equal(await scroller.evaluate((el) => el.scrollTop), 0, "the strip is not at its top as the refusal shows");
        // The viewer scrolls down with the refusal still showing, and the strip stays where they put it through the renders that follow.
        const down = await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollTop;
        });
        assert.ok(down > 0, "the strip has nothing to scroll");
        await sleep(800);
        assert.equal(await scroller.evaluate((el) => el.scrollTop), down, "the strip went back to its top while the refusal showed");
        await shots.take(pat, "br-f-16-refusal-scrolled");
        await field.fill("");
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
        await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
      }
    });

    test("br-f-17. a drawer opened from the strip stays open as a roll card turns the expanded bar into the scrolling strip and back, and closed meanwhile, by either button, it rests the bar once the card goes (5.3, 5.4, review BB-OPUS-4)", async () => {
      await homeTokens();
      const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
      const asked: string[] = [];
      const ask = async () => {
        const id = randomUUID();
        asked.push(id);
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await card.waitFor();
      };
      const answered = async () => {
        await ops.send({ t: "roll.close", rollIds: [asked[asked.length - 1]!] });
        await card.waitFor({ state: "detached" });
      };
      const thorn = bar(pat, "Thorn");
      const state = (s: string) => waitFor(`the bar's state ${s}`, async () => ((await thorn.getAttribute("data-bar-state")) === s ? true : null), 5_000);
      const drawer = thorn.getByRole("group", { name: "Conditions" });
      const fromRest = thorn.locator("[data-rest-row]").getByRole("button", { name: "Conditions", exact: true });
      try {
        await setUp(pat, { width: 375, height: 667, scale: 1 });
        await openOn(pat, run.thorn);
        await fromRest.tap();
        await drawer.waitFor();
        await state("expanded");
        // The card turns the expanded bar into the scrolling strip with its state kept, the drawer open, and the bar expands again as the card goes.
        await ask();
        await state("scrolls");
        assert.equal(await drawer.count(), 1, "the card closed the drawer");
        await answered();
        await state("expanded");
        assert.equal(await drawer.count(), 1, "the drawer closed as the bar expanded again");
        // Closed during the card by the last Conditions the strip draws, the body's where it shows one: the bar rests once the card goes.
        await ask();
        await state("scrolls");
        await thorn.getByRole("button", { name: "Conditions", exact: true }).last().tap();
        await drawer.waitFor({ state: "detached" });
        await answered();
        await sleep(600);
        assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "the bar expanded again with its drawer closed");
        // And by the strip's own Conditions.
        await fromRest.tap();
        await drawer.waitFor();
        await state("expanded");
        await ask();
        await state("scrolls");
        await fromRest.tap();
        await drawer.waitFor({ state: "detached" });
        await answered();
        await sleep(600);
        assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "the bar expanded again after the strip's Conditions closed its drawer");
        await shots.take(pat, "br-f-17-drawer-closed-rests");
      } finally {
        if (asked.length > 0) await ops.send({ t: "roll.close", rollIds: asked });
      }
    });

    test("br-f-18. an arrow-key nudge under the strip moves no map, and a finger down on the map before the bar clears its token cancels the clearing move (3.6, review BB-OPUS-5)", async () => {
      await homeTokens();
      await setUp(pat, { ...PHONE, scale: 1 });
      const strip = await openOn(pat, run.thorn);
      const cam = (await view(pat)).cam;
      // Each press moves Thorn a square down as a drop does, until his label meets the strip, and the map stays.
      const home = await tokenRect(pat, run.thorn);
      const squares = Math.ceil((strip.top - (home.bottom + 34)) / cam.scale) + 1;
      for (let i = 1; i <= squares; i++) {
        await pat.keyboard.press("ArrowDown");
        await waitFor(`Thorn ${i} squares down`, () => (patSocket.state?.tokens[run.thorn.id]?.y === run.thorn.y + i ? true : null));
      }
      await sleep(800);
      assert.deepEqual((await view(pat)).cam, cam, "a nudge moved the map");
      const nudged = await tokenRect(pat, { ...run.thorn, y: run.thorn.y + squares });
      assert.ok(nudged.bottom + 34 > strip.top, `the nudges left Thorn's label clear of the strip: ${JSON.stringify({ nudged, strip })}`);
      await shots.take(pat, "br-f-18-nudged-under");
      await bar(pat, "Thorn").getByRole("button", { name: "Close", exact: true }).first().click();
      await bar(pat, "Thorn").waitFor({ state: "detached" });
      await homeTokens();

      // The frame holds the opening's request 2.5 s by the run's hook, and a pan's first touch, sideways above the strip, cancels it there.
      await panTo(pat, patCdp, { x: run.thorn.x + 0.5, y: run.thorn.y + 0.5 }, { x: PHONE.width / 2, y: strip.top + 30 });
      await pat.evaluate(() => {
        (globalThis as { rvttClearWaitMs?: number }).rvttClearWaitMs = 2_500;
      });
      try {
        const m = await middle(pat, run.thorn);
        assert.equal(await hitAt(pat, m), "CANVAS", "Thorn is under something");
        const v = await view(pat);
        const starts: { x: number; y: number }[] = [];
        for (let y = 200; y <= strip.top - 120; y += 24) for (let x = 24; x <= 140; x += 24) starts.push({ x, y });
        const start = await firstEmpty(pat, v, starts);
        assert.ok(start, "no empty cell to start the pan on");
        await pat.touchscreen.tap(m.x, m.y);
        await bar(pat, "Thorn").waitFor();
        const opened = await readCamera(pat);
        await touchSwipe(patCdp, start, { x: start.x + 80, y: start.y }, { steps: 10, everyMs: 16 });
        const panned = (await view(pat)).cam;
        assert.notDeepEqual(panned, opened, "the pan moved nothing");
        await sleep(3_000);
        assert.deepEqual((await view(pat)).cam, panned, "the clearing move ran after the viewer's own pan");
        assert.equal(await frame(pat).getAttribute("data-bar-state"), "rest");
        await shots.take(pat, "br-f-18-pan-cancels");
      } finally {
        await pat.evaluate(() => {
          delete (globalThis as { rvttClearWaitMs?: number }).rvttClearWaitMs;
        });
      }
    });

    test("br-f-19. a strip opened before a turn band and Multi-select's row take F under 146 at 320 x 480 at 130% stays a strip, 94 px (3.1, review BB-OPUS-6)", async () => {
      await homeTokens();
      const z = 1.3;
      const thorn = bar(pat, "Thorn");
      await patCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 44, bottom: 34, left: 0, right: 0 } });
      try {
        await setUp(pat, { width: 320, height: 480, scale: z });
        const opened = await openOn(pat, run.thorn);
        assert.equal(await thorn.getAttribute("data-bar-mode"), "span", "no strip opened before the band");
        await ops.send({
          t: "encounter.start",
          entries: [
            { id: randomUUID(), tokenId: run.thorn.id, value: 20 },
            { id: randomUUID(), tokenId: run.goblin1.id, value: 5 },
          ],
        });
        // The first Next starts the fight on Thorn's turn, so End turn stands in the band.
        await ops.send({ t: "encounter.next" });
        try {
          await pat.getByRole("button", { name: "End turn" }).waitFor();
          await (await barControl(thorn, "Multi-select")).click();
          await pat.getByRole("toolbar", { name: "Select options" }).waitFor();
          const held = await steady(pat);
          assert.equal(await thorn.getAttribute("data-bar-mode"), "span", "the strip turned compact");
          const tall = (held.bottom - held.top) / z;
          assert.ok(Math.abs(tall - 94) <= 0.5, `the held strip is ${tall} tall, opened at ${(opened.bottom - opened.top) / z}`);
          await shots.take(pat, "br-f-19-held-94");
          await pat.getByRole("toolbar", { name: "Select options" }).getByRole("button", { name: "Done", exact: true }).click();
        } finally {
          await ops.send({ t: "encounter.end" });
        }
      } finally {
        await patCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
      }
    });

    test("br-f-20. at 320 x 360 at 130% the DM's summary row, risen into the top bar's row, gives way to a toast over the bars: it stands in the strip's header while the toast shows, and rises again as it goes (D-261024-23)", async () => {
      await homeTokens();
      const z = 1.3;
      await setUp(dm, { width: 320, height: 360, scale: z });
      await checks([run.goblinLeft]);
      const card = dm.locator('[data-alert="concentration"]').first();
      await card.waitFor({ state: "attached" });
      // The check's card stands over the map's top here, Thorn under it, so he is panned below it first, as br-c-3 does.
      const c = (await card.boundingBox())!;
      const at = await middle(dm, run.thorn);
      const below = c.y + c.height + 16;
      if (at.y < below) await touchSwipe(dmCdp, { x: 12, y: below }, { x: 12, y: below + (below - at.y) }, { steps: 12, everyMs: 20 });
      await openOn(dm, run.thorn);
      const risen = dm.locator('button[aria-label^="Concentration save"]:not([data-rest-summary])').first();
      const header = frame(dm).locator("[data-rest-summary]");
      /** Whether the risen row takes a tap at its middle, or what does. */
      const rowHit = async () => {
        const r = await rectOf(risen);
        return risen.evaluate(
          (el, p) => {
            const top = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): unknown } }).document.elementFromPoint(p.x, p.y);
            const node = el as unknown as { contains(n: unknown): boolean };
            return top === el || node.contains(top) ? "row" : String((top as { outerHTML?: string } | null)?.outerHTML?.slice(0, 80));
          },
          { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 },
        );
      };
      // Before the toast, the row stands risen over the top bar's row, left of Undo, and takes its own tap.
      await risen.waitFor();
      assert.equal(await header.count(), 0, "the summary stands in the header with no toast");
      assert.equal(await rowHit(), "row", "the risen row takes no tap");
      const pats = await patOps();
      try {
        await pats.send({ t: "log.whisper", to: [dmSocket.you!.memberId], text: "Behind the altar." });
        const toast = dm.locator('[data-toast-form="row"]').filter({ hasText: "Behind the altar." });
        await toast.waitFor({ timeout: 8_000 });
        // The toast's box is taken: the summary goes to the strip's header, in reach, and the toast takes its own taps.
        await header.waitFor({ timeout: 2_000 });
        assert.equal(await risen.isVisible(), false, "the risen row still shows under the toast");
        assert.ok(await wholeInReach(header), "the header's summary is out of reach");
        assert.ok(await wholeInReach(toast.getByRole("button").first()), "the toast's words are out of reach");
        assert.deepEqual(alignmentLines(await measureAlignment(header), "the header's summary button at 320 x 360 at 130%"), []);
        await shots.take(dm, "br-f-20-summary-in-header");
        // As the toast runs out, the row rises into the top bar's row again.
        await toast.waitFor({ state: "detached", timeout: 8_000 });
        await risen.waitFor({ timeout: 2_000 });
        await header.waitFor({ state: "detached", timeout: 2_000 });
        assert.equal(await rowHit(), "row", "the risen row takes no tap after the toast");
        await shots.take(dm, "br-f-20-summary-back");
      } finally {
        pats.close();
      }
    });

    test("br-f-21. Multi-select turned on in the scrolling strip a roll card makes of the expanded bar ends the expanded state too, so the bar rests as the card goes, focus kept on Multi-select (review BB-OPUS-11)", async () => {
      await homeTokens();
      const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
      const thorn = bar(pat, "Thorn");
      const state = (s: string) => waitFor(`the bar's state ${s}`, async () => ((await thorn.getAttribute("data-bar-state")) === s ? true : null), 5_000);
      const id = randomUUID();
      try {
        await setUp(pat, { width: 375, height: 667, scale: 1 });
        await openOn(pat, run.thorn);
        await expandBar(thorn);
        await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
        await card.waitFor();
        await state("scrolls");
        const multi = await barControl(thorn, "Multi-select");
        await multi.tap();
        await pat.getByRole("toolbar", { name: "Select options" }).waitFor();
        await sleep(300);
        assert.equal(await multi.evaluate((el) => el.ownerDocument.activeElement === el), true, "focus left Multi-select in the scrolling strip");
        await ops.send({ t: "roll.close", rollIds: [id] });
        await card.waitFor({ state: "detached" });
        await sleep(600);
        assert.equal(await thorn.getAttribute("data-bar-state"), "rest", "the bar expanded again with Multi-select on");
        await shots.take(pat, "br-f-21-multi-from-scrolls-rests");
        await pat.getByRole("toolbar", { name: "Select options" }).getByRole("button", { name: "Done", exact: true }).click();
      } finally {
        await ops.send({ t: "roll.close", rollIds: [id] });
      }
    });
  });

  // ------------------------------------------------------------ br-c: the content (the content lane)

  describe("br-c: the strip's header, HP entry and quick row", () => {
    // Imported here, so the content's steps touch no line of the file's own setup.
    type Locator = import("playwright-core").Locator;
    const harness = () => import("./harness.ts");
    // The fit rule itself, by a path the server's typecheck does not follow: it covers e2e and stops at the client's JSX.
    const STRIP: string = "../client/canvas/barButtons.ts";
    const strip = async () => (await import(STRIP)) as { restFit(widths: Readonly<Record<string, number>>, room: number, gap: number, fieldMin: number): string[] };
    const alignment = () => import("./helpers/alignment.ts");

    /** The little of the page's DOM the in-page measures use, since e2e has no DOM types. */
    type PageBox = { left: number; right: number; width: number };
    type PageEl = {
      dataset: Record<string, string | undefined>;
      firstElementChild: PageEl | null;
      style: { flex: string; cssText: string };
      offsetWidth: number;
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
      clientHeight: number;
      textContent: string | null;
      blur(): void;
      cloneNode(deep: boolean): PageEl;
      querySelector(selector: string): PageEl | null;
      querySelectorAll(selector: string): Iterable<PageEl>;
      closest(selector: string): PageEl | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): PageBox;
      append(node: PageEl): void;
      replaceChildren(...nodes: PageEl[]): void;
      remove(): void;
    };
    type PageGlobals = { document: { createElement(tag: string): PageEl; activeElement: PageEl | null }; getComputedStyle(el: PageEl): { columnGap: string; visibility: string; paddingLeft: string; paddingRight: string } };

    /** A token's bar, by its frame's name. */
    const barOf = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions` });
    const socketOf = (page: Page) => (page === dm ? dmSocket : patSocket);

    /** Closes whatever bar is open, so the next tap lands on the map. */
    async function closeBars(page: Page): Promise<void> {
      for (const name of ["Close", "Deselect all"]) {
        const close = page.locator('[role="dialog"]').getByRole("button", { name, exact: true });
        if ((await close.count()) > 0 && (await close.first().isVisible())) await close.first().tap();
      }
      await waitFor("no bar open", async () => (await page.locator('[role="dialog"][aria-label$="actions"], [role="dialog"][aria-label$="selected tokens"]').count()) === 0);
    }

    /** Taps a token's middle on the map, where it stands now, and waits for a bar named `bar`. */
    async function tapToken(page: Page, t: Placed, bar = `${t.name} actions`): Promise<Locator> {
      const { pagePoint } = await harness();
      const now = socketOf(page).state!.tokens[t.id]!;
      const cells = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 }[now.size as string] ?? 1;
      const p = await pagePoint(page, BOUNDS, { x: now.x + cells / 2, y: now.y + cells / 2 });
      await page.touchscreen.tap(p.x, p.y);
      const frame = page.getByRole("dialog", { name: bar });
      await frame.waitFor();
      return frame;
    }

    /** Opens a token's bar afresh, as a viewer's tap does. */
    async function openBar(page: Page, t: Placed): Promise<Locator> {
      await closeBars(page);
      return tapToken(page, t);
    }

    /** The strip's state: the frame's Expand, by today's or the strip's name, and whether it rests. */
    const expandButton = (bar: Locator) => bar.getByRole("button", { name: /^(Expand|Larger)$/ });
    const collapseButton = (bar: Locator) => bar.getByRole("button", { name: /^(Collapse|Smaller)$/ });

    /**
     * Presses a control, in the quick row where it shows there, and else
     * behind Expand (the design's barControl), resting the bar again after,
     * so the map the expanded bar covered takes the next tap.
     */
    async function press(bar: Locator, name: string): Promise<void> {
      const inRow = bar.locator("[data-rest-row]").getByRole("button", { name, exact: true });
      if ((await inRow.count()) > 0 && (await inRow.first().isVisible())) {
        await inRow.first().tap();
        return;
      }
      const expanded = (await expandButton(bar).count()) > 0;
      if (expanded) await expandButton(bar).tap();
      await bar.getByRole("button", { name, exact: true }).first().tap();
      if (expanded && (await collapseButton(bar).count()) > 0) await collapseButton(bar).tap();
    }

    /**
     * The quick row as drawn: every candidate's id in order, those drawn,
     * each one's own width as the fit counts it (a copy laid out at its
     * natural width inside the row, so the font, the interface size and a
     * candidate the row skipped all count), the row's room and gap, and
     * the field's least width, all in the screen's px.
     */
    async function quickRow(bar: Locator) {
      return bar.locator("[data-rest-row]").first().evaluate((el) => {
        const row = el as unknown as PageEl;
        const { document, getComputedStyle } = globalThis as unknown as PageGlobals;
        const items = [...row.querySelectorAll(":scope > [data-rest-item]")];
        const box = row.getBoundingClientRect();
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;display:flex;width:max-content";
        row.append(probe);
        const widths: Record<string, number> = {};
        let fieldMin = 0;
        for (const item of items) {
          const id = item.dataset.restItem!;
          const node = item.firstElementChild;
          if (!node) {
            widths[id] = 0;
            continue;
          }
          const copy = node.cloneNode(true);
          copy.style.flex = "none";
          probe.replaceChildren(copy);
          const field = copy.querySelector("[data-rest-field]");
          const fieldWidth = field ? field.getBoundingClientRect().width : 0;
          if (field) fieldMin = fieldWidth;
          widths[id] = copy.getBoundingClientRect().width - fieldWidth;
        }
        probe.remove();
        // The field's least width is 56 layout px, so it gives the chrome's zoom for the gap, which CSS states unzoomed.
        const zoom = fieldMin > 0 ? fieldMin / 56 : box.width / Math.max(1, row.offsetWidth);
        const style = getComputedStyle(row);
        const gap = (Number.parseFloat(style.columnGap) || 0) * zoom;
        // The row reaches past its edges by a focus ring's width, as padding, which is no room for a control.
        const padding = ((Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)) * zoom;
        const shown = items
          .filter((item) => {
            const r = item.getBoundingClientRect();
            return r.width > 0.5 && getComputedStyle(item).visibility !== "hidden" && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
          })
          .map((item) => item.dataset.restItem!);
        return { ids: items.map((item) => item.dataset.restItem!), shown, widths, room: box.width - padding, gap, fieldMin: fieldMin || 56 * zoom };
      });
    }

    /** Asserts the row draws what restFit gives for its drawn widths (3.3), and returns it. */
    async function fitsByWidth(bar: Locator, label: string) {
      const { restFit } = await strip();
      const row = await quickRow(bar);
      const want = restFit(row.widths, row.room, row.gap, row.fieldMin);
      assert.deepEqual(row.shown, want, `${label}: the row draws ${row.shown.join(", ")}, the fit gives ${want.join(", ")} for ${JSON.stringify(row)}`);
      return row;
    }

    /** What the status line says, wherever it says it: the sentence that needs more room, else the line. */
    async function said(bar: Locator): Promise<string> {
      const status = bar.locator("[data-rest-status]").first();
      return (await status.getAttribute("data-rest-sentence")) ?? (await status.getAttribute("data-rest-line")) ?? "";
    }

    /**
     * The sentence as the strip draws it: where (the title's two lines or
     * the note), its words, and whether those two lines cut any of it, down
     * or across. Null where neither draws one.
     */
    async function drawnSentence(bar: Locator): Promise<{ place: "title" | "note"; text: string; cut: boolean } | null> {
      return bar.evaluate((el) => {
        const frame = el as unknown as PageEl;
        const note = frame.querySelector("[data-rest-note] > span");
        // The title's sentence takes the name's place, alone in the header's title, the frame's first strong.
        const title = frame.querySelector("strong")?.querySelector(":scope > span:only-child") ?? null;
        const drawn = note ?? title;
        if (!drawn) return null;
        const cut = drawn.scrollHeight > drawn.clientHeight + 1 || drawn.scrollWidth > drawn.clientWidth + 1;
        return { place: note ? ("note" as const) : ("title" as const), text: drawn.textContent ?? "", cut };
      });
    }

    /** Waits for what `read` gives to pass `ok`, naming the last value it read on a timeout. */
    async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
      let last: T | undefined;
      try {
        await waitFor(what, async () => ok((last = await read())));
      } catch {
        assert.fail(`${what}: the last read was ${JSON.stringify(last)}`);
      }
      return last as T;
    }

    /** The field's description as a screen reader reads it: the text of every element its aria-describedby names. */
    async function describedAs(field: Locator): Promise<string> {
      return field.evaluate((el) => {
        const { document } = globalThis as unknown as { document: { getElementById(id: string): PageEl | null } };
        const ids = ((el as unknown as PageEl).getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
        return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      });
    }

    async function alignmentOf(page: Page, root: Locator, screen: string): Promise<string[]> {
      const { alignmentLines, measureAlignment } = await alignment();
      return alignmentLines(await measureAlignment(root), screen);
    }

    test("br-c-1. the quick row per role and token, the group's, Undo move in Roll's place and Conditions from rest, fitted by drawn widths, once more with wider letters", async () => {
      await setUp(dm, PHONES[0]);
      await setUp(pat, PHONES[0]);
      const cases: { page: Page; who: string; token: Placed; ids: string[] }[] = [
        { page: dm, who: "the DM", token: run.thorn, ids: ["mode", "conditions", "roll", "multiSelect", "hidden"] },
        // A player's own token offers the door's button, which draws nothing with no door in reach, so the fit leaves it out.
        { page: pat, who: "Pat", token: run.thorn, ids: ["mode", "conditions", "door", "roll", "multiSelect"] },
        { page: pat, who: "Pat", token: run.goblin1, ids: ["multiSelect", "details"] },
        { page: dm, who: "the DM", token: run.barrel, ids: ["conditions", "roll", "multiSelect", "hidden", "details"] },
        { page: pat, who: "Pat", token: run.lantern, ids: ["conditions", "door", "roll", "multiSelect", "details"] },
      ];
      for (const c of cases) {
        const bar = await openBar(c.page, c.token);
        const label = `${c.who} on ${c.token.name} at 390 x 844`;
        const row = await fitsByWidth(bar, label);
        assert.deepEqual(row.ids, c.ids, `${label}: the candidates`);
        if (c.ids.includes("mode")) assert.equal(await said(bar), "AC 14 · HP 24/24", `${label}: the vitals in the status line`);
        await shots.take(c.page, `br-c-1-${c.page === dm ? "dm" : "pat"}-${c.token.name.toLowerCase().replace(/ /g, "-")}`);
      }

      // Undo move after a drag takes Roll's place where it fits, Conditions kept (D-261024-12), at 390 and 375.
      const { pagePoint, touchSwipe } = await harness();
      for (const view of [PHONES[0], PHONES[1]]) {
        await setUp(pat, view);
        const label = `Pat at ${view.width} x ${view.height}`;
        await openBar(pat, run.thorn);
        const before = patSocket.state!.tokens[run.thorn.id]!;
        const from = await pagePoint(pat, BOUNDS, { x: before.x + 0.5, y: before.y + 0.5 });
        const to = await pagePoint(pat, BOUNDS, { x: before.x + 1.5, y: before.y + 0.5 });
        await touchSwipe(patCdp, from, to, { steps: 10, everyMs: 20 });
        await waitFor(`${label}: Thorn one cell east`, () => patSocket.state?.tokens[run.thorn.id]?.x === before.x + 1);
        const bar = barOf(pat, "Thorn");
        await bar.locator("[data-rest-row]").getByRole("button", { name: "Undo move", exact: true }).waitFor({ state: "attached" });
        const row = await fitsByWidth(bar, `${label}, Undo move`);
        assert.ok(row.ids.includes("undoMove") && row.ids.includes("roll"), `${label}: Undo move and Roll are both candidates`);
        assert.ok(row.shown.includes("undoMove") && !row.shown.includes("roll") && row.shown.includes("conditions"), `${label}: Undo move in Roll's place, Conditions kept: ${row.shown.join(", ")}`);
        await shots.take(pat, `br-c-1-undo-${view.width}`);
        await bar.locator("[data-rest-row]").getByRole("button", { name: "Undo move", exact: true }).tap();
        await waitFor(`${label}: Thorn back`, () => patSocket.state?.tokens[run.thorn.id]?.x === before.x);
      }

      // Conditions from rest: the bar expands with the drawer, focus on Conditions there, and closing the drawer rests it again.
      await setUp(pat, PHONES[0]);
      const thorn = await openBar(pat, run.thorn);
      await thorn.locator("[data-rest-row]").getByRole("button", { name: "Conditions", exact: true }).tap();
      await thorn.getByRole("group", { name: "Conditions" }).waitFor();
      await collapseButton(thorn).waitFor();
      const focused = () =>
        pat.evaluate(() => {
          const el = (globalThis as unknown as PageGlobals).document.activeElement;
          return { name: el?.textContent?.trim() ?? "", pressed: el?.getAttribute("aria-pressed") ?? null, inRow: el?.closest("[data-rest-row]") !== null };
        });
      assert.deepEqual(await focused(), { name: "Conditions", pressed: "true", inRow: false }, "focus on the expanded bar's Conditions, pressed");
      await shots.take(pat, "br-c-1-conditions-from-rest");
      await thorn.getByRole("button", { name: "Conditions", exact: true }).tap();
      await expandButton(thorn).waitFor();
      assert.equal(await thorn.getByRole("group", { name: "Conditions" }).count(), 0, "the drawer closed");
      assert.deepEqual(await focused(), { name: "Conditions", pressed: "false", inRow: true }, "focus back on the strip's Conditions");

      // The group's strip: "3 selected", the group's entry as the lead, then Conditions, Roll, Multi-select and Hidden for the DM.
      await setUp(dm, PHONES[0]);
      const goblin = await openBar(dm, run.goblin1);
      await press(goblin, "Multi-select");
      await tapToken(dm, run.goblin2, "2 selected tokens");
      const group = await tapToken(dm, run.thorn, "3 selected tokens");
      if ((await collapseButton(group).count()) > 0) await collapseButton(group).tap();
      // The header's title: its first line names the group, the status line under it.
      assert.equal(((await group.locator("strong > span").first().textContent()) ?? "").trim(), "3 selected");
      const groupRow = await fitsByWidth(group, "the DM's group at 390 x 844");
      assert.deepEqual(groupRow.ids, ["mode", "conditions", "roll", "multiSelect", "hidden"]);
      assert.equal(await said(group), "Goblin 1, Goblin 2, Thorn");
      await shots.take(dm, "br-c-1-group-dm");
      assert.deepEqual(await alignmentOf(dm, group, "the DM's group strip at 390 x 844"), []);
      await closeBars(dm);
      // Pat's group leaves out the goblins, and the status line says so.
      const patThorn = await openBar(pat, run.thorn);
      await press(patThorn, "Multi-select");
      await tapToken(pat, run.goblin1, "2 selected tokens");
      const patGroup = await tapToken(pat, run.goblin2, "3 selected tokens");
      if ((await collapseButton(patGroup).count()) > 0) await collapseButton(patGroup).tap();
      assert.deepEqual((await quickRow(patGroup)).ids, ["mode", "multiSelect"]);
      assert.equal(await said(patGroup), "Leaves out Goblin 1, Goblin 2: you cannot change their HP.");
      await shots.take(pat, "br-c-1-group-pat");
      await closeBars(pat);
      await press(await openBar(pat, run.thorn), "Multi-select");
      await closeBars(pat);

      // At 375 x 667 the row fits by drawn widths, and with the strip's letters drawn wider, Roll drops and Conditions stays.
      await setUp(pat, PHONES[1]);
      await fitsByWidth(await openBar(pat, run.thorn), "Pat at 375 x 667");
      const wide = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true, storageState: await patContext.storageState() });
      try {
        const page = await wide.newPage();
        await page.goto(`${server.origin}/r/${run.roomId}`);
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        await page.addStyleTag({ content: "[data-rest-row] button { letter-spacing: 1.5px !important; }" });
        const { pagePoint: point } = await harness();
        const t = patSocket.state!.tokens[run.thorn.id]!;
        const p = await point(page, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
        await page.touchscreen.tap(p.x, p.y);
        const bar = barOf(page, "Thorn");
        await bar.waitFor();
        const row = await fitsByWidth(bar, "Pat at 375 x 667 with wider letters");
        assert.ok(row.shown.includes("conditions") && !row.shown.includes("roll"), `Roll drops by the drawn widths, Conditions kept: ${row.shown.join(", ")}`);
        await shots.take(page, "br-c-1-wider-letters-375");
      } finally {
        await wide.close();
      }

      // Alignment of Pat's strip on Thorn at the alignment sizes.
      for (const view of [PHONES[0], { width: 390, height: 844, scale: 1.3 }, { width: 320, height: 568, scale: 1 }, PHONES[3]]) {
        await setUp(pat, view);
        const bar = await openBar(pat, run.thorn);
        assert.deepEqual(await alignmentOf(pat, bar, `Pat's strip on Thorn at ${view.width} x ${view.height} at ${view.scale * 100}%`), []);
      }
      await closeBars(pat);
    });

    /** Thorn's HP and death saves as the DM's copy holds them. */
    const thornHp = () => dmSocket.state?.characters[run.thorn.characterId]?.actor;

    /** Thorn at 0 HP, dying, his saves cleared, or whole again at 24. */
    async function thornAt(cur: 0 | 24): Promise<void> {
      if (cur === 24) await ops.send({ t: "actor.life", target: { tokenId: run.thorn.id }, life: "alive" });
      await ops.send({ t: "actor.hp", target: { tokenId: run.thorn.id }, change: { kind: "set", cur } });
      if (cur === 0) await ops.send({ t: "actor.deathSave", target: { tokenId: run.thorn.id }, ok: 0, fail: 0 });
      await waitFor(`Thorn at ${cur}`, () => thornHp()?.hp?.cur === cur && (cur > 0 || thornHp()?.life === "dying"));
    }

    test("br-c-2. the HP entry in the strip: the toggle, a mode kept from the expanded bar, invalid input, a refusal, Crit on a dying creature, a kept Crit at 320 x 568 at 130%, a group's left-out creatures and a dead line", async () => {
      await setUp(dm, PHONES[0]);
      let thorn = await openBar(dm, run.thorn);
      const row = () => thorn.locator("[data-rest-row]");
      const field = () => row().getByRole("textbox", { name: "HP change" });
      const toggle = () => row().locator("[data-rest-mode]");
      const apply = () => row().getByRole("button", { name: "Apply", exact: true });
      const mode = async () => ({ name: await toggle().getAttribute("aria-label"), sign: ((await toggle().textContent()) ?? "").trim() });

      // The toggle names its mode and draws its sign, and a tap switches Damage and Heal (D-261024-10).
      assert.deepEqual(await mode(), { name: "Damage", sign: "−" });
      await toggle().tap();
      assert.deepEqual(await mode(), { name: "Heal", sign: "+" });
      await toggle().tap();
      await field().fill("10");
      assert.equal(await said(thorn), "10 damage");
      await apply().tap();
      await waitFor("Thorn at 14", () => thornHp()?.hp?.cur === 14);
      assert.equal(await said(thorn), "AC 14 · HP 14/24");

      // Heal picked in the expanded bar is kept as the bar rests: the toggle shows +, and Apply heals.
      await expandButton(thorn).tap();
      await thorn.getByRole("radiogroup", { name: "What the number does" }).getByRole("radio", { name: "Heal" }).check({ force: true });
      await collapseButton(thorn).tap();
      assert.deepEqual(await mode(), { name: "Heal", sign: "+" });
      await field().fill("7");
      assert.equal(await said(thorn), "Heal 7");
      await apply().tap();
      await waitFor("Thorn at 21", () => thornHp()?.hp?.cur === 21);
      await shots.take(dm, "br-c-2-heal-kept");

      // Invalid input: the error in the status line, in the error tone and said once, and focus kept in the field.
      await field().fill("abc");
      await field().press("Enter");
      assert.equal(await said(thorn), "Use a number, such as -7, +5, =20 or t5.");
      assert.equal(((await thorn.locator('[role="status"]').filter({ hasText: "Use a number" }).count()) > 0), true, "the error is said");
      assert.equal(await field().evaluate((el) => (globalThis as unknown as PageGlobals).document.activeElement === (el as unknown as PageEl)), true, "focus stays in the field");
      await shots.take(dm, "br-c-2-error");
      await field().fill("");

      // Crit on a dying creature: in the row where it fits, pressed, and the damage counts two failed saves.
      await thornAt(0);
      thorn = await openBar(dm, run.thorn);
      const dying = await fitsByWidth(thorn, "the DM on a dying Thorn at 390 x 844");
      assert.ok(dying.ids.includes("crit"), "Crit is a candidate at 0 HP");
      assert.ok(dying.shown.includes("crit"), `Crit fits at 390 x 844: ${dying.shown.join(", ")}`);
      const crit = row().getByRole("button", { name: "Critical Hit (two failed Death Saves)" });
      await crit.tap();
      assert.equal(await crit.getAttribute("aria-pressed"), "true");
      await field().fill("7");
      // Its own control shows it, so the line does not name it.
      assert.equal(await said(thorn), "7 damage");
      await apply().tap();
      await waitFor("two failed saves", () => thornHp()?.deathSaves?.fail === 2);
      await shots.take(dm, "br-c-2-crit-dying");

      // A kept Crit with valid text at 320 x 568 at 130%, where Crit does not fit: the status line names it, and Apply counts it.
      await thornAt(0);
      await setUp(dm, PHONES[3]);
      thorn = await openBar(dm, run.thorn);
      const small = await fitsByWidth(thorn, "the DM on a dying Thorn at 320 x 568 at 130%");
      assert.deepEqual(small.shown, ["mode"], "the lead alone");
      await expandButton(thorn).tap();
      await thorn.getByRole("checkbox", { name: "Critical Hit (two failed Death Saves)" }).check({ force: true });
      await collapseButton(thorn).tap();
      assert.equal(await said(thorn), "Critical Hit");
      await field().fill("7");
      assert.equal(await said(thorn), "7 damage, Critical Hit");
      await shots.take(dm, "br-c-2-crit-kept-320");
      await apply().tap();
      await waitFor("two failed saves", () => thornHp()?.deathSaves?.fail === 2);
      // Kept into Heal, it is never sent, so never named.
      await thornAt(0);
      thorn = await openBar(dm, run.thorn);
      await expandButton(thorn).tap();
      await thorn.getByRole("checkbox", { name: "Critical Hit (two failed Death Saves)" }).check({ force: true });
      await collapseButton(thorn).tap();
      await toggle().tap();
      await field().fill("5");
      assert.equal(await said(thorn), "Heal 5");
      await field().fill("");
      await thornAt(24);

      // A refusal: with "players apply damage", Pat's =20 on a goblin, Apply disabled.
      await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
      try {
        await setUp(pat, PHONES[0]);
        const goblin = await openBar(pat, run.goblin1);
        const goblinField = goblin.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" });
        await goblinField.fill("=20");
        assert.equal(await said(goblin), "You can only deal damage to or heal this creature.");
        assert.equal(await goblin.locator("[data-rest-row]").getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
        await shots.take(pat, "br-c-2-refusal");
        await goblinField.fill("");
      } finally {
        await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
      }

      // A group's left-out creatures: Pat's Thorn and two goblins, 7 typed, at 390 x 844 and in the note at 320 x 568 at 130%.
      for (const view of [PHONES[0], PHONES[3]]) {
        await setUp(pat, view);
        await press(await openBar(pat, run.thorn), "Multi-select");
        await tapToken(pat, run.goblin1, "2 selected tokens");
        const group = await tapToken(pat, run.goblin2, "3 selected tokens");
        if ((await collapseButton(group).count()) > 0) await collapseButton(group).tap();
        await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("7");
        assert.equal(await said(group), "7 damage, not Goblin 1, Goblin 2", `${view.width} x ${view.height}`);
        // One line holds it at 390, and at 320 x 568 at 130% it needs the title's two lines or the note, by its drawn width.
        const place = await group.locator("[data-rest-status]").getAttribute("data-rest-place");
        if (view.scale > 1) assert.ok(place === "title" || place === "note", `the sentence needs more than the line: ${place}`);
        else assert.equal(place, null, "the line holds it");
        await shots.take(pat, `br-c-2-group-left-out-${view.width}`);
        await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("");
        await closeBars(pat);
        await press(await openBar(pat, run.thorn), "Multi-select");
        await closeBars(pat);
      }

      // A dead line: the DM heals a dead goblin, with healing bringing back the dead and without.
      await setUp(dm, PHONES[0]);
      await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "dead" });
      try {
        const goblin = await openBar(dm, run.goblin2);
        const goblinToggle = goblin.locator("[data-rest-row] [data-rest-mode]");
        await goblinToggle.tap();
        assert.equal(await goblinToggle.getAttribute("aria-label"), "Heal");
        assert.equal(await said(goblin), "Brings back 1 dead creature.");
        await ops.send({ t: "room.update", settings: { healRevives: false } });
        await waitFor("the dead line", async () => (await said(goblin)) === "Healing does nothing while Goblin 2 is dead. Revive first.");
        await shots.take(dm, "br-c-2-dead-line");
      } finally {
        await ops.send({ t: "room.update", settings: { healRevives: true } });
        await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "alive" });
      }
      await closeBars(dm);
    });

    test("br-c-3. the scrolling strip at F of 210 and 148 and at 375 x 667 with a roll card: every control whole and on top when scrolled to, Scroll for more, and the DM's alerts back up at its header", async () => {
      /** Every control below the header, each scrolled into view: whole in the scroller, and the top thing at its middle and 2 px in from each corner. */
      const sweep = (bar: Locator) =>
        bar.evaluate((el) => {
          type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
          type Node = {
            getBoundingClientRect(): Rect;
            scrollIntoView(o: { block: string }): void;
            contains(n: unknown): boolean;
            getAttribute(n: string): string | null;
            textContent: string | null;
            parentElement: Node | null;
            scrollHeight: number;
            clientHeight: number;
            scrollTop: number;
            querySelector(s: string): Node | null;
            querySelectorAll(s: string): Iterable<Node>;
          };
          const frame = el as unknown as Node;
          const { document, getComputedStyle } = globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null }; getComputedStyle(n: Node): { overflowY: string; visibility: string } };
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1);
          if (!scroller) return { scrolls: false, misses: ["no scroller"], count: 0 };
          // The header, the row the title stands in, scrolls too: its own controls are the frame's, not the content's.
          const header = scroller.querySelector("strong")?.parentElement ?? null;
          const misses: string[] = [];
          // What the strip draws: a candidate the quick row skipped is no control of the strip's.
          const controls = [...scroller.querySelectorAll("button, input, select, textarea, [role='checkbox'], [role='radio']")].filter(
            (c) => c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== "hidden" && !(header?.contains(c) ?? false),
          );
          for (const c of controls) {
            c.scrollIntoView({ block: "nearest" });
            const r = c.getBoundingClientRect();
            const s = scroller.getBoundingClientRect();
            const name = c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "?";
            if (r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5) misses.push(`${name}: not whole`);
            for (const [x, y] of [[(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]] as const) {
              const top = document.elementFromPoint(x, y);
              if (!top || !(c.contains(top) || top.contains(c))) misses.push(`${name}: covered at ${Math.round(x)},${Math.round(y)}`);
            }
          }
          scroller.scrollTop = 0;
          return { scrolls: true, misses, count: controls.length };
        });
      const scrollerTop = (bar: Locator) =>
        bar.evaluate((el) => {
          type Node = { scrollHeight: number; clientHeight: number; scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
          const { getComputedStyle } = globalThis as unknown as { getComputedStyle(n: Node): { overflowY: string } };
          const frame = el as unknown as Node;
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1);
          return scroller ? { top: scroller.scrollTop, window: scroller.clientHeight } : null;
        });

      const windows = [
        { view: { width: 320, height: 440, scale: 1.3 }, page: dm, label: "320 x 440 at 130%, F = 210" },
        { view: { width: 320, height: 360, scale: 1.3 }, page: dm, label: "320 x 360 at 130%, F = 148" },
        { view: PHONES[1], page: pat, label: "375 x 667 with a roll card, F = 237" },
      ];
      const card = randomUUID();
      try {
        for (const w of windows) {
          await setUp(w.page, w.view);
          if (w.page === pat) {
            await ops.send({ t: "roll.ask", request: { id: card, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
            await pat.getByText("The DM asks for a Dexterity saving throw.").first().waitFor();
            // The card stands over the map's foot, so Thorn is panned above it first, as a player would.
            const { pagePoint, touchSwipe } = await harness();
            const cardTop = (await pat.getByRole("dialog", { name: "The DM asks for a roll" }).boundingBox())!.y;
            const t = patSocket.state!.tokens[run.thorn.id]!;
            const at = await pagePoint(pat, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
            if (at.y > cardTop - 60) await touchSwipe(patCdp, { x: 24, y: cardTop - 8 }, { x: 24, y: cardTop - 8 - (at.y - cardTop + 120) }, { steps: 12, everyMs: 20 });
          }
          const bar = await openBar(w.page, run.thorn);
          assert.equal(await expandButton(bar).count(), 0, `${w.label}: Expand is not offered`);
          const more = bar.getByRole("button", { name: "Scroll for more", exact: true });
          await more.waitFor();
          const swept = await sweep(bar);
          assert.ok(swept.scrolls && swept.count > 0, `${w.label}: the strip scrolls`);
          assert.deepEqual(swept.misses, [], `${w.label}`);
          assert.deepEqual(await alignmentOf(w.page, bar, `the scrolling strip at ${w.label}, top`), []);
          // "Scroll for more" moves one window less 44, so the row at its foot comes to its top.
          const before = (await scrollerTop(bar))!;
          await more.tap();
          await waitFor(`${w.label}: scrolled one window less 44`, async () => Math.abs((await scrollerTop(bar))!.top - (before.top + before.window - 44)) <= 1);
          assert.deepEqual(await alignmentOf(w.page, bar, `the scrolling strip at ${w.label}, middle`), []);
          await shots.take(w.page, `br-c-3-${w.view.width}x${w.view.height}`);
          await closeBars(w.page);
        }
      } finally {
        await ops.send({ t: "roll.close", rollIds: [card] });
      }

      // The DM's alerts from the strip's foot: a concentration check stands, its summary in the header, reached by scrolling back up.
      const caster = run.goblinLeft.id;
      await ops.send({ t: "actor.effect.add", target: { tokenId: caster }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
      await setUp(dm, { width: 320, height: 360, scale: 1.3 });
      await ops.send({ t: "actor.hp", target: { tokenId: caster }, change: { kind: "damage", amount: 1 } });
      await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
      {
        // The check's card stands over the map's top at this size, Thorn under it, so he is panned below it first, as the DM would.
        const { pagePoint, touchSwipe } = await harness();
        const card = (await dm.locator('[data-alert="concentration"]').first().boundingBox())!;
        const t = dmSocket.state!.tokens[run.thorn.id]!;
        const at = await pagePoint(dm, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
        const below = card.y + card.height + 16;
        if (at.y < below) await touchSwipe(dmCdp, { x: 12, y: below }, { x: 12, y: below + (below - at.y) }, { steps: 12, everyMs: 20 });
      }
      const bar = await openBar(dm, run.thorn);
      const summary = bar.getByRole("button", { name: /^Concentration save/ });
      if ((await summary.count()) === 0) {
        // The DM's top bar leaves a gap left of Undo here, which takes the summary row (3.5), so the header holds none to scroll away: the row stays in reach.
        const row = dm.getByRole("button", { name: /^Concentration save/ }).first();
        assert.ok(await (await harness()).wholeInReach(row), "the summary row risen over the top bar is out of reach");
      } else {
        await bar.evaluate((el) => {
          type Node = { scrollHeight: number; clientHeight: number; scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
          const { getComputedStyle } = globalThis as unknown as { getComputedStyle(n: Node): { overflowY: string } };
          const frame = el as unknown as Node;
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY));
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        });
        assert.equal(await summary.isVisible() && (await (await harness()).wholeInReach(summary)), false, "the header's summary scrolled away at the strip's foot");
        await bar.evaluate((el) => {
          type Node = { scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
          for (const n of [el as unknown as Node, ...(el as unknown as Node).querySelectorAll("*")]) n.scrollTop = 0;
        });
        assert.ok(await (await harness()).wholeInReach(summary), "a scroll back up brings the summary's button in the header");
      }
      await shots.take(dm, "br-c-3-alerts-back-up");
      await closeBars(dm);
    });

    /** The DM's strip on a dead Thorn, healing the dead off, his HP entry in Heal. */
    async function deadThornInHeal(): Promise<{ bar: Locator; field: Locator; apply: Locator }> {
      const bar = await openBar(dm, run.thorn);
      const row = bar.locator("[data-rest-row]");
      const toggle = row.locator("[data-rest-mode]");
      if ((await toggle.getAttribute("aria-label")) !== "Heal") await toggle.tap();
      assert.equal(await toggle.getAttribute("aria-label"), "Heal");
      return { bar, field: row.getByRole("textbox", { name: "HP change" }), apply: row.getByRole("button", { name: "Apply", exact: true }) };
    }

    async function thornDead(): Promise<void> {
      await ops.send({ t: "room.update", settings: { healRevives: false } });
      await thornAt(0);
      await ops.send({ t: "actor.life", target: { tokenId: run.thorn.id }, life: "dead" });
      await waitFor("Thorn dead", () => thornHp()?.life === "dead");
    }

    async function thornAlive(): Promise<void> {
      await ops.send({ t: "room.update", settings: { healRevives: true } });
      await thornAt(24);
    }

    const DEAD_LINE = "Healing does nothing while Thorn is dead. Revive first.";

    test("br-c-4. the note goes as the field empties, focus leaves the strip or Apply succeeds, and comes back as focus returns or its sentence changes, the title's line on the vitals meanwhile and the field described by the whole sentence", async () => {
      await thornDead();
      try {
        await setUp(dm, PHONES[3]);
        const { bar, field, apply } = await deadThornInHeal();
        const vitals = /HP 0\/24 Dead$/;
        // The empty field's dead line needs the note at 320 x 568 at 130%, and the note goes as the field empties, so none stands (3.3).
        await until("the empty field's line", () => said(bar), (t) => vitals.test(t));
        assert.equal(await drawnSentence(bar), null, "no note, and no sentence in the title, with the field empty");
        assert.ok((await describedAs(field)).includes("Healing does nothing while Thorn is dead. Revive Thorn first."), "the field is described by the whole dead line");
        await shots.take(dm, "br-c-4-empty-field-no-note");

        // Typed, the dead line stands in the note, whole, and lines up.
        await field.fill("5");
        await until("the note", () => drawnSentence(bar), (d) => d?.place === "note");
        assert.deepEqual(await drawnSentence(bar), { place: "note", text: DEAD_LINE, cut: false });
        assert.deepEqual(await alignmentOf(dm, bar, "the dead line's note at 320 x 568 at 130%"), []);
        await shots.take(dm, "br-c-4-note");

        // Focus leaves the strip: the note goes, the title's line stays on the vitals, and the field keeps the whole sentence.
        await field.evaluate((el) => (el as unknown as PageEl).blur());
        await until("the note gone", () => drawnSentence(bar), (d) => d === null);
        assert.match(await said(bar), vitals);
        assert.equal(await field.inputValue(), "5");
        assert.ok((await describedAs(field)).includes("Healing does nothing while Thorn is dead. Revive Thorn first."), "the description stays whole");
        await shots.take(dm, "br-c-4-blurred");

        // Focus back in the strip brings it back, and it stays as focus moves within the strip.
        await field.focus();
        await until("the note back", () => drawnSentence(bar), (d) => d?.place === "note");
        await bar.locator("[data-rest-row] [data-rest-mode]").focus();
        await dm.waitForTimeout(150);
        assert.equal((await drawnSentence(bar))?.place, "note", "focus on the toggle keeps the note");

        // Away again, a new sentence brings it back without focus: healing the dead turned on, then off again, changes it twice.
        await field.focus();
        await field.evaluate((el) => (el as unknown as PageEl).blur());
        await until("the note gone", () => drawnSentence(bar), (d) => d === null);
        await ops.send({ t: "room.update", settings: { healRevives: true } });
        await until("healing brings Thorn back", () => said(bar), (t) => t === "Brings back 1 dead creature.");
        await ops.send({ t: "room.update", settings: { healRevives: false } });
        await until("the dead line again", () => said(bar), (t) => t === DEAD_LINE);
        assert.equal((await drawnSentence(bar))?.place, "note", "a sentence that changes while focus is away shows");

        // Apply succeeds and empties the field: the note goes.
        await field.focus();
        await apply.tap();
        await waitFor("the field empty", async () => (await field.inputValue()) === "");
        await until("the note gone", () => drawnSentence(bar), (d) => d === null);
        assert.match(await said(bar), vitals);
        await closeBars(dm);
      } finally {
        await thornAlive();
      }
    });

    /** Picks an interface size live, from Menu's This device, as a viewer does, and closes the menu again. */
    async function interfaceSize(page: Page, label: "100%" | "130%"): Promise<void> {
      await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
      await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).tap();
      await page.getByRole("button", { name: /^This device/ }).tap();
      await page.getByRole("radiogroup", { name: "Interface size" }).getByRole("radio", { name: label }).check({ force: true });
      await page.getByRole("region", { name: "Menu" }).getByRole("button", { name: "Close Menu" }).tap();
      await waitFor(`the menu closed at ${label}`, async () => (await page.getByRole("radiogroup", { name: "Interface size" }).count()) === 0);
    }

    /**
     * Whether the header's title would cut a sentence drawn in the note: a
     * copy of the note's words, in its look, laid out in the title where
     * the sentence would stand there.
     */
    async function titleWouldCut(bar: Locator): Promise<boolean> {
      return bar.evaluate((el) => {
        const frame = el as unknown as PageEl;
        const { getComputedStyle } = globalThis as unknown as { getComputedStyle(el: PageEl): { fontSize: string; fontWeight: string } };
        const note = frame.querySelector("[data-rest-note] > span")!;
        const title = frame.querySelector("strong")!;
        const copy = note.cloneNode(true);
        copy.style.cssText += `;font-size:${getComputedStyle(note).fontSize};font-weight:${getComputedStyle(note).fontWeight}`;
        title.append(copy);
        const cut = copy.scrollHeight > copy.clientHeight + 1;
        copy.remove();
        return cut;
      });
    }

    test("br-c-5. a sentence in the title follows the title's width as the screen narrows and widens, a header badge comes and goes and the interface size changes, never cut and in the note only where the title would cut it", async () => {
      await thornDead();
      const badge = async (elevation: number) => {
        await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { elevation } });
        await waitFor(`elevation ${elevation}`, () => dmSocket.state?.tokens[run.thorn.id]?.elevation === elevation);
      };
      try {
        await setUp(dm, PHONES[0]);
        const { bar, field } = await deadThornInHeal();
        await field.fill("5");
        const seen = new Set<string>();
        // Each change is made on the standing strip, which settles with its sentence whole, in the note only where the title would cut it.
        const step = async (label: string, change: () => Promise<void>) => {
          await change();
          await field.focus();
          await until(`${label}: the sentence whole`, () => drawnSentence(bar), (d) => d !== null && !d.cut);
          await dm.waitForTimeout(150);
          const drawn = (await drawnSentence(bar))!;
          assert.deepEqual({ text: drawn.text, cut: drawn.cut }, { text: DEAD_LINE, cut: false }, label);
          if (drawn.place === "note") assert.equal(await titleWouldCut(bar), true, `${label}: the note stands where the title holds the sentence`);
          else assert.deepEqual(await alignmentOf(dm, bar, `the title's sentence, ${label}`), []);
          seen.add(drawn.place);
          await shots.take(dm, `br-c-5-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${drawn.place}`);
        };
        await step("390 x 844", async () => {});
        await step("390 x 844 with a 30 ft badge", () => badge(30));
        await step("320 x 568 with the badge", () => dm.setViewportSize({ width: 320, height: 568 }));
        await step("320 x 568 without it", () => badge(0));
        await step("320 x 568 with it again", () => badge(30));
        await step("320 x 568 without it again", () => badge(0));
        await step("390 x 844 again", () => dm.setViewportSize({ width: 390, height: 844 }));
        await step("390 x 844 at 130%", async () => {
          await interfaceSize(dm, "130%");
          await bar.locator("[data-rest-status]").waitFor({ state: "attached" });
        });
        await step("390 x 844 at 100% again", async () => {
          await interfaceSize(dm, "100%");
          await bar.locator("[data-rest-status]").waitFor({ state: "attached" });
        });
        // The screen, the badge and the interface size each moved it between the title and the note at least once.
        assert.deepEqual([...seen].sort(), ["note", "title"]);
        await closeBars(dm);
      } finally {
        await badge(0);
        await dm.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
        await thornAlive();
      }
    });

    test("br-c-6. an unbroken 80-letter name: the dead line and the Set line keep their warning and recovery whole, and a preview ending in the name keeps its two lines, in the title or the note", async () => {
      // No space in it, so only the sentence's own wrapping, anywhere, breaks it (B.4).
      const long = "Kethryllia".repeat(8);
      const rename = async (who: Placed, name: string) => {
        if (who === run.thorn) await ops.send({ t: "character.update", characterId: run.thorn.characterId, patch: { name } });
        await ops.send({ t: "token.update", tokenId: who.id, patch: { name } });
        await waitFor(`${who.name} named ${name.length} letters`, () => dmSocket.state?.tokens[who.id]?.name === name);
      };
      await thornDead();
      await rename(run.thorn, long);
      try {
        for (const view of [PHONES[3], PHONES[0]]) {
          const label = `${view.width} x ${view.height} at ${view.scale * 100}%`;
          await setUp(dm, view);
          await closeBars(dm);
          const bar = await tapToken(dm, run.thorn, `${long} actions`);
          const row = bar.locator("[data-rest-row]");
          const toggle = row.locator("[data-rest-mode]");
          if ((await toggle.getAttribute("aria-label")) !== "Heal") await toggle.tap();
          const field = row.getByRole("textbox", { name: "HP change" });
          for (const typed of [{ text: "5", warning: "Healing does nothing while ", recovery: " is dead. Revive first." }, { text: "=5", warning: "", recovery: " stays dead at the new HP. Only Revive brings them back." }]) {
            await field.fill(typed.text);
            const drawn = (await until(`${label}, ${typed.text}: a sentence`, () => drawnSentence(bar), (d) => d !== null))!;
            assert.equal(drawn.cut, false, `${label}, ${typed.text}: the ${drawn.place} cuts "${drawn.text}"`);
            assert.ok(drawn.text.startsWith(typed.warning) && drawn.text.endsWith(typed.recovery), `${label}, ${typed.text}: "${drawn.text}"`);
            assert.deepEqual(await alignmentOf(dm, bar, `the ${drawn.place} with an 80-letter name at ${label}, ${typed.text}`), []);
            await shots.take(dm, `br-c-6-${typed.text === "5" ? "heal" : "set"}-${view.width}${view.scale > 1 ? "-130" : ""}`);
          }
          await field.fill("");
          await closeBars(dm);
        }
        await rename(run.thorn, "Thorn");
        await thornAlive();

        // Pat's Thorn and a goblin named so, 7 typed: "7 damage, not" and the name, which ends the sentence, so nothing after it shows a cut.
        await rename(run.goblin1, long);
        for (const view of [PHONES[3], PHONES[0]]) {
          const label = `${view.width} x ${view.height} at ${view.scale * 100}%`;
          await setUp(pat, view);
          await press(await openBar(pat, run.thorn), "Multi-select");
          const group = await tapToken(pat, run.goblin1, "2 selected tokens");
          if ((await collapseButton(group).count()) > 0) await collapseButton(group).tap();
          await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("7");
          const drawn = (await until(`${label}: a sentence`, () => drawnSentence(group), (d) => d !== null))!;
          assert.equal(drawn.cut, false, `${label}: the ${drawn.place} cuts "${drawn.text}"`);
          assert.ok(drawn.text.startsWith("7 damage, not Kethryllia"), `${label}: "${drawn.text}"`);
          assert.deepEqual(await alignmentOf(pat, group, `the group's ${drawn.place} with an 80-letter name at ${label}`), []);
          await shots.take(pat, `br-c-6-group-${view.width}${view.scale > 1 ? "-130" : ""}`);
          await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("");
          await closeBars(pat);
          await press(await openBar(pat, run.thorn), "Multi-select");
          await closeBars(pat);
        }
      } finally {
        await rename(run.thorn, "Thorn");
        await rename(run.goblin1, "Goblin 1");
        await thornAlive();
      }
    });

    /**
     * The header's Expand or Collapse: the words it shows, whether its
     * chevron draws, and its width in layout px. Words hidden from sight
     * but kept as its name (D-261024-46) are no words shown.
     */
    const sizeControl = (bar: Locator) =>
      bar
        .getByRole("button", { name: /^(Expand|Collapse)$/ })
        .first()
        .evaluate((el) => {
          type Node = { nodeType: number; textContent: string | null; getBoundingClientRect?(): { width: number } };
          const button = el as unknown as PageEl & { currentCSSZoom?: number; childNodes: ArrayLike<Node> };
          const zoom = button.currentCSSZoom ?? 1;
          // A text node shows its words, and an element its own where it is wider than the 1 px a visually hidden one keeps.
          const words = Array.from(button.childNodes)
            .map((n) => (n.nodeType === 3 || (n.getBoundingClientRect?.().width ?? 0) > 2 * zoom ? (n.textContent ?? "") : ""))
            .join("")
            .trim();
          return { words, chevron: button.querySelector("svg") !== null, width: Math.round(button.getBoundingClientRect().width / zoom) };
        });
    /** Whether the strip's name is cut, and the status line under it. */
    const titleAndLine = (bar: Locator) =>
      bar.evaluate((el) => {
        const frame = el as unknown as PageEl;
        const title = frame.querySelector("strong");
        const cut = title !== null && [title, ...title.querySelectorAll("span")].some((s) => s.scrollWidth > s.clientWidth + 0.5);
        return { cut, line: frame.querySelector("[data-rest-status]")?.getAttribute("data-rest-line") ?? "" };
      });
    const barState = (bar: Locator, want: string) => until(`the bar ${want}`, () => bar.getAttribute("data-bar-state"), (s) => s === want);
    /** Whether focus stands on the strip's Expand. */
    const focusOnExpand = (bar: Locator) => expandButton(bar).evaluate((el) => el.ownerDocument.activeElement === el);

    test("ic2-bar-1. Expand and Collapse show their words beside the chevron where the strip has room, at 390 x 844 at 85%, its name whole, its status line keeping AC and HP and focus kept on Expand, and the chevron alone at 390 x 844 at 130% to 100% and 320 x 568, their words their name (docs/design-v1-icons-2.md 8)", async () => {
      // The words need a strip of 431 px, which keeps the title as wide as at 390 x 844 with the chevron alone: 443 at 390 x 844 at 85%, and 374 at 100%.
      const views = [
        { view: { width: 320, height: 568, scale: 1.3 }, words: false },
        { view: { width: 390, height: 844, scale: 1.3 }, words: false },
        { view: { width: 390, height: 844, scale: 1.15 }, words: false },
        { view: { width: 390, height: 844, scale: 1 }, words: false },
        { view: { width: 390, height: 844, scale: 0.85 }, words: true },
        { view: { width: 320, height: 568, scale: 1 }, words: false },
      ];
      // A longer name and a longer status line than Thorn's, by Goblin 1 named as the bar design's dragon.
      const dragon = { ...run.goblin1, name: "Adult Red Dragon" };
      await ops.send({ t: "token.update", tokenId: dragon.id, patch: { name: dragon.name } });
      await waitFor("Goblin 1 named Adult Red Dragon", () => dmSocket.state?.tokens[dragon.id]?.name === dragon.name);
      try {
        for (const { view, words } of views) {
          const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
          await setUp(dm, view);
          for (const t of [run.thorn, dragon]) {
            const at = `${label}, ${t.name}`;
            const bar = await openBar(dm, t);
            await barState(bar, "rest");
            const expand = await sizeControl(bar);
            if (words) {
              assert.deepEqual({ words: expand.words, chevron: expand.chevron }, { words: "Expand", chevron: true }, `${at}: Expand`);
              const header = await titleAndLine(bar);
              assert.equal(header.cut, false, `${at}: the name is cut beside Expand's words`);
              assert.match(header.line, /^AC \d+ · HP \d+\/\d+/, `${at}: the status line beside Expand's words`);
            } else assert.deepEqual(expand, { words: "", chevron: true, width: 44 }, `${at}: Expand`);
            assert.deepEqual(await alignmentOf(dm, bar, `the strip at ${at}`), []);
            await shots.take(dm, `ic2-bar-1-${view.width}-${Math.round(view.scale * 100)}-${t.name.replaceAll(" ", "-").toLowerCase()}`);
            await expandButton(bar).tap();
            await barState(bar, "expanded");
            const collapse = await sizeControl(bar);
            if (words) assert.deepEqual({ words: collapse.words, chevron: collapse.chevron }, { words: "Collapse", chevron: true }, `${at}: Collapse`);
            else assert.deepEqual(collapse, { words: "", chevron: true, width: 44 }, `${at}: Collapse`);
            assert.deepEqual(await alignmentOf(dm, bar.locator("[data-sticky-header]"), `the expanded bar's header at ${at}`), []);
            await collapseButton(bar).click();
            await barState(bar, "rest");
            await until(`${at}: focus on Expand after Collapse`, () => focusOnExpand(bar), (on) => on);
            if (words) {
              // Multi-select from the expanded bar rests it and hands focus to Expand, which its words leave with no aria-label (review BB-OPUS-11).
              await expandButton(bar).click();
              await barState(bar, "expanded");
              await bar.getByRole("button", { name: "Multi-select", exact: true }).click();
              await barState(bar, "rest");
              await until(`${at}: focus on Expand after Multi-select`, () => focusOnExpand(bar), (on) => on);
              await press(bar, "Multi-select");
              await waitFor("Multi-select off", async () => ((await dm.getByRole("toolbar", { name: "Select options" }).count()) === 0 ? true : null), 3_000);
            }
            await closeBars(dm);
          }
        }
      } finally {
        await ops.send({ t: "token.update", tokenId: dragon.id, patch: { name: run.goblin1.name } });
        await waitFor("Goblin 1 named again", () => dmSocket.state?.tokens[dragon.id]?.name === run.goblin1.name);
        await setUp(dm, PHONES[0]);
      }
    });

    test("ic2-bar-3. beside a name its words would cut, Expand keeps the chevron alone and the name stays whole, and focus stays on Expand as its words come and go with the strip's width (D-261024-46)", async () => {
      const boss = { ...run.goblin1, name: "Goblin Boss of the Sunless Citadel" };
      await ops.send({ t: "token.update", tokenId: boss.id, patch: { name: boss.name } });
      await waitFor("Goblin 1 named as a boss", () => dmSocket.state?.tokens[boss.id]?.name === boss.name);
      try {
        // At 390 x 844 at 85% the strip has room for the words: Thorn's name fits beside them, the boss's would not.
        await setUp(dm, { width: 390, height: 844, scale: 0.85 });
        let bar = await openBar(dm, boss);
        await barState(bar, "rest");
        assert.deepEqual(await sizeControl(bar), { words: "", chevron: true, width: 44 }, "Expand beside the boss's name");
        assert.equal((await titleAndLine(bar)).cut, false, "the boss's name is cut");
        assert.equal(await expandButton(bar).count(), 1, "Expand keeps its name");
        await shots.take(dm, "ic2-bar-3-boss-390-85");

        bar = await openBar(dm, run.thorn);
        await barState(bar, "rest");
        assert.equal((await sizeControl(bar)).words, "Expand", "Expand beside Thorn's name");
        // Focus on Expand as the strip narrows past 431 px and widens again: one button, so focus never drops.
        await expandButton(bar).focus();
        await until("focus on Expand", () => focusOnExpand(bar), (on) => on);
        await dm.setViewportSize({ width: 360, height: 844 });
        await until("the chevron alone at 360 x 844 at 85%", () => sizeControl(bar), (c) => c.words === "");
        assert.equal(await focusOnExpand(bar), true, "focus left Expand as its words went");
        await dm.setViewportSize({ width: 390, height: 844 });
        await until("the words back at 390 x 844 at 85%", () => sizeControl(bar), (c) => c.words === "Expand");
        assert.equal(await focusOnExpand(bar), true, "focus left Expand as its words came back");
        await shots.take(dm, "ic2-bar-3-focus-kept");
        await closeBars(dm);
      } finally {
        await ops.send({ t: "token.update", tokenId: boss.id, patch: { name: run.goblin1.name } });
        await waitFor("Goblin 1 named again", () => dmSocket.state?.tokens[boss.id]?.name === run.goblin1.name);
        await setUp(dm, PHONES[0]);
      }
    });

    test("s2-bar-1. by keyboard, Undo move in Pat's strip and Duplicate in the DM's bar each go with their press and hand focus to the bar's frame that stands then, as Revive does (LP21-BAR-1, D-261024-42)", async () => {
      const focusedOn = (page: Page) =>
        page.evaluate(() => {
          const a = (globalThis as unknown as { document: { activeElement: { tagName: string; getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
          if (!a || a.tagName === "BODY") return "the page";
          return `${a.tagName.toLowerCase()} ${a.getAttribute("aria-label") ?? (a.textContent ?? "").trim().slice(0, 60)}`;
        });
      const lands = async (page: Page, where: RegExp, label: string) => {
        try {
          await waitFor(label, async () => where.test(await focusedOn(page)), 3_000);
        } catch {
          assert.fail(`${label}: focus is on "${await focusedOn(page)}", not ${where}`);
        }
      };
      const { pagePoint, touchSwipe } = await harness();
      await setUp(pat, PHONES[0]);
      await openBar(pat, run.thorn);
      const before = patSocket.state!.tokens[run.thorn.id]!;
      const from = await pagePoint(pat, BOUNDS, { x: before.x + 0.5, y: before.y + 0.5 });
      const to = await pagePoint(pat, BOUNDS, { x: before.x + 1.5, y: before.y + 0.5 });
      await touchSwipe(patCdp, from, to, { steps: 10, everyMs: 20 });
      await waitFor("Thorn one cell east", () => patSocket.state?.tokens[run.thorn.id]?.x === before.x + 1);
      const thorn = barOf(pat, "Thorn");
      const undo = thorn.locator("[data-rest-row]").getByRole("button", { name: "Undo move", exact: true });
      await undo.waitFor();
      await undo.focus();
      await pat.keyboard.press("Enter");
      await waitFor("Thorn back", () => patSocket.state?.tokens[run.thorn.id]?.x === before.x);
      await lands(pat, /^div Thorn actions$/, "Undo move handed focus on");
      await shots.take(pat, "s2-bar-undo-focus");

      await setUp(dm, PHONES[0]);
      const goblin = await openBar(dm, run.goblin2);
      const known = new Set(Object.keys(dmSocket.state?.tokens ?? {}));
      const duplicate = await barControl(goblin, "Duplicate");
      await duplicate.focus();
      await dm.keyboard.press("Enter");
      const copy = await waitFor("the copy", () => Object.keys(dmSocket.state?.tokens ?? {}).find((id) => !known.has(id)) ?? null);
      try {
        const made = await waitFor("the copy's name", () => dmSocket.state?.tokens[copy]);
        const name = made.number === undefined ? made.name : `${made.name} ${made.number}`;
        await lands(dm, new RegExp(`^div ${name} actions$`), "Duplicate handed focus on to the copy's bar");
        await shots.take(dm, "s2-bar-duplicate-focus");
      } finally {
        await closeBars(dm);
        await ops.send({ t: "token.delete", tokenId: copy });
        await ops.send({ t: "token.update", tokenId: run.goblin2.id, patch: { number: null } });
      }
    });
  });
});
