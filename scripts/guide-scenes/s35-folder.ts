export default async (c: any) => {
  const dm = c.state.dm;
  const dlg = dm.getByRole("dialog").last();
  await dlg.getByText("New folder…").click();
  await dm.waitForTimeout(300);
  await dlg.getByLabel("New folder name").fill("Drafts");
  await dlg.getByRole("button", { name: "Move", exact: true }).click();
  await dm.waitForTimeout(1000);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-scenes-after");
  const pat = c.state.pat;
  await c.shot(pat, "look-pat-forest");
  return await dm.locator('[role="tabpanel"]').first().innerText().then((t: string) => t.slice(0, 500));
};
