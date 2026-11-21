export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Close" }).first().click().catch(() => {});
  const b = dm.getByRole("button", { name: "Map image", exact: true });
  await b.scrollIntoViewIfNeeded();
  await b.click();
  await dm.waitForTimeout(600);
  await c.shot(dm, "look-newmap");
  const panel = dm.locator('[role="tabpanel"]').first();
  return (await panel.innerText().catch(() => "")).slice(0, 2500);
};
