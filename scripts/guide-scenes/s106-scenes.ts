export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await dm.getByPlaceholder("Search the scene").fill("");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(600);
  // Thumbnails for the scenes that have none yet: view each once.
  for (const name of ["Crypt", "Watchtower", "Dragon's lair", "Forest road"]) {
    await dm.getByText(name, { exact: true }).first().click();
    await dm.waitForTimeout(1800);
  }
  await panelScroll(dm, null);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(800);
  await c.shot(dm, "final-scenes");
  return (await dm.locator('[role="tabpanel"]').first().innerText()).slice(0, 700);
};
