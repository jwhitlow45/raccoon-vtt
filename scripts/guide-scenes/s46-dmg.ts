export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  // The save rolls its damage as it opens now, so the old Edit and Roll presses are only for a panel that has not.
  await panel.getByRole("button", { name: "Edit", exact: true }).click({ timeout: 1500 }).catch(() => {});
  await dm.waitForTimeout(500);
  const t1 = await panel.innerText();
  await panel.getByRole("button", { name: "Roll", exact: true }).first().click({ timeout: 1500 }).catch(() => {});
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-gs-dmg");
  return t1.slice(0, 800) + "\n-----\n" + (await panel.innerText()).slice(0, 2000);
};
