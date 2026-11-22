// The Spirit Guardians preset cast from Bree's token: a 15 ft emanation that moves with her, its reminders on.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Area");
  await dm.waitForTimeout(400);
  let spell = dm.getByLabel("Spell", { exact: true });
  if (!(await spell.count())) {
    await dm.getByRole("button", { name: /^Shape/ }).first().click();
    await dm.waitForTimeout(300);
    spell = dm.getByLabel("Spell", { exact: true });
  }
  await spell.fill("spirit guardians");
  await dm.waitForTimeout(400);
  await dm.keyboard.press("Enter");
  await dm.waitForTimeout(400);
  await c.harness.tapCell(dm, b, { x: 12, y: 7 });
  await dm.waitForTimeout(600);
  const reading = (await dm.locator("body").innerText()).slice(0, 300);
  await dm.getByRole("button", { name: "Place", exact: true }).click();
  await dm.waitForTimeout(800);
  await c.harness.pickTool(dm, "Select");
  return reading;
};
