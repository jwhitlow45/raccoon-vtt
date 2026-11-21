// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  // Remove the Fireball area.
  await c.harness.openSideTab(dm, "Areas");
  await dm.waitForTimeout(500);
  const panel = dm.locator('[role="tabpanel"]').first();
  const areasText = await panel.innerText();
  const del = panel.getByRole("button", { name: /^Delete/ }).first();
  if (await del.count()) {
    await del.click();
    await dm.waitForTimeout(300);
    const again = panel.getByRole("button", { name: /Tap again|Delete/ }).first();
    if (await again.count()) await again.click().catch(() => {});
    await dm.waitForTimeout(500);
  }
  const after = await panel.innerText();
  await c.harness.openSideTab(dm, "Initiative");
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  const party = dm.getByRole("button", { name: /^Party/ }).first();
  if ((await party.getAttribute("aria-expanded")) === "false") await party.click();
  await dm.waitForTimeout(500);
  await dm.mouse.move(5, 790);
  // The tab picked by keyboard keeps a focus ring a mouse user would never see.
  await dm.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await c.shot(dm, "final-screen-computer");
  return areasText.slice(0, 600) + "\n----\n" + after.slice(0, 300);
};
