// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("button", { name: /^All/ }).first().click();
  await dm.waitForTimeout(300);
  const states = await panel.getByRole("button").evaluateAll((els: HTMLElement[]) => els.map((e) => `${e.textContent?.trim()}|${e.getAttribute("aria-expanded")}|${e.getAttribute("aria-pressed")}`));
  // Group headers carry aria-expanded.
  const headers = panel.locator('button[aria-expanded]');
  const n = await headers.count();
  for (let i = 0; i < n; i++) {
    const h = headers.nth(i);
    const txt = (await h.textContent()) ?? "";
    const open = (await h.getAttribute("aria-expanded")) === "true";
    const want = !txt.startsWith("Map");
    if (open !== want) await h.click();
  }
  await dm.waitForTimeout(400);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-outliner");
  return states.slice(0, 12).join("\n") + "\n----\n" + (await panel.innerText()).slice(0, 900);
};
