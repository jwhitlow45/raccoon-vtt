export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Forest road", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await c.harness.openSideTab(dm, "Encounters");
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "New encounter" }).click();
  await dm.getByLabel("Encounter name").fill("Road ambush");
  const add = async (q: string, name: string, n: number) => {
    const s = dm.getByLabel("Search monsters to add");
    await s.fill(q);
    await dm.waitForTimeout(600);
    for (let i = 0; i < n; i++) await dm.getByRole("button", { name: `Add one ${name}`, exact: true }).click();
  };
  await add("goblin", "Goblin Warrior", 4);
  await add("goblin boss", "Goblin Boss", 1);
  await add("wolf", "Wolf", 2);
  await dm.getByLabel("Search monsters to add").fill("");
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Save encounter" }).click();
  await dm.waitForTimeout(800);
  const text = await dm.locator('[role="tabpanel"]').first().innerText().catch(() => "");
  await c.shot(dm, "look-encounter");
  return text.slice(0, 2500);
};
