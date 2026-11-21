// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.shot(dm, "look-state");
  const buttons = await dm.getByRole("button").evaluateAll((els: HTMLElement[]) => els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()).filter(Boolean));
  return buttons.join(" | ");
};
