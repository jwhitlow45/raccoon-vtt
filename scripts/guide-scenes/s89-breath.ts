// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await c.harness.tapCell(dm, b, { x: 21, y: 12 });
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Roll", exact: true }).first().click();
  await dm.waitForTimeout(1500);
  await dm.evaluate(() => window.scrollTo(0, 0));
  const panel = dm.locator('[role="tabpanel"]').first();
  const t = await panel.innerText();
  const i = t.indexOf("Actions");
  return t.slice(i, i + 2200);
};
