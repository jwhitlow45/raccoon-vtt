// Thorn's page from its top: picture, level and quick numbers, then the Stat block group open with scores, skills and weapons.
export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll, charactersList } = await import(`./lib.ts?t=${Date.now()}`);
  await charactersList(c, dm);
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByText("Thorn", { exact: true }).first().click();
  await dm.waitForTimeout(700);
  const folds = panel.locator("button[aria-expanded]");
  const names: string[] = [];
  for (let i = 0; i < (await folds.count()); i++) {
    const f = folds.nth(i);
    const txt = ((await f.textContent()) ?? "").trim();
    names.push(`${txt}=${await f.getAttribute("aria-expanded")}`);
    if (/^Stat block/i.test(txt) && (await f.getAttribute("aria-expanded")) === "false") await f.click();
  }
  await dm.waitForTimeout(600);
  await panelScroll(dm, null);
  await dm.mouse.move(5, 790);
  // guidepass6: the "Saved. Undo in Setup history." toast from the stat block save must be gone, so the picture shows only the sheet.
  await dm.waitForTimeout(9000);
  await c.shot(dm, "final-pc-stats");
  const t = await panel.innerText();
  return names.join(" | ") + "\n" + t.slice(0, 1500);
};
