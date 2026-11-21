// boss.webp (round 3): the map pans left with the middle button, so the turn's movement pill, drawn at the ring where
// the turn began, stands clear of the action bar's window. Three pans are shot, and the map is fitted again after.
export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await panelScroll(dm, "Multiattack.", 70);
  const pan = async (dx: number) => {
    await dm.mouse.move(300, 660);
    await dm.mouse.down({ button: "middle" });
    await dm.mouse.move(300 - dx * 0.2, 660, { steps: 3 });
    await dm.mouse.move(300 - dx, 660, { steps: 10 });
    await dm.mouse.up({ button: "middle" });
    await dm.waitForTimeout(500);
  };
  const out: Record<string, unknown> = {};
  for (const [dx, name] of [[130, "final-boss-p130"], [40, "final-boss-p170"], [40, "final-boss-p210"]] as const) {
    await pan(dx);
    await dm.mouse.move(5, 790);
    await dm.waitForTimeout(400);
    await c.shot(dm, name);
  }
  out.bar = await dm.getByRole("button", { name: "Doesn't count" }).first().isVisible().catch(() => false);
  await dm.mouse.move(300, 660);
  await dm.keyboard.press("0");
  await dm.waitForTimeout(1200);
  return out;
};
