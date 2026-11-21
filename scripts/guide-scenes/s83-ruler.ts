export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await c.harness.pickTool(dm, "Ruler");
  await dm.waitForTimeout(400);
  await c.harness.dragWorld(dm, b, { x: 19.5, y: 8.5 }, { x: 9.5, y: 10.5 });
  await dm.waitForTimeout(600);
  const reading = (await dm.locator("body").innerText()).slice(0, 300);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-heights-build");
  return reading;
};
