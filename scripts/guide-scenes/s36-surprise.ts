// @ts-nocheck
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await c.harness.tapCell(dm, b, { x: 5, y: 10 });
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Multi-select", exact: true }).first().click();
  await dm.waitForTimeout(300);
  await c.harness.tapCell(dm, b, { x: 4, y: 11 });
  await c.harness.tapCell(dm, b, { x: 6, y: 11 });
  await c.harness.tapCell(dm, b, { x: 3, y: 10 });
  await dm.waitForTimeout(600);
  await c.shot(dm, "look-group");
  const bar = await dm.locator("body").innerText();
  // The three this device used last, newest first, which the grid shows first as Recent. A few earlier fights would have set them.
  await dm.evaluate(() => localStorage.setItem("rvtt.recentConditions", JSON.stringify(["surprised", "prone", "concentrating"])));
  await dm.getByRole("button", { name: "Conditions", exact: true }).first().click();
  await dm.waitForTimeout(500);
  // Off the tokens, so no name label covers Bree.
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "look-group-conditions");
  await dm.getByRole("button", { name: /^Surprised/ }).first().click();
  await dm.waitForTimeout(500);
  return bar.slice(0, 1200);
};
