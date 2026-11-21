export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Done", exact: true }).click();
  await dm.keyboard.press("Escape");
  await c.harness.openSideTab(dm, "Initiative");
  await dm.waitForTimeout(500);
  const t0 = await dm.locator('[role="tabpanel"]').first().innerText();
  await dm.getByRole("button", { name: /^Everyone here/ }).click();
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-fight-started");
  const t1 = await dm.locator('[role="tabpanel"]').first().innerText();
  return t0.slice(0, 300) + "\n----\n" + t1.slice(0, 2500);
};
