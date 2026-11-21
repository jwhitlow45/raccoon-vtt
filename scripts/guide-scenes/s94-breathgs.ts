export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("button", { name: /^Group save, DC 21 Dex/i }).click();
  await dm.waitForTimeout(1200);
  const t0 = await panel.innerText();
  // Select the party: Thorn, then Multi-select and the rest.
  await dm.keyboard.press("Escape");
  await c.harness.tapCell(dm, b, { x: 10, y: 10 });
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Multi-select", exact: true }).first().click();
  for (const p of [{ x: 9, y: 12 }, { x: 11, y: 13 }, { x: 7, y: 11 }]) await c.harness.tapCell(dm, b, p);
  await dm.waitForTimeout(800);
  const t1 = await panel.innerText();
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-breath-gs");
  return t0.slice(0, 900) + "\n------\n" + t1.slice(0, 1500);
};
