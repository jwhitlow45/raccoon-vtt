import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { barControl, openSideTab, waitFor } from "./harness.ts";
import { actor, atLp22Sizes, bar, cell, DESK, dm, dmCdp, dmSocket, focusedText, groupIn, measureIn, openGroup, ops, panelFile, panelOf, player, playerSocket, run, setUp, shots, TABLET, tapToken, unfilledLines } from "./tokenpanelRoom.ts";

/** FU39-C: a separate room for focus and group lines (CISPEED-F6, E2E-SPLIT). */
panelFile("focus and group lines", () => {
  test("fu31-l. by keyboard on a desk, the DM's Delete this token hands focus to the empty panel's line (LP22-SECT-1)", async () => {
    const doomed = { id: randomUUID(), at: cell(6, 4) };
    await setUp(dm, dmCdp, DESK, null);
    await ops.send({ t: "token.create", token: { id: doomed.id, sceneId: run.sceneId, size: "medium", visibility: "all", x: doomed.at.x, y: doomed.at.y, disposition: "hostile", kind: "monster", name: "Doomed Wolf", actor: { inline: actor({ ac: 13, srdId: "wolf", hp: { cur: 11, max: 11, temp: 0 } }) } } });
    await waitFor("the doomed wolf", () => dmSocket.state?.tokens[doomed.id]);
    try {
      const panel = await panelOf(dm, doomed.at, "Doomed Wolf");
      await openGroup(panel, "Token settings");
      // Armed by the first press, deleted by the second.
      await panel.getByRole("button", { name: "Delete this token" }).focus();
      await dm.keyboard.press("Enter");
      await dm.keyboard.press("Enter");
      await waitFor("the wolf deleted", () => (dmSocket.state?.tokens[doomed.id] ? null : true));
      await panel.getByText("Tap a token to see it here.").waitFor();
      await waitFor("focus on the empty line", async () => ((await focusedText(dm)).includes("Tap a token to see it here.") ? true : null), 5_000).catch(async () => assert.fail(`after Delete focus is on ${await focusedText(dm)}`));
    } finally {
      if (dmSocket.state?.tokens[doomed.id]) await ops.send({ t: "token.delete", tokenId: doomed.id });
    }
  });

  test("fu31-d. by keyboard on a desk, Back to Medium in Stats hands focus to the Size field that stays (LP22-SECT-3)", async () => {
    const wolf = { id: randomUUID(), at: cell(6, 4) };
    await setUp(dm, dmCdp, DESK, null);
    // Small here, and Medium by its block.
    await ops.send({ t: "token.create", token: { id: wolf.id, sceneId: run.sceneId, size: "small", visibility: "all", x: wolf.at.x, y: wolf.at.y, disposition: "hostile", kind: "monster", name: "Small Wolf", actor: { inline: actor({ ac: 13, srdId: "wolf", hp: { cur: 11, max: 11, temp: 0 } }) } } });
    await waitFor("the small wolf", () => dmSocket.state?.tokens[wolf.id]);
    try {
      const panel = await panelOf(dm, wolf.at, "Small Wolf");
      await openGroup(panel, "Stats");
      await groupIn(panel, "Stats").getByRole("button", { name: "Back to Medium", exact: true }).focus();
      await dm.keyboard.press("Enter");
      await waitFor("the wolf back to Medium", () => (dmSocket.state?.tokens[wolf.id]?.size === "medium" ? true : null));
      await waitFor("focus on the Size field", async () => ((await focusedText(dm)).startsWith('select "Size"') ? true : null), 5_000).catch(async () => assert.fail(`after Back to Medium focus is on ${await focusedText(dm)}`));
    } finally {
      await ops.send({ t: "token.delete", tokenId: wolf.id });
    }
  });

  test("fu31-e. the goblin's Image group: its picture centered on the pair beside it, in line within 1 px at live play 22's sizes and the alignment sweep's 820 x 1180 tablet (LP22-ALIGN-1, FU31 review F8)", async () => {
    const off = await atLp22Sizes(
      async (at) => {
        const goblin = await panelOf(dm, run.goblin.at, "Goblin 4");
        await openGroup(goblin, "Image");
        await shots.take(dm, `fu31-image-${at.replace(/ /g, "")}`);
        return measureIn(groupIn(goblin, "Image"), `the goblin's Image at ${at}`);
      },
      false,
      [TABLET],
    );
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("fu31-f. each member's dot on its name, in line within 1 px at live play 22's sizes: the goblin's Owners, and on a desk Thorn's page's Played by (LP22-ALIGN-2)", async () => {
    const off = await atLp22Sizes(async (at) => {
      const goblin = await panelOf(dm, run.goblin.at, "Goblin 4");
      await openGroup(goblin, "Owners");
      const lines = await measureIn(groupIn(goblin, "Owners"), `the goblin's Owners at ${at}`);
      if (!at.startsWith("1440") && !at.startsWith("1280")) return lines;
      await openSideTab(dm, "Characters");
      const page = dm.getByRole("tabpanel", { name: "Characters" });
      await page.locator(`[data-opener="character:${run.thorn.characterId}"]`).click();
      await openGroup(page, "Played by");
      await groupIn(page, "Played by").getByText("Pat", { exact: true }).waitFor();
      return [...lines, ...(await measureIn(groupIn(page, "Played by"), `Thorn's Played by at ${at}`))];
    });
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("fu31-p. each member's dot on its name, in line within 1 px at 1440 x 900 and 1280 x 800 at 130%: a handout's chosen players, and the Owners of two tokens' More (FU31 review F3, LP22-ALIGN-2)", async () => {
    const off: string[] = [];
    try {
      for (const size of [{ width: 1440, height: 900 }, DESK]) {
        const at = `${size.width} x ${size.height} at 130%`;
        await setUp(dm, dmCdp, { ...size, scale: 1.3 }, null);
        await tapToken(dm, run.goblin.at);
        await bar(dm, "Goblin 4").waitFor();
        await dm.keyboard.down("Shift");
        await tapToken(dm, run.bog.at);
        await dm.keyboard.up("Shift");
        await (await barControl(dm.getByRole("dialog", { name: "2 selected tokens" }), "More")).click();
        const more = dm.getByRole("dialog", { name: "2 tokens" });
        const owners = more.locator("section").filter({ has: dm.getByRole("heading", { name: "Owners", exact: true }) });
        await owners.getByText("Pat", { exact: true }).waitFor();
        off.push(...(await measureIn(owners, `two tokens' Owners at ${at}`)));
        await owners.getByText("Pat", { exact: true }).scrollIntoViewIfNeeded();
        await shots.take(dm, `fu31-group-owners-${size.width}`);
        await dm.keyboard.press("Escape");
        await more.waitFor({ state: "detached" });

        await openSideTab(dm, "DM");
        const dmPanel = dm.getByRole("tabpanel", { name: "DM" });
        await dmPanel.getByRole("button", { name: "Show a handout" }).click();
        await dmPanel.getByRole("radio", { name: "Chosen players" }).check();
        const players = dmPanel.getByRole("group", { name: "Players to show it to" });
        await players.getByText("Pat", { exact: true }).waitFor();
        off.push(...(await measureIn(players, `a handout's players at ${at}`)));
        await shots.take(dm, `fu31-handout-players-${size.width}`);
        // Only closes the form: Everyone again, so the draft left is as it was.
        await dmPanel.getByRole("radio", { name: "Everyone" }).check();
        await dmPanel.getByRole("button", { name: "Cancel", exact: true }).click();
      }
    } finally {
      await setUp(dm, dmCdp, DESK, null);
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("fu31-g. a Stat block's Copy, Change and Detach leave no button alone under the others and all fill the lines they take: Pat's wolf companion and the DM's goblin, in line within 1 px at live play 22's sizes (LP22-ALIGN-3, FU31 review F9)", async () => {
    const wolf = { id: randomUUID(), at: cell(6, 4) };
    await ops.send({ t: "token.create", token: { id: wolf.id, sceneId: run.sceneId, size: "medium", visibility: "all", x: wolf.at.x, y: wolf.at.y, disposition: "ally", kind: "monster", name: "Wolf", companion: { of: run.thorn.characterId, turn: "shared" }, actor: { inline: actor({ ac: 13, srdId: "wolf", hp: { cur: 11, max: 11, temp: 0 } }) } } });
    await waitFor("Pat's wolf", () => playerSocket.state?.tokens[wolf.id]);
    try {
      const off = await atLp22Sizes(async (at) => {
        const goblin = await panelOf(dm, run.goblin.at, "Goblin 4");
        await openGroup(goblin, "Stat block");
        const lines = await measureIn(groupIn(goblin, "Stat block"), `the goblin's Stat block at ${at}`);
        lines.push(...(await unfilledLines(groupIn(goblin, "Stat block").getByRole("button", { name: /^Copy to/ }), `the goblin's Stat block at ${at}`)));
        const pet = await panelOf(player, wolf.at, "Wolf");
        await openGroup(pet, "Stat block");
        await groupIn(pet, "Stat block").getByRole("button", { name: "Detach", exact: true }).waitFor();
        await shots.take(player, `fu31-wolf-block-${at.replace(/ /g, "")}`);
        lines.push(...(await unfilledLines(groupIn(pet, "Stat block").getByRole("button", { name: /^Copy to/ }), `Pat's wolf's Stat block at ${at}`)));
        return [...lines, ...(await measureIn(groupIn(pet, "Stat block"), `Pat's wolf's Stat block at ${at}`))];
      }, true);
      assert.deepEqual(off, [], "out of line by more than 1 px");
    } finally {
      await ops.send({ t: "token.delete", tokenId: wolf.id });
    }
  });
});
