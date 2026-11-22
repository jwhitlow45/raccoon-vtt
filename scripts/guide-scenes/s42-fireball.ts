export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await c.harness.pickTool(dm, "Area");
  await dm.waitForTimeout(500);
  const idle = await dm.locator("body").innerText();
  const spell = dm.getByRole("combobox", { name: "Spell" });
  if (await spell.count()) {
    await spell.fill("fireball");
    await dm.waitForTimeout(500);
    await dm.keyboard.press("Enter");
  } else {
    return "no spell field\n" + idle.slice(0, 500);
  }
  await dm.waitForTimeout(500);
  const draft = await dm.locator("body").innerText();
  await dm.getByRole("button", { name: "More options" }).click();
  await dm.waitForTimeout(400);
  await c.shot(dm, "look-area-more");
  const more = await dm.locator("body").innerText();
  await dm.getByRole("button", { name: /^Set caster/ }).click();
  await dm.waitForTimeout(300);
  await c.harness.tapCell(dm, b, { x: 3, y: 10 });
  await dm.waitForTimeout(500);
  const afterCaster = await dm.locator("body").innerText();
  await c.harness.tapCell(dm, b, { x: 11, y: 5 });
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-areas");
  const preview = await dm.locator("body").innerText();
  return [idle.slice(0, 300), draft.slice(0, 300), more.slice(0, 700), afterCaster.slice(0, 300), preview.slice(0, 400)].join("\n-----\n");
};
