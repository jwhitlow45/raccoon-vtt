export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.pickTool(dm, "Fog");
  await dm.waitForTimeout(500);
  await c.harness.dragWorld(dm, { w: 30, h: 20 }, { x: 5.2, y: 2.2 }, { x: 22.8, y: 7.8 });
  await c.harness.dragWorld(dm, { w: 30, h: 20 }, { x: 5.2, y: 13.2 }, { x: 16.8, y: 16.8 });
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: /^Reveal to players/ }).click();
  await dm.waitForTimeout(800);
  await c.harness.pickTool(dm, "Select");
  await dm.waitForTimeout(800);
  await c.shot(c.state.pat, "look-pat-revealed2");
  return "ok";
};
