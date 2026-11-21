// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  // End the crypt fight first.
  await c.harness.openSideTab(dm, "Initiative");
  const panel = dm.locator('[role="tabpanel"]').first();
  const end = panel.getByRole("button", { name: "End the fight" });
  if (await end.count()) {
    await end.click();
    await panel.getByRole("button", { name: /Tap again/ }).first().click();
  }
  await dm.evaluate(() => window.scrollTo(0, 0));
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Forest road", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  // Select the party's four tokens and delete them.
  const pcs = c.state.forestPcs;
  await c.harness.tapCell(dm, b, { x: 5, y: 10 });
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "Multi-select", exact: true }).first().click();
  for (const p of [{ x: 4, y: 11 }, { x: 6, y: 11 }, { x: 3, y: 10 }]) await c.harness.tapCell(dm, b, p);
  await dm.waitForTimeout(500);
  const sel = (await dm.locator("body").innerText()).match(/\d+ selected/)?.[0];
  await dm.getByRole("button", { name: "Delete", exact: true }).first().click();
  await dm.waitForTimeout(300);
  const armed = (await dm.locator("body").innerText()).match(/Delete \d+ tokens\?/)?.[0] ?? "no armed text";
  await dm.getByRole("button", { name: /Delete \d+ tokens\?|Tap again/ }).first().click();
  await dm.waitForTimeout(800);
  await dm.getByRole("button", { name: "Done", exact: true }).click().catch(() => {});
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("/");
  await dm.waitForTimeout(600);
  await dm.getByPlaceholder("Search the scene").fill("companion");
  await dm.waitForTimeout(600);
  const out = await dm.locator('[role="tabpanel"]').first().innerText();
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-travel-outliner");
  return `${sel} | ${armed}\n${out}`;
};
