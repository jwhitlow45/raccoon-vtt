// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
// The image picker's Starter tab from the Goblin Warrior's page: a search for goblins, one tapped to show its credit. Nothing is used, so the monsters keep their default icons.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Change image" }).click();
  const dlg = dm.getByRole("dialog", { name: "Choose an image" });
  await dlg.waitFor();
  await dlg.getByRole("tab", { name: "Starter" }).click();
  const search = dlg.getByRole("searchbox", { name: "Search the starter packs" });
  await search.waitFor();
  await search.fill("goblin");
  await dm.waitForTimeout(800);
  const tiles = dlg.getByRole("button", { name: /goblin/i });
  const names = await tiles.evaluateAll((els: HTMLElement[]) => els.slice(0, 20).map((e) => e.getAttribute("aria-label") || e.textContent?.trim() || ""));
  await tiles.first().click();
  await dm.waitForTimeout(1200);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-starter-token");
  const t = await dlg.innerText();
  return names.join(" | ") + "\n----\n" + t.slice(0, 1200);
};
