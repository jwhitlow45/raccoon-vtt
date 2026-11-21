// guidepass6: the roll mode menu (hold or right-click a roll button) on the Dice panel, as dice-roll-menu.webp.
export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  const btn = panel.getByRole("button", { name: /^Scimitar|^Attack \+/ }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ button: "right" });
  await dm.waitForTimeout(800);
  const menu = dm.locator("[data-roll-mode-menu]").first();
  const text = await menu.innerText().catch(() => "no menu");
  await c.shot(dm, "gp5-rollmenu");
  await c.shot(dm, "gp5-rollmenu-panel", { clip: { x: 920, y: 56, width: 360, height: 700 } });
  return text;
};
