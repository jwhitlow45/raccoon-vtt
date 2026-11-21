export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await c.harness.openSideTab(dm, "Initiative");
  const a = await c.harness.pagePoint(dm, b, { x: 5.5, y: 9.5 });
  const z = await c.harness.pagePoint(dm, b, { x: 12.5, y: 9.5 });
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + 5, a.y, { steps: 3 });
  await dm.mouse.move(z.x, z.y, { steps: 15 });
  await dm.waitForTimeout(400);
  await c.shot(dm, "final-movement");
  const t = (await dm.locator("body").innerText()).slice(0, 200);
  await dm.keyboard.press("Escape");
  await dm.mouse.up();
  await dm.waitForTimeout(500);
  await c.state.ops.send({ t: "token.move", tokenId: Object.values(c.state.cryptPcs)[0] === undefined ? "" : c.state.cryptPcs.bree, x: 18, y: 10 }).catch(() => {});
  return t;
};
