export default async (c: any) => {
  const dm = c.state.dm;
  const dlg = dm.getByRole("dialog").last();
  await dlg.getByText("Owl", { exact: true }).first().click();
  await dm.waitForTimeout(800);
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByLabel("Turn").selectOption({ label: "Its own turn" }).catch(async () => {
    await panel.getByRole("combobox", { name: "Turn" }).selectOption({ label: "Its own turn" });
  });
  await dm.waitForTimeout(400);
  const form = await panel.innerText();
  // The boss from the earlier steps is still selected, with its action bar open over the map.
  await c.harness.tapCell(dm, { w: 30, h: 20 }, { x: 0, y: 0 });
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-owl-form");
  await panel.getByRole("button", { name: "Add and place" }).click();
  await dm.waitForTimeout(1500);
  await c.shot(dm, "look-owl-placed");
  return form.slice(0, 1500);
};
