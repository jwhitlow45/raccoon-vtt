// New picture uses.webp (guide pass 2): the adult red dragon's Uses in its Token panel, back in its lair for a second
// fight, on Mara's turn after it spent Fiery Rays and a Legendary Resistance, so the list shows Restore, an action that
// stays off until its next turn, and the DM's pips.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Dragon's lair", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await dm.getByRole("button", { name: "Fit the map to the screen" }).first().click();
  await dm.waitForTimeout(600);
  await c.harness.openSideTab(dm, "Initiative");
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("button", { name: /^Everyone here/ }).first().click();
  await dm.waitForTimeout(1200);
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.lair);
  const vals: Record<string, number> = { "Adult Red Dragon": 22, Mara: 19, Thorn: 14, Ivo: 12, Bree: 9 };
  for (const e of st.encounter.entries) {
    const tok = st.tokens[e.tokenId];
    if (tok && vals[tok.name] !== undefined) await c.state.ops.send({ t: "encounter.setValue", entryId: e.id, value: vals[tok.name] });
  }
  await dm.waitForTimeout(500);
  await panel.getByRole("button", { name: "Start", exact: true }).click();
  await dm.waitForTimeout(1000);
  await panel.getByRole("button", { name: "Next", exact: true }).click();
  await dm.waitForTimeout(1000);
  await panel.getByRole("button", { name: "Adult Red Dragon options" }).click();
  await dm.waitForTimeout(600);
  await panel.getByRole("button", { name: /^Use Fiery Rays/ }).first().click();
  await dm.waitForTimeout(700);
  await panel.getByRole("button", { name: /^Use Legendary Resistance/ }).first().click();
  await dm.waitForTimeout(700);
  await panel.getByRole("button", { name: "Adult Red Dragon options" }).click();
  await panel.getByRole("button", { name: /^Adult Red Dragon\. Show it/ }).click();
  await dm.waitForTimeout(800);
  await c.harness.openSideTab(dm, "Token");
  await dm.waitForTimeout(1200);
  const { rowsIntoView } = await import(`./lib.ts?t=${Date.now()}`);
  const moved = await rowsIntoView(dm, "^Uses$", 8);
  await dm.waitForTimeout(400);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-uses");
  const t = await panel.innerText();
  const i = t.indexOf("USES");
  return moved + "\n" + t.slice(i, i + 700);
};
