export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const hint = async () => (await dm.locator("body").innerText()).split("\n").slice(0, 6).join(" / ");
  const log: string[] = [];
  log.push("start: " + (await hint()));
  await dm.getByRole("button", { name: "More options" }).click();
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: /^Set caster/ }).click();
  await dm.waitForTimeout(400);
  log.push("after set caster: " + (await hint()) + " popover=" + (await dm.getByRole("dialog", { name: /More Area options/ }).count()));
  // The first tap on the token can only close the pop-up that is still open, so tap until the app takes the caster.
  for (let i = 0; i < 3 && !/Cast by Ivo|(?:Tap|Click) where it goes|cast by Ivo/.test(await dm.locator("body").innerText()); i++) {
    await c.harness.tapCell(dm, b, { x: 3, y: 10 });
    await dm.waitForTimeout(600);
  }
  log.push("after tap ivo: " + (await hint()));
  // The first tap on the ground can only close the pop-up that is still open, so tap until the area shows.
  for (let i = 0; i < 3 && !(await hint()).includes("In area"); i++) {
    await c.harness.tapCell(dm, b, { x: 11, y: 5 });
    await dm.waitForTimeout(800);
  }
  log.push("after tap spot: " + (await hint()));
  // The Initiative panel as it opens, its first row at the top.
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await panelScroll(dm, null);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-areas");
  return log.join("\n");
};
