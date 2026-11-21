export default async (c: any) => {
  const dm = c.state.dm;
  const apply = dm.getByRole("button", { name: /^Apply: / });
  // Without a DC the rows wait to be marked, so mark them all failed.
  if (!(await apply.count())) await dm.getByRole("button", { name: "All fail", exact: true }).click();
  await apply.click();
  await dm.waitForTimeout(1500);
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  const body = await dm.locator("body").innerText();
  await c.shot(dm, "look-applied");
  return t.slice(0, 300) + "\n---\n" + (body.match(/Fireball: [^\n]*/)?.[0] ?? "no toast");
};
