// guidepass6: a new Map image scene on Squares, the room's choice, from the hex map s146 exported with its hex lines.
// The upload's search finds hex rows and switches the scene's shape, and Line up grid says so.
export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  const kind = (name: string) => dm.getByRole("radiogroup", { name: "Kind of scene" }).getByRole("radio", { name, exact: true });
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  const panels = dm.getByRole("button", { name: "Panels" });
  if (await panels.count()) await panels.first().click();
  await dm.waitForTimeout(800);
  await c.harness.openSideTab(dm, "Scenes");
  await panelScroll(dm, "New scene", 8);
  if ((await kind("Map image").getAttribute("aria-checked")) !== "true") await kind("Map image").click();
  await dm.waitForTimeout(300);
  await dm.getByPlaceholder("Name from the file").fill("Meadow ruins");
  const squares = dm.getByRole("radio", { name: "Squares", exact: true }).first();
  const shape = await squares.getAttribute("aria-checked");
  const chooser = dm.waitForEvent("filechooser");
  await dm.getByRole("button", { name: "Choose a map image" }).click();
  await (await chooser).setFiles(`${c.WORK}/hex-meadow.png`);
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Upload and create" }).click();
  await dm.waitForTimeout(9000);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp4-hex-find");
  const line = await dm.locator("[data-options-line]").first().innerText().catch(() => "?");
  const row = await dm.locator('nav[aria-label="Tools"]').locator("xpath=..").innerText().catch(() => "?");
  return { squaresChecked: shape, line, row: row.slice(0, 500) };
};
