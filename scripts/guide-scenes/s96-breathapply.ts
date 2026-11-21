export default async (c: any) => {
  const dm = c.state.dm;
  const pat = c.state.pat;
  await c.shot(pat, "look-pat-breath");
  const patText = (await pat.locator("body").innerText()).slice(0, 400);
  const panel = dm.locator('[role="tabpanel"]').first();
  // The DM rolls for the two players the saves asked. The damage rolled with the saves, so Edit and Roll may not be there.
  await panel.getByRole("button", { name: /^Roll \+7/ }).click({ timeout: 3000 }).catch(() => {});
  await dm.waitForTimeout(1000);
  await panel.getByRole("button", { name: /^Roll \+0/ }).click({ timeout: 3000 }).catch(() => {});
  await dm.waitForTimeout(1000);
  await panel.getByRole("button", { name: "Edit", exact: true }).click({ timeout: 1500 }).catch(() => {});
  await dm.waitForTimeout(400);
  await panel.getByRole("button", { name: "Roll", exact: true }).first().click({ timeout: 1500 }).catch(() => {});
  await dm.waitForTimeout(1500);
  const t = await panel.innerText();
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-breath-ready");
  const apply = dm.getByRole("button", { name: /^Apply: / });
  const label = await apply.innerText();
  await apply.click();
  await dm.waitForTimeout(1500);
  return patText + "\n----\n" + t.slice(0, 1500) + "\nAPPLY " + label;
};
