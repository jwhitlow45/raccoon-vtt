export default async (c: any) => {
  const dm = c.state.dm;
  await c.shot(dm, "look-export-made");
  const dl = dm.waitForEvent("download", { timeout: 15000 });
  await dm.getByRole("link", { name: "Download" }).or(dm.getByRole("button", { name: "Download" })).first().click();
  const d = await dl;
  const file = `${c.WORK}/forest-road-export.png`;
  await d.saveAs(file);
  const grid = await dm.getByRole("switch", { name: /^Grid/ }).last().getAttribute("aria-checked");
  return { name: d.suggestedFilename(), file, grid };
};
