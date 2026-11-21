export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(800);
  await c.shot(dm, "look-scenes");
  const text = await dm.locator("body").innerText();
  return text.slice(0, 3000);
};
