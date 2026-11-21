export default async (c: any) => {
  const dm = c.state.dm;
  const btn = dm.getByRole("button", { name: "Export as image" });
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await dm.waitForTimeout(800);
  await c.shot(dm, "look-export");
  const dlg = dm.getByRole("dialog").last();
  return await dlg.innerText().catch(() => dm.locator("body").innerText());
};
