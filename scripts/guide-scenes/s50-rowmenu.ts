// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  const more = panel.getByRole("button", { name: /Goblin Boss/ }).filter({ hasText: "" });
  const btns = await panel.getByRole("button").evaluateAll((els: HTMLElement[]) => els.map((e) => e.getAttribute("aria-label") || e.textContent?.trim()).filter((s) => s && /Goblin Boss/.test(s)));
  // Open the Goblin Boss row's options.
  const opt = panel.getByRole("button", { name: /^(More for|Options for) Goblin Boss/ });
  if (await opt.count()) await opt.first().click();
  await dm.waitForTimeout(600);
  await c.shot(dm, "look-row-menu");
  const dlg = dm.getByRole("dialog").last();
  const text = (await dlg.count()) ? await dlg.innerText() : "";
  return btns.join(" | ") + "\n----\n" + text.slice(0, 1500);
};
