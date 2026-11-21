// guidepass6: Heights/stairs on the Hex keep, closer in on the terrace and its stair, Mark stairs picked, and Stairs
// point's Auto and six arrows laid out in the row.
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export default async (c: any) => {
  const dm = c.state.dm;
  const { hexCenter } = await import(`${W}/shared/rules/hex.ts`);
  const G = { shape: "hex", orient: "rows" };
  const bounds = { w: 30, h: 20 };
  const out: Record<string, string> = {};
  const { placedOnHex } = await import(`${W}/shared/rules/footprint.ts`);
  // Bree steps up the hall, into the frame and clear of the options row.
  await c.state.ops.send({ t: "token.update", tokenId: c.state.hexKeepIds.bree, patch: placedOnHex(G, { size: "medium", x: 0, y: 0 }, { col: 9, row: 8 }) });
  const cancel = dm.getByRole("button", { name: "Cancel", exact: true });
  if (await cancel.count()) await cancel.first().click().catch(() => {});
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  // guidepass6: picking the tool that is already in use would hide its options.
  if (!(await dm.getByRole("button", { name: /^Builder mode/ }).count())) await c.harness.pickTool(dm, "Map builder");
  await dm.waitForTimeout(500);
  // guidepass6: the menu may already be open, and a second click would close it.
  if (!(await dm.getByRole("radio", { name: "Heights and stairs" }).count())) {
    await dm.getByRole("button", { name: /^Builder mode/ }).first().click();
    await dm.waitForTimeout(300);
  }
  await dm.getByRole("radio", { name: "Heights and stairs" }).first().click({ force: true });
  await dm.waitForTimeout(600);
  const bar = dm.getByRole("toolbar", { name: "Map builder options" }).first();
  out.before = (await bar.innerText()).replace(/\n/g, " | ");
  const marks = dm.getByRole("radio", { name: "Mark stairs" });
  const onStairs = /Drag to mark stairs/.test(String(out.before));
  if (!onStairs) {
    if (!(await marks.count())) await bar.getByRole("button", { name: /Paint|Height/ }).first().click();
    await dm.waitForTimeout(300);
    await marks.first().click({ force: true });
  }
  await dm.waitForTimeout(500);
  const hide = dm.getByRole("button", { name: "Hide panels" });
  if (await hide.count()) await hide.first().click();
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
  await dm.waitForTimeout(800);
  const mid = await c.harness.pagePoint(dm, bounds, hexCenter(G, { col: 5, row: 5 }));
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 7; i++) {
    await dm.mouse.wheel(0, -60);
    await dm.waitForTimeout(200);
  }
  await dm.waitForTimeout(800);
  // Pan with the middle button, which paints nothing, so the terrace and its stair stand in the middle of the map.
  const now = await c.harness.pagePoint(dm, bounds, hexCenter(G, { col: 5, row: 5 }));
  await dm.mouse.move(now.x, now.y);
  await dm.mouse.down({ button: "middle" });
  for (let i = 1; i <= 10; i++) await dm.mouse.move(now.x + ((560 - now.x) * i) / 10, now.y + ((330 - now.y) * i) / 10);
  await dm.mouse.up({ button: "middle" });
  await dm.waitForTimeout(800);
  // Stairs point folds to its chip where the row is short. A press lays out Auto and the six arrows.
  const chip = bar.getByRole("button", { name: /Stairs point|^Auto$/ });
  out.chip = String(await chip.count());
  if (await chip.count()) {
    await chip.last().click();
    await dm.waitForTimeout(600);
  }
  out.row = (await bar.innerText()).replace(/\n/g, " | ");
  out.arrows = (await dm.locator('[aria-label^="Up to"]').evaluateAll((els: any[]) => els.map((e) => e.getAttribute("aria-label")))).join(" | ");
  out.dialogs = (await dm.getByRole("dialog").allInnerTexts()).join(" || ").slice(0, 300);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp4-hex-stairs-a");
  return out;
};
