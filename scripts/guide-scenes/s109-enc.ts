export default async (c: any) => {
  await c.state.dmPhoneCtx.close();
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await c.harness.openSideTab(dm, "Encounters");
  await dm.waitForTimeout(500);
  const panel = dm.locator('[role="tabpanel"]').first();
  const row = panel.getByText("Road ambush", { exact: true });
  if (await row.count()) await row.first().click();
  await dm.waitForTimeout(600);
  await panelScroll(dm, "Wolf", 40);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-encounters");
  return (await panel.innerText()).slice(0, 200);
};
