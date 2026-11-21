// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  const end = panel.getByRole("button", { name: "End the fight" });
  await end.scrollIntoViewIfNeeded();
  await end.click();
  await dm.waitForTimeout(300);
  const armed = await panel.getByRole("button", { name: /Tap again/ }).allInnerTexts();
  await panel.getByRole("button", { name: /Tap again/ }).first().click();
  await dm.waitForTimeout(800);
  await dm.evaluate(() => window.scrollTo(0, 0));
  return armed.join("|") + "\n" + (await panel.innerText()).slice(0, 200);
};
