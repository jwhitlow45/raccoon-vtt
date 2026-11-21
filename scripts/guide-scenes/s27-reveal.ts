export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: /^Reveal to players/ }).click();
  await dm.waitForTimeout(800);
  await c.harness.pickTool(dm, "Select");
  await c.harness.openSideTab(dm, "Monsters");
  await dm.getByLabel("Search monsters").fill("goblin");
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-monsters-search");
  await dm.getByText("Goblin Warrior", { exact: true }).first().click();
  await dm.waitForTimeout(800);
  await c.shot(dm, "look-monster-page");
  const t = await dm.locator('[role="tabpanel"]').first().innerText().catch(() => "");
  return t.slice(0, 1500);
};
