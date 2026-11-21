// boss.webp (round 3): on the dragon's turn the DM rolls its own Rend, attack then damage, so the Dice panel's newest
// roll and the HP entry's chip are the dragon's, not a goblin's scimitar or the earlier Fireball.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await c.state.ops.send({ t: "token.move", tokenId: c.state.dragon, x: 15, y: 6 });
  await dm.waitForTimeout(500);
  await c.harness.tapCell(dm, b, { x: 16, y: 7 });
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Roll", exact: true }).first().click();
  await dm.waitForTimeout(1200);
  const rolls = dm.locator('section[aria-label="Rolls for Adult Red Dragon"]').first();
  await rolls.getByRole("button").filter({ hasText: /^Attack/ }).first().click();
  await dm.waitForTimeout(1500);
  await rolls.getByRole("button", { name: /^Rend damage/ }).first().click();
  await dm.waitForTimeout(1500);
  await panelScroll(dm, "Multiattack.");
  const chip = await dm.getByRole("button", { name: /^Use \d+ \(/ }).first().textContent().catch(() => "no chip");
  return { chip };
};
