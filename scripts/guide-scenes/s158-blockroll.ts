// guidepass6: rolling from a stat block. On the forest road, a goblin warrior's token panel, its stat block open, the
// Dexterity box's list open (the stat block rolls picture), then its Stealth rolled, with the result in the header line at
// the top of the panel (the roll header picture).
export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState, shot2x, moveBarLeft } = await import(`./lib.ts?t=${Date.now()}`);
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  if (!(await dm.getByRole("tablist", { name: "Panels" }).count())) {
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).first().click();
    await dm.waitForTimeout(600);
  }
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  await dm.getByText("Forest road", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await c.harness.pickTool(dm, "Select");
  await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
  await dm.waitForTimeout(800);
  const st = await roomState(c, c.state.forest);
  const gobs = Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.forest && /^Goblin Warrior/.test(t.name) && t.actor?.inline?.life !== "dead") as any[];
  gobs.sort((a, z) => a.name.localeCompare(z.name));
  const g = gobs[0];
  await c.harness.tapCell(dm, b, { x: g.x, y: g.y });
  await dm.waitForTimeout(800);
  await dm.getByRole("button", { name: "Stat block", exact: true }).first().click();
  await dm.waitForTimeout(1200);
  const panel = dm.getByRole("tabpanel").first();
  const box = panel.getByRole("group", { name: "Abilities" }).getByRole("button", { name: /^Dexterity / });
  await box.scrollIntoViewIfNeeded();
  await dm.waitForTimeout(300);
  await box.click();
  const list = dm.getByRole("menu", { name: "Dexterity rolls" });
  await list.waitFor();
  await dm.waitForTimeout(700);
  await c.shot(dm, "gp6-blockroll-list");
  const rows = await list.getByRole("menuitem").evaluateAll((els: any[]) => els.map((el) => el.getAttribute("aria-label") ?? el.innerText.trim()));
  await dm.waitForTimeout(400);
  await list.getByRole("menuitem", { name: /Stealth/ }).first().click();
  await dm.waitForTimeout(2500);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "gp6-blockroll-header-full");
  await moveBarLeft(dm);
  await shot2x(c, dm, "gp6-blockroll-header", { x: 640, y: 0 });
  const head = (await panel.innerText()).slice(0, 300);
  return { goblin: g.name, rows, head };
};
