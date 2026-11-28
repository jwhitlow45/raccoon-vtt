export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "Areas");
  await dm.waitForTimeout(400);
  const panel = dm.locator('[role="tabpanel"]').first();
  const done = panel.getByRole("button", { name: "Done", exact: true });
  if (await done.count()) await done.click();
  await dm.waitForTimeout(500);
  const list = await panel.innerText();
  await c.shot(dm, "look-areas-panel");
  const del = panel.getByRole("button", { name: /Delete/ }).first();
  // guidepass6: s65 already removed the Fireball area, so there may be nothing left to delete.
  if (!(await del.count())) return list.slice(0, 600);
  await del.click();
  await dm.waitForTimeout(300);
  const t2 = await panel.innerText();
  const again = panel.getByRole("button", { name: /(?:Tap|Click) again|Delete/ }).first();
  if (await again.count()) await again.click();
  await dm.waitForTimeout(600);
  return list.slice(0, 600) + "\n---\n" + t2.slice(0, 300) + "\n---\n" + (await panel.innerText()).slice(0, 300);
};
