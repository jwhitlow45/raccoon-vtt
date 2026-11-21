export default async (c: any) => {
  const dm = c.state.dm;
  await dm.waitForTimeout(1500);
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  const n = await dm.locator('[role="tabpanel"]').count();
  await c.harness.openSideTab(dm, "Initiative");
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-heights-fireball");
  return JSON.stringify(t) + " panels=" + n;
};
