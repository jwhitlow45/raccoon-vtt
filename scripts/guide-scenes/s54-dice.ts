export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Roll", exact: true }).first().click();
  await dm.waitForTimeout(1500);
  const panel = dm.locator('[role="tabpanel"]').first();
  const t = await panel.innerText();
  // Roll the scimitar attack and its damage.
  const atk = panel.getByRole("button", { name: /^Attack \+/ }).first();
  if (await atk.count()) {
    await atk.click();
    await dm.waitForTimeout(1200);
  }
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-dice");
  return t.slice(0, 2500);
};
