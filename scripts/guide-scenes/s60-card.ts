export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: /^Roll \+7/ }).first().click();
  await dm.waitForTimeout(1200);
  await dm.getByRole("button", { name: /^Roll \+0/ }).first().click();
  await dm.waitForTimeout(1200);
  // The boss from the Dice steps is still selected, with its action bar open under the card.
  await c.harness.tapCell(dm, { w: 30, h: 20 }, { x: 0, y: 0 });
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-dm-card");
  const t = await dm.locator("body").innerText();
  return t.slice(0, 700);
};
