// guidepass6: the same moment, the side panel scrolled to the scene's Grid shape, now on Hex rows.
export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await panelScroll(dm, "Map phases", 8);
  await dm.waitForTimeout(400);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp4-hex-find-shape");
  const panel = await dm.locator('[role="tabpanel"]').first().innerText();
  return panel.slice(0, 900);
};
