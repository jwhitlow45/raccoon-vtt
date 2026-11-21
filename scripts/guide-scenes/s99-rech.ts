// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Roll", exact: true }).first().click();
  await dm.waitForTimeout(1500);
  const body = await dm.locator("body").innerText();
  const card = body.match(/Rolled \d+: [^\n]*/)?.[0] ?? "no result";
  const done = dm.getByRole("button", { name: "Done", exact: true }).first();
  if (await done.count()) await done.click();
  const panel = dm.locator('[role="tabpanel"]').first();
  const end = panel.getByRole("button", { name: "End the fight" });
  await end.click();
  await panel.getByRole("button", { name: /Tap again/ }).first().click();
  await dm.waitForTimeout(600);
  await dm.evaluate(() => window.scrollTo(0, 0));
  return card;
};
