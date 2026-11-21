export default async (c: any) => {
  const dm = c.state.dm;
  await dm.keyboard.press("Escape");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Move players to Forest road", exact: true }).click();
  await dm.waitForTimeout(1500);
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  // A folder for the drafts.
  await dm.getByRole("button", { name: "More for Forest road (builder)" }).click();
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: /^Move to folder/ }).click();
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: /^New folder/ }).click();
  await dm.getByLabel("New folder name").fill("Drafts");
  await dm.getByRole("button", { name: "Move", exact: true }).click();
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-scenes-after");
  const pat = c.state.pat;
  await pat.waitForTimeout(1500);
  await c.shot(pat, "look-pat-forest");
  return t.slice(0, 600);
};
