export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: /^Close the Dex save request/i }).first().click().catch(() => {});
  await dm.waitForTimeout(600);
  // Hide Wolf 2 again and a stamp DM only, so the outliner shows marks.
  await dm.keyboard.press("/");
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-outliner");
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  return t.slice(0, 2500);
};
