export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("button", { name: "Goblin Boss options" }).click();
  await dm.waitForTimeout(600);
  await c.shot(dm, "look-row-menu");
  const pop = dm.getByRole("dialog").last();
  const text = (await pop.count()) ? await pop.innerText() : (await panel.innerText()).slice(0, 2500);
  return text.slice(0, 2500);
};
