export default async (c: any) => {
  const dm = c.state.dm;
  const pat = c.state.pat;
  await dm.getByRole("dialog", { name: "Request a roll" }).getByRole("button", { name: "Send" }).click();
  await dm.waitForTimeout(1500);
  await c.shot(pat, "look-pat-card");
  const patText = await pat.locator("body").innerText();
  // Pat rolls for Mara from the card.
  const roll = pat.getByRole("button", { name: /^Roll [+-]\d/ }).first();
  if (await roll.count()) {
    await roll.tap();
    await pat.waitForTimeout(1500);
  }
  await c.shot(pat, "look-pat-card2");
  await dm.waitForTimeout(500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-dm-card");
  const dmText = await dm.locator("body").innerText();
  return patText.slice(0, 800) + "\n-----\n" + dmText.slice(0, 900);
};
