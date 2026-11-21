// guidepass6: Walls/doors on the Hex keep, a Wall line begun across the chamber with its points, before Done.
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export default async (c: any) => {
  const dm = c.state.dm;
  const { hexCorners, cornerAt } = await import(`${W}/shared/rules/hex.ts`);
  const G = { shape: "hex", orient: "rows" };
  const bounds = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  // The side panel away, so the whole keep shows at the size the guide needs.
  const hide = dm.getByRole("button", { name: "Hide panels" });
  if (await hide.count()) await hide.first().click();
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
  await dm.waitForTimeout(800);
  // Closer in, on the corridor's mouth and the chamber, so the wall lines and the line's points read at the guide's width.
  const { hexCenter } = await import(`${W}/shared/rules/hex.ts`);
  const mid = await c.harness.pagePoint(dm, bounds, hexCenter(G, { col: 15, row: 10 }));
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 1; i++) {
    await dm.mouse.wheel(0, -50);
    await dm.waitForTimeout(150);
  }
  await dm.waitForTimeout(600);
  // guidepass6: picking the tool that is already in use would hide its options.
  if (!(await dm.getByRole("button", { name: /^Builder mode/ }).count())) await c.harness.pickTool(dm, "Map builder");
  await dm.waitForTimeout(500);
  // guidepass6: the menu may already be open, and a second click would close it.
  if (!(await dm.getByRole("radio", { name: "Walls and doors" }).count())) {
    await dm.getByRole("button", { name: /^Builder mode/ }).first().click();
    await dm.waitForTimeout(300);
  }
  await dm.getByRole("radio", { name: "Walls and doors" }).first().click({ force: true });
  await dm.waitForTimeout(600);
  const cancel = dm.getByRole("button", { name: "Cancel", exact: true });
  if (await cancel.count()) await cancel.first().click().catch(() => {});
  await dm.waitForTimeout(300);
  const edge = dm.getByRole("button", { name: /^Edge/ });
  if (await edge.count()) {
    await edge.first().click();
    await dm.waitForTimeout(300);
    await dm.getByRole("button", { name: "Wall", exact: true }).or(dm.getByRole("radio", { name: "Wall", exact: true })).first().click();
    await dm.waitForTimeout(300);
  }
  const row = async () => (await dm.getByRole("toolbar", { name: /Builder options|Map builder options/ }).first().innerText().catch(() => "?"));
  const before = await row();
  // Three corners down the chamber's middle, from its north wall: a wall line the DM is still drawing.
  const { hexNeighbors } = await import(`${W}/shared/rules/hex.ts`);
  const A = { col: 22, row: 6 };
  const B = hexNeighbors(G, A)[1];
  const C = hexNeighbors(G, B)[1];
  const a = hexCorners(G, A);
  const b = hexCorners(G, B);
  const cc = hexCorners(G, C);
  // Down the hex sides: A's east side, the side A shares with B, B's west side, then on round C.
  const pts = [a[1], a[2], a[3], b[4], cc[5]];
  for (const k of pts) {
    const p = await c.harness.pagePoint(dm, bounds, cornerAt(G, k));
    await dm.mouse.click(p.x, p.y);
    await dm.waitForTimeout(400);
  }
  // The pointer rests on the next corner the line would take, so its rubber band is one short side.
  const next = await c.harness.pagePoint(dm, bounds, cornerAt(G, cc[4]));
  await dm.mouse.move(next.x, next.y);
  await dm.waitForTimeout(500);
  await c.shot(dm, "gp4-hex-walls");
  return { before, after: await row() };
};
