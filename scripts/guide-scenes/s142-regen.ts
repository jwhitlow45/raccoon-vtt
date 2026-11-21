// New picture regeneration.webp (guide pass 2): a troll joins the lair fight, Ivo's Fire Bolt burns it through the HP
// entry's Use chip, and on the troll's turn its Regeneration card, with the recorded Fire note, stands over its turn card.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const panel = dm.locator('[role="tabpanel"]').first();
  await dm.keyboard.press("Escape");
  await c.harness.openSideTab(dm, "Monsters");
  const back = dm.getByRole("button", { name: "Back to Monsters" });
  if (await back.count()) await back.first().click();
  await dm.getByLabel("Search monsters").fill("troll");
  await dm.waitForTimeout(600);
  await panel.getByText("Troll", { exact: true }).first().click();
  await dm.waitForTimeout(800);
  await panel.getByRole("button", { name: /^Place .*on the map/ }).click();
  await dm.waitForTimeout(400);
  await c.harness.tapCell(dm, b, { x: 15, y: 15 });
  await dm.waitForTimeout(1000);
  // The troll is selected after its placing: add it to the running fight.
  await c.harness.openSideTab(dm, "Initiative");
  await panel.getByRole("button", { name: /^Everyone here \(1\)/ }).first().click();
  await dm.waitForTimeout(1000);
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.lair);
  const troll = Object.values(st.tokens).find((t: any) => t.sceneId === c.state.lair && t.name.startsWith("Troll")) as any;
  c.state.troll = troll.id;
  const entry = st.encounter.entries.find((e: any) => e.tokenId === troll.id);
  await c.state.ops.send({ t: "encounter.setValue", entryId: entry.id, value: 16 });
  await dm.waitForTimeout(600);
  // Ivo's Fire Bolt, rolled by the DM from his roll options.
  await panel.getByRole("button", { name: /^Ivo\. Show it/ }).click();
  await dm.waitForTimeout(800);
  await c.harness.openSideTab(dm, "Dice");
  await dm.waitForTimeout(1000);
  let dmg = panel.getByRole("button", { name: /Fire Bolt.*damage|damage.*Fire Bolt/i }).first();
  if (!(await dmg.isVisible().catch(() => false))) {
    for (const g of ["Cantrips", "Spells"]) {
      const fold = panel.getByRole("button", { name: new RegExp(`^${g}`) }).first();
      if ((await fold.count()) && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
    }
    await dm.waitForTimeout(500);
    dmg = panel.getByRole("button", { name: /Fire Bolt.*damage|damage.*Fire Bolt/i }).first();
  }
  const dmgName = await dmg.getAttribute("aria-label").catch(() => null);
  await dmg.click();
  await dm.waitForTimeout(1500);
  // Onto the troll with the Use chip.
  await c.harness.openSideTab(dm, "Initiative");
  await panel.getByRole("button", { name: /^Troll\. Show it/ }).click();
  await dm.waitForTimeout(900);
  const chip = dm.getByRole("button", { name: /^Use \d+/ }).first();
  const chipName = (await chip.getAttribute("aria-label")) ?? (await chip.textContent());
  await chip.click();
  await dm.waitForTimeout(300);
  await dm.getByRole("button", { name: "Apply", exact: true }).first().click();
  await dm.waitForTimeout(900);
  await dm.getByRole("button", { name: "Close", exact: true }).first().click().catch(() => {});
  await dm.waitForTimeout(300);
  // Mara's turn ends: the troll's begins.
  await panel.getByRole("button", { name: "Next", exact: true }).click();
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-regeneration");
  const body = await dm.locator("body").innerText();
  return { dmgName, chipName, card: body.match(/Troll regenerates[^\n]*|Recorded[^\n]*/g) };
};
