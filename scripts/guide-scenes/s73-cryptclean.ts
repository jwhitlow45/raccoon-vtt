export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  // The skeletons keep their default icon, a skeleton on black.
  // Take Surprised off the party.
  await c.harness.tapCell(dm, b, { x: 5, y: 9 });
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "Multi-select", exact: true }).first().click();
  for (const p of [{ x: 3, y: 10 }, { x: 6, y: 10 }, { x: 4, y: 11 }]) await c.harness.tapCell(dm, b, p);
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "Conditions", exact: true }).first().click();
  await dm.waitForTimeout(300);
  await dm.getByRole("button", { name: /^Surprised/ }).first().click();
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "Done", exact: true }).click();
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(400);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-crypt-build");
  return "ok";
};
