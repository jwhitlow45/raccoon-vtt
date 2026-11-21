export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Exit" }).click();
  await dm.waitForTimeout(1000);
  await dm.keyboard.press("/");
  await dm.waitForTimeout(800);
  const panel = dm.locator('[role="tabpanel"]').first();
  const all = await panel.innerText();
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-outliner-crypt");
  // Collapse Creatures to show the map, doors and their marks.
  const fold = panel.getByRole("button", { name: /^Creatures and objects/ });
  if (await fold.count()) await fold.first().click();
  await dm.waitForTimeout(400);
  await c.shot(dm, "final-outliner");
  return all.slice(0, 2500);
};
