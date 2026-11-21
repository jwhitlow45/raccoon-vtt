// guidepass6: the DM drags the warhorse, Thorn in the saddle, through the open door into the corridor one hex wide.
// The horse squeezes onto one hex there, and Thorn sits on that hex with it.
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export default async (c: any) => {
  const dm = c.state.dm;
  const { hexCenter } = await import(`${W}/shared/rules/hex.ts`);
  const { occupiedHexes } = await import(`${W}/shared/rules/footprint.ts`);
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const G = { shape: "hex", orient: "rows" };
  const bounds = { w: 30, h: 20 };
  const ids = c.state.hexKeepIds;
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  // The side panel away, for the room the map needs.
  const hide = dm.getByRole("button", { name: "Hide panels" });
  if (await hide.count()) await hide.first().click();
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
  await dm.waitForTimeout(800);
  // Closer in on the hall's east side and the corridor, so the drag's label reads at the guide's width.
  const mid = await c.harness.pagePoint(dm, bounds, hexCenter(G, { col: 13, row: 10 }));
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 3; i++) {
    await dm.mouse.wheel(0, -60);
    await dm.waitForTimeout(200);
  }
  await dm.waitForTimeout(800);
  let st = await roomState(c, c.state.hexKeep);
  const horse = st.tokens[ids.horse];
  const from = await c.harness.pagePoint(dm, bounds, { x: horse.x + 1, y: horse.y + 1 });
  const to = await c.harness.pagePoint(dm, bounds, hexCenter(G, { col: 16, row: 10 }));
  await dm.mouse.move(from.x, from.y);
  await dm.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await dm.mouse.move(from.x + ((to.x - from.x) * i) / 16, from.y + ((to.y - from.y) * i) / 16);
    await dm.waitForTimeout(40);
  }
  await dm.waitForTimeout(1200);
  await c.shot(dm, "gp4-hex-ride-drag");
  await dm.mouse.up();
  await dm.waitForTimeout(2000);
  st = await roomState(c, c.state.hexKeep);
  const h = st.tokens[ids.horse];
  const t = st.tokens[ids.thorn];
  const hx = occupiedHexes(G, h).map((x: any) => `${x.col},${x.row}`);
  const tx = occupiedHexes(G, t).map((x: any) => `${x.col},${x.row}`);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp4-hex-ride");
  // Out of the way in the hall's corner, so the hex keep's next pictures show the hall and the corridor empty.
  const { placedOnHex } = await import(`${W}/shared/rules/footprint.ts`);
  const corner = placedOnHex(G, { size: "large", x: 0, y: 0 }, { col: 3, row: 15 });
  await c.state.ops.send({ t: "token.move", tokenId: ids.horse, x: corner.x, y: corner.y });
  await dm.waitForTimeout(1500);
  return { squeeze: h.squeeze, horse: hx, thorn: tx, attached: t.attached, line: (await dm.locator("body").innerText()).slice(0, 400) };
};
