// AT-SHOT-1 as taken: Mara's Attach list as it opens, beside her bar, with Thorn on Warhorse 1. The harpies were moved off to the east first.
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  await ops.send({ t: "token.move", tokenId: c.state.harpies[0], x: 25, y: 4 });
  await ops.send({ t: "token.move", tokenId: c.state.harpies[1], x: 26, y: 16 });
  await c.harness.openSideTab(dm, "Initiative");
  await dm.keyboard.press("0");
  await dm.waitForTimeout(600);
  const mid = await c.harness.pagePoint(dm, b, { x: 1, y: 12 });
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 2; i++) { await dm.mouse.wheel(0, -120); await dm.waitForTimeout(150); }
  await dm.waitForTimeout(800);
  await c.harness.tapCell(dm, b, { x: 6, y: 15 });
  await dm.waitForTimeout(600);
  // Review round 1: the dragon's Fire Breath left a "Use 69" chip in every HP entry. A roll this device applied leaves
  // its chips, so it is applied to Mara and undone, which leaves her at 26/33 and the entry clear.
  const chip = dm.getByRole("button", { name: /^Use \d+ \(/ }).first();
  if (await chip.count()) {
    await chip.click();
    await dm.waitForTimeout(300);
    await dm.getByRole("button", { name: "Apply", exact: true }).first().click();
    await dm.waitForTimeout(800);
    await dm.keyboard.press("Control+z");
    await dm.waitForTimeout(1200);
    await dm.keyboard.press("Escape");
    await dm.waitForTimeout(6000);
    await c.harness.tapCell(dm, b, { x: 6, y: 15 });
    await dm.waitForTimeout(600);
  }
  await dm.getByRole("button", { name: "Attach", exact: true }).first().click();
  await dm.waitForTimeout(600);
  await dm.mouse.move(1000, 790);
  await c.shot(dm, "at-attach2");
  return [await dm.getByRole("dialog").last().boundingBox(), await dm.getByRole("dialog").last().innerText()];
};
