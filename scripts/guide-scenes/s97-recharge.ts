export default async (c: any) => {
  // The turn card stays open from here to s99, for the picture of the recharge alert beside it.
  c.state.keepTurnCard = true;
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const out: string[] = [];
  out.push((await dm.locator("body").innerText()).match(/Fire Breath: [^\n]*/)?.[0] ?? "no toast");
  await dm.getByRole("button", { name: "Undo", exact: true }).first().click();
  await dm.waitForTimeout(1200);
  out.push((await dm.locator("body").innerText()).match(/Undid[^\n]*/)?.[0] ?? "no undo toast");
  // Back on the dragon: is Fire Breath marked Used?
  await dm.keyboard.press("Escape");
  await dm.getByRole("button", { name: "Done", exact: true }).click().catch(() => {});
  await dm.keyboard.press("Escape");
  await c.harness.tapCell(dm, b, { x: 16, y: 7 });
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Roll", exact: true }).first().click();
  await dm.waitForTimeout(1000);
  const used = await dm.getByRole("button", { name: /Fire Breath is used|Mark Fire Breath used/ }).first().getAttribute("aria-label");
  out.push("used button: " + used);
  // Round the order back to the dragon.
  await c.harness.openSideTab(dm, "Initiative");
  for (let i = 0; i < 5; i++) {
    await dm.getByRole("button", { name: "Next", exact: true }).first().click();
    await dm.waitForTimeout(700);
  }
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(800);
  const body = await dm.locator("body").innerText();
  out.push(body.match(/Fire Breath can recharge[^\n]*/)?.[0] ?? "no recharge card");
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-recharge");
  return out.join("\n");
};
