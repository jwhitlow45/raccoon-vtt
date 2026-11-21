export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "DM");
  await dm.waitForTimeout(400);
  await dm.getByRole("switch", { name: /^Black out players' screens/ }).click();
  await dm.waitForTimeout(1500);
  const pat = c.state.pat;
  await c.shot(pat, "look-pat-blackout");
  const patText = (await pat.locator("body").innerText()).slice(0, 200);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-blackout-dm");
  const dmTop = (await dm.locator("body").innerText()).slice(0, 120);
  await dm.getByRole("switch", { name: /^Black out players' screens/ }).click();
  await dm.waitForTimeout(800);
  return patText + "\n---\n" + dmTop;
};
