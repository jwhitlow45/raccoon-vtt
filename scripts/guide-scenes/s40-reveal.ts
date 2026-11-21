export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await dm.getByRole("button", { name: /^Dismiss .*turn$/ }).first().click({ timeout: 1500 }).catch(() => {});
  await c.harness.tapCell(dm, b, { x: 8, y: 7 });
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Multi-select", exact: true }).first().click();
  for (const p of [{ x: 11, y: 6 }, { x: 14, y: 5 }, { x: 17, y: 5 }, { x: 12, y: 4 }]) await c.harness.tapCell(dm, b, p);
  await dm.waitForTimeout(500);
  // The tracker shows the selected goblins' rows, tagged Hidden, wherever their initiative put them.
  const { rowsIntoView } = await import(`./lib.ts?t=${Date.now()}`);
  // The warriors' rows, which stay hidden until the reveal even when the boss rolled first and showed on its turn.
  const moved = await rowsIntoView(dm, "^Goblin Warrior( \\(\\d\\))?$", 36);
  // Off the tokens, so no name label covers the goblins.
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "look-goblins-selected");
  await dm.getByRole("button", { name: "Hidden", exact: true }).first().click();
  await dm.waitForTimeout(800);
  await dm.getByRole("button", { name: "Done", exact: true }).click();
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(500);
  await c.shot(c.state.pat, "look-pat-revealed");
  return moved;
};
