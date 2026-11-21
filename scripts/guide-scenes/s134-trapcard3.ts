// TR-SHOT-1, the card, as kept: after s133 the DM's map drew Thorn's picture two squares below the pit (a stale
// drawing, reported), so the DM views the watchtower and comes back, which draws him in the pit, then frames it as s133 did.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Watchtower", { exact: true }).first().click();
  await dm.waitForTimeout(1500);
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await c.harness.openSideTab(dm, "Initiative");
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("0");
  await dm.waitForTimeout(600);
  const mid = await c.harness.pagePoint(dm, b, { x: 12, y: 6 });
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 2; i++) { await dm.mouse.wheel(0, -120); await dm.waitForTimeout(150); }
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(500);
  await c.shot(dm, "tr-card");
  return "ok";
};
