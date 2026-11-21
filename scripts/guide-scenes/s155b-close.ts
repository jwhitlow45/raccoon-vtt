export default async (c: any) => {
  const dm = c.state.dm;
  const dialog = dm.getByRole("dialog", { name: "Import a Universal VTT map" });
  // Keep it lit, to read what the lead says then, and back to the dark start, before closing without a scene.
  await dialog.getByRole("button", { name: "Keep it lit", exact: true }).click();
  await dm.waitForTimeout(500);
  const lit = (await dialog.innerText()).slice(0, 300);
  await dialog.getByRole("button", { name: "Start it dark", exact: true }).click();
  await dm.waitForTimeout(300);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dm.waitForTimeout(500);
  const hexKeep = dm.getByText("Hex keep", { exact: true }).first();
  await hexKeep.click();
  await dm.waitForTimeout(1500);
  return lit;
};
