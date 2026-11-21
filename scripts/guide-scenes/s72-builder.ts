// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.pickTool(dm, "Map builder");
  await dm.waitForTimeout(800);
  const row = await dm.locator("body").innerText();
  const btns = await dm.getByRole("button").evaluateAll((els: HTMLElement[]) => els.slice(0, 40).map((e) => `[${e.getAttribute("aria-label")}] ${e.textContent?.trim()}`));
  // Open the mode chip.
  const mode = dm.getByRole("button", { name: /^Builder mode/ });
  if (await mode.count()) {
    await mode.first().click();
    await dm.waitForTimeout(500);
  }
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-builder");
  return row.slice(0, 300) + "\n" + btns.join(" | ");
};
