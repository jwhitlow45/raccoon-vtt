export default async (c: any) => {
  const dm = c.state.dm;
  for (let i = 0; i < 3; i++) await dm.getByRole("button", { name: "How many plus 1" }).click();
  await dm.getByLabel("Hidden from players").check();
  await dm.waitForTimeout(300);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-monster-page");
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  return t.slice(0, 400);
};
