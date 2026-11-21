// Starter maps under New scene: Dyson's maps by category, one tapped to show its credit. Closed without using it.
export default async (c: any) => {
  const dm = c.state.dm;
  if (await dm.getByRole("dialog", { name: "Starter maps" }).count()) await dm.keyboard.press("Escape");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  const choice = dm.getByText("Map image", { exact: true }).nth(0);
  await choice.scrollIntoViewIfNeeded();
  await choice.click();
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "From starter packs" }).click();
  const dlg = dm.getByRole("dialog", { name: "Starter maps" });
  await dlg.waitFor();
  await dm.waitForTimeout(600);
  const fold = dlg.getByRole("button", { name: /^Dyson Logos maps/ }).first();
  if ((await fold.count()) && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await dm.waitForTimeout(600);
  await dlg.getByRole("button", { name: "Coaching inn with stable yard", exact: true }).first().click();
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-starter-maps");
  return (await dlg.innerText()).slice(0, 1500);
};
