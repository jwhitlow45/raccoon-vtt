export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Dismiss" }).first().click().catch(() => {});
  await dm.getByRole("button", { name: "Start", exact: true }).first().click();
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-started");
  await c.shot(c.state.pat, "look-pat-started");
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  return t.slice(0, 500);
};
