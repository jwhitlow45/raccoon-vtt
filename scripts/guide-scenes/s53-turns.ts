export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const next = async () => {
    await dm.getByRole("button", { name: "Next", exact: true }).first().click();
    await dm.waitForTimeout(800);
  };
  await next(); // Wolf 2
  // Wolf 2 bites Mara: 7 damage through her HP entry, and she is knocked prone.
  await c.harness.tapCell(dm, b, { x: 6, y: 11 });
  await dm.waitForTimeout(600);
  await dm.getByLabel("HP change").first().fill("-7");
  await dm.getByRole("button", { name: "Apply", exact: true }).first().click();
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Conditions", exact: true }).first().click();
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: /^Prone/ }).first().click();
  await dm.waitForTimeout(400);
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  await next(); // Mara
  await next(); // Goblin Boss
  await c.harness.tapCell(dm, b, { x: 11, y: 6 });
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-action-bar");
  const bar = await dm.locator("body").innerText();
  await c.harness.tapCell(dm, b, { x: 12, y: 4 });
  await dm.waitForTimeout(800);
  return bar.slice(0, 900);
};
