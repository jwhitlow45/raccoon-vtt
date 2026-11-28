// TR-SHOT-1, the pane: the fight on the field ends, and in the crypt, the players' scene, a Hidden Pit at levels 5–10
// goes just inside the chamber's door, tapped at its own 2 by 2 size. Its pane opens beside the map.
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const b = { w: 30, h: 20 };
  const crypt = c.state.crypt;
  await c.harness.openSideTab(dm, "Initiative");
  const end = dm.getByRole("button", { name: /^End the fight/ }).first();
  if (await end.count()) {
    await end.click();
    await dm.waitForTimeout(300);
    await dm.getByRole("button", { name: /^(End the fight|(?:Tap|Click) again|Sure)/ }).first().click();
    await dm.waitForTimeout(800);
  }
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await ops.send({ t: "door.set", sceneId: crypt, door: { edge: "14,9,w" }, state: "open" }).catch(() => {});
  await ops.send({ t: "token.move", tokenId: c.state.cryptThorn, x: 12, y: 9 });
  await ops.send({ t: "token.move", tokenId: c.state.cryptPcs.bree, x: 19, y: 12 });
  await dm.keyboard.press("0");
  await dm.waitForTimeout(600);
  const mid = await c.harness.pagePoint(dm, b, { x: 8, y: 10 });
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 2; i++) { await dm.mouse.wheel(0, -120); await dm.waitForTimeout(150); }
  await dm.waitForTimeout(800);
  await c.harness.openSideTab(dm, "Initiative");
  await c.harness.pickTool(dm, "Trap");
  if (!(await dm.getByRole("toolbar", { name: "Trap options" }).getByRole("button", { name: /^Start from: Hidden Pit/ }).count())) await c.harness.pickOption(dm, "Trap", "Start from", "Hidden Pit");
  {
    const bar = dm.getByRole("toolbar", { name: "Trap options" });
    const chip = bar.getByRole("button", { name: /^Party level:/ });
    if (!(await dm.getByRole("dialog", { name: "Party level" }).count())) await chip.first().click();
    await dm.waitForTimeout(300);
    await dm.getByRole("dialog", { name: "Party level" }).locator('input[value="5-10"]').click({ force: true, timeout: 3000 }).catch(() => {});
    await dm.waitForTimeout(300);
  }
  await dm.waitForTimeout(300);
  await c.harness.tapCell(dm, b, { x: 15, y: 9 });
  await dm.waitForTimeout(1200);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "tr-pane");
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, crypt);
  const trap = Object.values(st.traps ?? {}).find((t: any) => t.name === "Hidden Pit") as any;
  c.state.pit = trap?.id;
  const pane = await dm.getByRole("dialog", { name: "Edit trap" }).innerText().catch(() => "no pane");
  return { trap: trap && { zone: trap.zone, pit: trap.pit, id: trap.id }, pane };
};
