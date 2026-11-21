export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(400);
  const still = (await dm.locator('[role="tabpanel"]').first().innerText()).includes("Rolls for Adult Red Dragon");
  await panelScroll(dm, "Rolls for Adult Red Dragon");
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-boss");
  return still;
};
