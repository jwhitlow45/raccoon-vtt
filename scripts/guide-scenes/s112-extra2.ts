export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  const out: Record<string, string> = {};
  await dm.getByRole("button", { name: "Back to Menu" }).click().catch(() => {});
  // A pin in the hidden room.
  await c.harness.pickTool(dm, "Pin");
  await dm.waitForTimeout(400);
  out.pinRow = (await dm.locator("body").innerText()).slice(0, 200);
  await c.harness.tapCell(dm, b, { x: 26, y: 9 });
  await dm.waitForTimeout(800);
  const pane = dm.getByRole("dialog", { name: "Edit pin" });
  if (await pane.count()) {
    await pane.getByLabel("Pin label").fill("The Ash Rider's journal");
    await dm.waitForTimeout(300);
    out.pane = await pane.innerText();
  }
  await dm.mouse.move(5, 790);
  // guidepass6: wait out the "Saved. Undo in Setup history." toast, so the picture shows only the pin pane.
  await dm.waitForTimeout(9000);
  await c.shot(dm, "final-pin");
  const done = pane.getByRole("button", { name: "Done" });
  if (await done.count()) await done.click();
  await dm.waitForTimeout(500);
  await c.harness.pickTool(dm, "Select");
  // Characters panel: Thorn's card and stat block.
  await (await import(`./lib.ts?t=${Date.now()}`)).charactersList(c, dm);
  await dm.waitForTimeout(500);
  const panel = dm.locator('[role="tabpanel"]').first();
  out.chars = (await panel.innerText()).slice(0, 1500);
  await panelScroll(dm, null);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-characters");
  return out;
};
