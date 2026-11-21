// A handout shown once and hidden again, so the DM panel's Handouts lists it under Recent with Show to everyone: the
// forest map the app exported in s08, titled Road map.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "DM");
  await dm.getByRole("button", { name: "Show a handout" }).click();
  await dm.waitForTimeout(500);
  await dm.locator('input[type="file"]').first().setInputFiles(`${c.WORK}/forest-road-export.png`);
  await dm.waitForTimeout(800);
  await dm.getByLabel("Title", { exact: true }).fill("Road map");
  await dm.getByRole("button", { name: "Show", exact: true }).click();
  await dm.getByRole("button", { name: "Hide", exact: true }).first().waitFor();
  await dm.waitForTimeout(800);
  await dm.getByRole("button", { name: "Hide", exact: true }).first().click();
  await dm.waitForTimeout(1500);
  return (await dm.locator('[role="tabpanel"]').first().innerText()).slice(0, 300);
};
