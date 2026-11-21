export default async (c: any) => {
  const dm = c.state.dm;
  const grid = dm.getByRole("switch", { name: /^Grid/ }).last();
  const before = await grid.getAttribute("aria-checked");
  if (before !== "true") await grid.click();
  await dm.waitForTimeout(300);
  // The whole export section in view, Grid included, as the caption lists it.
  const { rowsIntoView } = await import(`./lib.ts?t=${Date.now()}`);
  await rowsIntoView(dm, "^Export$", 8);
  await dm.waitForTimeout(300);
  await c.shot(dm, "look-export-grid");
  const dl = dm.waitForEvent("download", { timeout: 30000 }).catch((e: Error) => e.message);
  await dm.getByRole("button", { name: "Make image" }).click();
  const d = await dl;
  if (typeof d === "string") {
    await c.shot(dm, "look-export-after");
    return "no download: " + d + "\n" + (await dm.locator("body").innerText()).slice(-1500);
  }
  const file = `${c.WORK}/forest-road-export.png`;
  await d.saveAs(file);
  return { name: d.suggestedFilename(), file };
};
