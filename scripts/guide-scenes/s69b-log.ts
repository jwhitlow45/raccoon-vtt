// guidepass6: the Log's Export list of evenings, as log-export.webp.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "Log");
  await dm.waitForTimeout(800);
  const panel = dm.locator('[role="tabpanel"]').first();
  await c.shot(dm, "gp5-log-a");
  await panel.getByRole("button", { name: /^Export/ }).first().click();
  await dm.waitForTimeout(1200);
  await c.shot(dm, "gp5-log-export");
  const text = (await dm.locator("body").innerText()).slice(0, 1200);
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(500);
  return text;
};
