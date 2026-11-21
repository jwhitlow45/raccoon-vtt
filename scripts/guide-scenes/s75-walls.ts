export default async (c: any) => {
  const dm = c.state.dm;
  // guidepass6: picking the tool that is already in use would hide its options.
  if (!(await dm.getByRole("button", { name: /^Builder mode/ }).count())) await c.harness.pickTool(dm, "Map builder");
  await dm.waitForTimeout(500);
  // guidepass6: the menu may already be open, and a second click would close it.
  if (!(await dm.getByRole("radio", { name: "Walls and doors" }).count())) {
    await dm.getByRole("button", { name: /^Builder mode/ }).first().click();
    await dm.waitForTimeout(300);
  }
  await dm.getByRole("radio", { name: "Walls and doors" }).first().click({ force: true });
  await dm.waitForTimeout(400);
  const edge = dm.getByRole("button", { name: /^Edge/ });
  if (await edge.count()) {
    await edge.first().click();
    await dm.waitForTimeout(300);
    await dm.getByRole("button", { name: "Door", exact: true }).or(dm.getByRole("radio", { name: "Door", exact: true })).first().click();
    await dm.waitForTimeout(300);
  }
  const t = (await dm.locator("body").innerText()).slice(0, 300);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-crypt-walls");
  return t;
};
