// guidepass6 phase 2: the scene settings page as the design pass draws it, on the forest road.
// First every group folded, each with its summary, then Map image and grid open. The groups are opened again after.
export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  await dm.getByText("Forest road", { exact: true }).first().click();
  await dm.waitForTimeout(1500);
  await c.harness.pickTool(dm, "Select");
  const panel = dm.getByRole("tabpanel", { name: "Scenes" });
  const groups = ["Light and weather", "Scene sound", "Fog and vision", "Map and grid", "Walls and movement", "Size and view"];
  const fold = (name: string) => panel.locator("button[aria-expanded]").filter({ hasText: new RegExp(`^${name}`) }).first();
  const set = async (name: string, open: boolean) => {
    const b = fold(name);
    if (!(await b.count())) return;
    if ((await b.getAttribute("aria-expanded")) !== String(open)) await b.click();
    await dm.waitForTimeout(250);
  };
  for (const g of groups) await set(g, false);
  await panelScroll(dm, "This scene", 8);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(400);
  await c.shot(dm, "gp3-scene-settings-folded");
  const folded = await panel.innerText();
  await set("Map and grid", true);
  await panelScroll(dm, "Map and grid", 8);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(400);
  await c.shot(dm, "gp3-scene-settings-map");
  const map = await panel.innerText();
  for (const g of groups) await set(g, true);
  const i = folded.search(/This scene/i);
  const j = map.search(/Map and grid/i);
  return { folded: folded.slice(i, i + 500), map: map.slice(j, j + 700) };
};
