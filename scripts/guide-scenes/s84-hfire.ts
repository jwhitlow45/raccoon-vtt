export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await dm.getByRole("button", { name: "Clear", exact: true }).click().catch(() => {});
  await c.harness.pickTool(dm, "Area");
  await dm.waitForTimeout(400);
  const spell = dm.getByLabel("Spell", { exact: true });
  if (await spell.count()) {
    await spell.fill("fireball");
    await dm.waitForTimeout(400);
    await dm.keyboard.press("Enter");
  } else {
    await dm.getByRole("button", { name: /^Shape/ }).first().click();
    await dm.waitForTimeout(300);
    await dm.getByLabel("Spell", { exact: true }).fill("fireball");
    await dm.waitForTimeout(400);
    await dm.keyboard.press("Enter");
  }
  await dm.waitForTimeout(400);
  await c.harness.tapCell(dm, b, { x: 11, y: 8 });
  await dm.waitForTimeout(800);
  const reading = (await dm.locator("body").innerText()).slice(0, 300);
  await c.harness.openSideTab(dm, "Token");
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-heights-fireball");
  return reading;
};
