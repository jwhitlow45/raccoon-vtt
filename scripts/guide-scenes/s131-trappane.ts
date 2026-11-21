// TR-SHOT-1, the pane as kept (tr-pane3): the map panned 140 px up, the net of the first pass's two pans (its first try is no
// longer replayed), so the pane opens below the pit and shows six of its sections.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(300);
  const p = await c.harness.pagePoint(dm, b, { x: 6, y: 16 });
  await dm.mouse.move(p.x, p.y);
  await dm.mouse.down({ button: "middle" });
  await dm.mouse.move(p.x, p.y - 140, { steps: 10 });
  await dm.mouse.up({ button: "middle" });
  await dm.waitForTimeout(600);
  await c.harness.tapCell(dm, b, { x: 15, y: 9 });
  await dm.waitForTimeout(1000);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "tr-pane3");
  return await dm.getByRole("dialog", { name: "Edit trap" }).boundingBox().catch(() => null);
};
