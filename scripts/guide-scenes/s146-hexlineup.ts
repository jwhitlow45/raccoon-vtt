// guidepass6 draft, for phase 2: Line up grid on a hex map, its box over 7 hexes.
// Every map here is the app's own work. The forest builder scene of s04 is exported without a grid, that
// picture becomes a map image scene on hex rows and is exported with its hex lines, and that hex map then
// starts a third scene on hex rows, where Line up grid opens on hexes.
export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  const kind = (name: string) => dm.getByRole("radiogroup", { name: "Kind of scene" }).getByRole("radio", { name, exact: true });
  const open = async (name: string) => {
    await c.harness.openSideTab(dm, "Scenes");
    await dm.waitForTimeout(400);
    await dm.getByText(name, { exact: true }).first().click();
    await dm.waitForTimeout(1500);
  };
  // Export the scene on screen, DM view, with its grid lines on or off, to `file`.
  const exportTo = async (file: string, lines: boolean) => {
    const exp = dm.getByRole("button", { name: "Export as image" });
    await exp.scrollIntoViewIfNeeded();
    await exp.click();
    await dm.waitForTimeout(800);
    await dm.getByRole("button", { name: "DM view", exact: true }).or(dm.getByRole("radio", { name: "DM view", exact: true })).first().click();
    const box = dm.getByRole("checkbox", { name: /^(Grid|Hex lines)$/ }).or(dm.getByRole("switch", { name: /^(Grid|Hex lines)$/ })).last();
    if ((await box.isChecked().catch(() => (box.getAttribute("aria-checked").then((v: string | null) => v === "true")))) !== lines) await box.click();
    await dm.waitForTimeout(300);
    await dm.getByRole("button", { name: "Make image" }).click();
    await dm.waitForTimeout(1500);
    const dl = dm.waitForEvent("download", { timeout: 30000 });
    dl.catch(() => {});
    await dm.getByRole("link", { name: "Download" }).or(dm.getByRole("button", { name: "Download" })).first().click();
    const d = await dl;
    await d.saveAs(file);
    const close = dm.getByRole("button", { name: "Close", exact: true });
    if (await close.count()) await close.last().click().catch(() => {});
    return d.suggestedFilename();
  };
  const newHexMap = async (name: string, file: string) => {
    await c.harness.openSideTab(dm, "Scenes");
    await panelScroll(dm, "New scene", 8);
    if ((await kind("Map image").getAttribute("aria-checked")) !== "true") await kind("Map image").click();
    await dm.waitForTimeout(300);
    await dm.getByPlaceholder("Name from the file").fill(name);
    await dm.getByRole("radio", { name: "Hex rows", exact: true }).first().click();
    const chooser = dm.waitForEvent("filechooser");
    await dm.getByRole("button", { name: "Choose a map image" }).click();
    await (await chooser).setFiles(file);
    await dm.waitForTimeout(500);
    await dm.getByRole("button", { name: "Upload and create" }).click();
    await dm.waitForTimeout(7000);
  };
  const plain = `${c.WORK}/forest-plain.png`;
  const hexed = `${c.WORK}/hex-meadow.png`;
  await open("Forest road (builder)");
  const first = await exportTo(plain, false);
  await newHexMap("Hex meadow", plain);
  await c.harness.pickTool(dm, "Select");
  await dm.waitForTimeout(500);
  const second = await exportTo(hexed, true);
  await newHexMap("Hex meadow map", hexed);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp3-hex-lineup");
  const row = await dm.locator('nav[aria-label="Tools"]').locator("xpath=..").innerText().catch(() => "?");
  return { first, second, row: row.slice(0, 600) };
};
