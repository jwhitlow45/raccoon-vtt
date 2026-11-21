// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  await c.shot(dm, "look-dice-now");
  return await panel.getByRole("button").evaluateAll((els: HTMLElement[]) => els.slice(0, 40).map((e) => `[${e.getAttribute("aria-label")}] ${e.textContent?.trim()}`));
};
