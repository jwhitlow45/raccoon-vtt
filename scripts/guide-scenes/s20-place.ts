export default async (c: any) => {
  const dm = c.state.dm;
  // Fold the party bar so panels have room in the shots.
  const party = dm.getByRole("button", { name: /^Party/ }).first();
  if ((await party.getAttribute("aria-expanded")) === "true") await party.click();
  await dm.waitForTimeout(300);
  await dm.getByText("Placement", { exact: true }).scrollIntoViewIfNeeded();
  await dm.getByLabel("Hidden from players").check();
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-encounters");
  await dm.getByRole("button", { name: /^Place where I (tap|click)$/ }).click();
  await dm.waitForTimeout(800);
  await c.shot(dm, "look-place-strip");
  const strip = await dm.locator("body").innerText();
  await c.harness.tapCell(dm, { w: 30, h: 20 }, { x: 11, y: 5 });
  await dm.waitForTimeout(1500);
  await c.shot(dm, "look-placed");
  return strip.slice(0, 300);
};
