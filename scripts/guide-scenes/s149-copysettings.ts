// guidepass6 phase 2: Use these settings on other scenes, from the forest road, three scenes ticked, closed without copying.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  await dm.getByText("Forest road", { exact: true }).first().click();
  await dm.waitForTimeout(1500);
  const open = dm.getByRole("button", { name: /^Copy to other scenes/ }).first();
  await open.scrollIntoViewIfNeeded();
  await open.click();
  await dm.waitForTimeout(800);
  const sheet = dm.getByRole("dialog").last();
  for (const name of ["Battle mat", "Crypt", "Watchtower"]) await sheet.getByRole("checkbox", { name, exact: true }).check();
  await dm.waitForTimeout(500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp3-copy-settings");
  const text = await sheet.innerText();
  await sheet.getByRole("button", { name: "Close", exact: true }).first().click();
  await dm.waitForTimeout(400);
  return text.slice(0, 900);
};
