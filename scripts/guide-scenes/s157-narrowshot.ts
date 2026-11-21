// guidepass6: the DM drags the warhorse into the corridor one square wide, where it squeezes and the goblin it drags
// falls in behind it, then drags the elephant into the corridor two squares wide, where its four riders each keep a
// square. One picture shows both.
export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const b = { w: 28, h: 14 };
  const ids = c.state.narrowIds;
  const scene = c.state.narrow;
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  const hide = dm.getByRole("button", { name: "Hide panels" });
  if (await hide.count()) await hide.first().click();
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
  await dm.waitForTimeout(800);
  // Closer in on the hall's east side and the two corridors, so the riders read at the guide's width.
  const mid = await c.harness.pagePoint(dm, b, { x: 12, y: 6.5 });
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 1; i++) {
    await dm.mouse.wheel(0, -60);
    await dm.waitForTimeout(200);
  }
  await dm.waitForTimeout(800);
  const drag = async (fromW: { x: number; y: number }, toW: { x: number; y: number }, name: string) => {
    const from = await c.harness.pagePoint(dm, b, fromW);
    const to = await c.harness.pagePoint(dm, b, toW);
    await dm.mouse.move(from.x, from.y);
    await dm.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await dm.mouse.move(from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20);
      await dm.waitForTimeout(40);
    }
    await dm.waitForTimeout(1200);
    await c.shot(dm, `gp6-narrow-${name}-drag`);
    await dm.mouse.up();
    await dm.waitForTimeout(2000);
  };
  let st = await roomState(c, scene);
  const h = st.tokens[ids.horse];
  await drag({ x: h.x + 1, y: h.y + 1 }, { x: 15.5, y: 4.5 }, "horse");
  st = await roomState(c, scene);
  const e = st.tokens[ids.elephant];
  await drag({ x: e.x + 1.5, y: e.y + 1.5 }, { x: 15, y: 9 }, "elephant");
  await dm.keyboard.press("Escape");
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(800);
  await c.shot(dm, "gp6-narrow");
  st = await roomState(c, scene);
  const pose = (id: string) => { const t = st.tokens[id]; return t ? { x: t.x, y: t.y, squeeze: t.squeeze ?? null, on: t.attached ?? null } : null; };
  return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, pose(id as string)]));
};
