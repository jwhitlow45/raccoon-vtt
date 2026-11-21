// guidepass6: the held look. Two goblin warriors on the forest road selected, a group save set up from the Dice
// panel with 2d6 fire damage, the damage Roll's one-roll menu open, then the DM's connection dropped: the page and the
// menu's choices turn gray and wait. The connection comes back after the picture.
export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState, shot2x, moveBarLeft } = await import(`./lib.ts?t=${Date.now()}`);
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  const st = await roomState(c, c.state.forest);
  const gobs = (Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.forest && /^Goblin Warrior/.test(t.name)) as any[]).sort((a, z) => a.name.localeCompare(z.name));
  const [g1, g2] = gobs;
  const p1 = await c.harness.pagePoint(dm, b, { x: g1.x + 0.5, y: g1.y + 0.5 });
  const p2 = await c.harness.pagePoint(dm, b, { x: g2.x + 0.5, y: g2.y + 0.5 });
  await dm.mouse.click(p1.x, p1.y);
  await dm.waitForTimeout(500);
  await dm.keyboard.down("Shift");
  await dm.mouse.click(p2.x, p2.y);
  await dm.keyboard.up("Shift");
  await dm.waitForTimeout(800);
  await moveBarLeft(dm);
  await c.harness.openSideTab(dm, "Dice");
  await dm.waitForTimeout(800);
  const panel = dm.getByRole("tabpanel", { name: "Dice" });
  // A page a rerun left open is discarded first, asked once more where it asks.
  const left = panel.getByRole("button", { name: "Discard", exact: true });
  if (await left.count()) {
    await left.first().click();
    await dm.waitForTimeout(500);
    if (await left.count()) await left.first().click();
    await dm.waitForTimeout(600);
  }
  const open = panel.locator("[data-open-group-save]").getByRole("button", { name: "Open", exact: true });
  if (await open.count()) {
    await open.click();
    await dm.waitForTimeout(500);
    const discard = panel.getByRole("button", { name: "Discard", exact: true });
    await discard.click();
    await dm.waitForTimeout(400);
    if (await discard.count()) await discard.first().click();
    await dm.waitForTimeout(600);
  }
  await panel.getByRole("button", { name: /^Set up a group save/ }).first().click();
  await dm.waitForTimeout(1200);
  const outcome = panel.getByRole("group", { name: "Outcome" });
  if ((await outcome.count()) === 0) await panel.getByRole("button", { name: "Edit", exact: true }).first().click();
  await panel.getByLabel("Damage", { exact: true }).fill("2d6 fire");
  await dm.waitForTimeout(400);
  const roll = outcome.getByRole("button", { name: /^Roll( again)?$/ }).first();
  await roll.scrollIntoViewIfNeeded();
  await roll.focus();
  await dm.keyboard.press("ContextMenu");
  await dm.getByRole("menu", { name: /^Roll options for/ }).waitFor();
  await dm.waitForTimeout(500);
  await c.shot(dm, "gp6-heldsave-online");
  await c.state.dmContext.setOffline(true);
  // The page holds itself once the app notices the connection is gone, which can take a while.
  for (let i = 0; i < 60 && !(await roll.isDisabled()); i++) await dm.waitForTimeout(500);
  await dm.waitForTimeout(800);
  await c.shot(dm, "gp6-heldsave-full");
  await shot2x(c, dm, "gp6-heldsave", { x: 640, y: 170 });
  const text = (await panel.innerText()).slice(0, 1200);
  const menu = await dm.getByRole("menu", { name: /^Roll options for/ }).getByRole("menuitem").evaluateAll((els: any[]) => els.map((el) => [el.innerText.trim(), el.getAttribute("aria-disabled")]));
  await c.state.dmContext.setOffline(false);
  await dm.waitForTimeout(4000);
  await dm.keyboard.press("Escape");
  return { goblins: [g1.name, g2.name], menu, text };
};
