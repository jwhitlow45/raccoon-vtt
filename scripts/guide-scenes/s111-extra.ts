export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  const out: Record<string, string> = {};
  // Crypt: the secret door pill.
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await c.harness.pickTool(dm, "Select");
  // The secret door is the west edge of cell 24,9: tap on that edge's middle.
  const p = await c.harness.pagePoint(dm, b, { x: 24, y: 9.5 });
  await dm.mouse.click(p.x, p.y);
  await dm.waitForTimeout(600);
  out.door = (await dm.locator("body").innerText()).slice(0, 300);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-secret-door");
  // The door's pill closes before Room settings, so it does not sit over the crypt in that picture.
  await dm.keyboard.press("Escape");
  for (let i = 0; i < 3 && (await dm.getByText("Closed secret door, hidden").count()); i++) {
    await c.harness.tapCell(dm, b, { x: 2, y: 2 });
    await dm.waitForTimeout(400);
  }
  out.pillGone = String((await dm.getByText("Closed secret door, hidden").count()) === 0);
  // Room settings.
  await c.harness.openSideTab(dm, "Menu");
  await dm.waitForTimeout(500);
  out.menu = (await dm.locator('[role="tabpanel"]').first().innerText()).slice(0, 600);
  await dm.getByRole("button", { name: /^Room settings/ }).first().click();
  await dm.waitForTimeout(800);
  await panelScroll(dm, "Combat", 20);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-room-settings");
  out.settings = (await dm.locator('[role="tabpanel"]').first().innerText()).slice(0, 1500);
  return out;
};
