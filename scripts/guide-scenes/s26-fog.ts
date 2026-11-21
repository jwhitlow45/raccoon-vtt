export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.pickTool(dm, "Fog");
  await dm.waitForTimeout(600);
  const before = await dm.locator("body").innerText();
  await c.harness.dragWorld(dm, { w: 30, h: 20 }, { x: 0.2, y: 7.2 }, { x: 12.8, y: 13.8 });
  await dm.waitForTimeout(400);
  await c.harness.dragWorld(dm, { w: 30, h: 20 }, { x: 12.2, y: 6.2 }, { x: 20.8, y: 11.8 });
  await dm.waitForTimeout(600);
  await c.shot(dm, "final-fog");
  const after = await dm.locator("body").innerText();
  return before.slice(0, 400) + "\n-----\n" + after.slice(0, 400);
};
