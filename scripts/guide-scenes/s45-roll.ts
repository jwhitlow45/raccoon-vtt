export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.pickTool(dm, "Select");
  await dm.getByRole("button", { name: /^Roll 4 saves/ }).click();
  await dm.waitForTimeout(2000);
  const panel = dm.locator('[role="tabpanel"]').first();
  const rollDmg = panel.getByRole("button", { name: "Roll", exact: true });
  if (await rollDmg.count()) await rollDmg.first().click();
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-gs-rolled");
  return (await panel.innerText()).slice(0, 2500);
};
