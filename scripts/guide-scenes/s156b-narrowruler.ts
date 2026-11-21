// guidepass6 probe: a walking ruler from the warhorse, which drags a goblin, into the corridor one square wide. The
// attach design says the ruler does not line creatures up in single file, so it may read "No way through" there.
export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const b = { w: 28, h: 14 };
  const ids = c.state.narrowIds;
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Ruler");
  await dm.waitForTimeout(400);
  const walking = dm.getByRole("radio", { name: "Walking" });
  if (await walking.count()) await walking.first().click({ force: true });
  else {
    const line = dm.getByRole("button", { name: /^(Line|Walk)$/ });
    if (await line.count()) { await line.first().click(); await dm.getByRole("menuitemradio", { name: "Walking" }).first().click(); }
  }
  await dm.waitForTimeout(400);
  const st = await roomState(c, c.state.narrow);
  const h = st.tokens[ids.horse];
  const from = await c.harness.pagePoint(dm, b, { x: h.x + 1, y: h.y + 1 });
  const to = await c.harness.pagePoint(dm, b, { x: 15.5, y: 4.5 });
  await dm.mouse.move(from.x, from.y);
  await dm.mouse.down();
  await dm.mouse.move(to.x, to.y, { steps: 20 });
  await dm.waitForTimeout(1500);
  await c.shot(dm, "gp6-narrow-ruler");
  const text = (await dm.locator("body").innerText()).match(/(Walking[^\n]*|No way through[^\n]*)/g);
  await dm.mouse.up();
  await dm.waitForTimeout(500);
  await dm.keyboard.press("Escape");
  const straight = dm.getByRole("radio", { name: "Straight" });
  if (await straight.count()) await straight.first().click({ force: true });
  await c.harness.pickTool(dm, "Select");
  return { text };
};
