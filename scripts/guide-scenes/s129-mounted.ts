// Extra: mounted combat. A fight on the watchtower's field: Mara 18, Thorn 15 on Warhorse 1 (15, after him), the
// harpies 13, Warhorse 2 8. On Mara's turn she rides Warhorse 2, Controlled, by her bar's Attach, and its row moves to
// just after hers. Then her drag moves the horse 30 ft east, and the pill on the horse names her own movement.
// Guide pass 2: the rows move only for a ride every player sees, so the players are moved to the watchtower for the
// fight, and back to the crypt after the picture, where s130's trap needs them.
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const b = { w: 30, h: 20 };
  const tower = c.state.tower;
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  await ops.send({ t: "room.setPlayerScene", sceneId: tower });
  await dm.waitForTimeout(800);
  await c.harness.openSideTab(dm, "Initiative");
  await dm.getByRole("button", { name: /^Everyone here/ }).click();
  await dm.waitForTimeout(1200);
  let st = await roomState(c, tower);
  const [h1, h2] = c.state.horses;
  const vals: Record<string, number> = { Thorn: 15, Mara: 18, Harpy: 13 };
  for (const e of st.encounter.entries) {
    const tok = st.tokens[e.tokenId];
    if (!tok) continue;
    const v = tok.id === h1 ? 15 : tok.id === h2 ? 8 : vals[tok.name];
    if (v !== undefined) await ops.send({ t: "encounter.setValue", entryId: e.id, value: v });
  }
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Start", exact: true }).first().click();
  await dm.waitForTimeout(1000);
  await c.harness.tapCell(dm, b, { x: 6, y: 15 });
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: "Attach", exact: true }).first().click();
  await dm.waitForTimeout(600);
  await dm.getByRole("button", { name: /^Ride Warhorse \(?2\)?/ }).first().click();
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "Ride", exact: true }).first().click();
  await dm.waitForTimeout(1000);
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(400);
  st = await roomState(c, tower);
  const mara = st.tokens[c.state.towerMara];
  const horse = st.tokens[h2];
  const a = await c.harness.pagePoint(dm, b, { x: mara.x + 0.5, y: mara.y + 0.5 });
  const z = await c.harness.pagePoint(dm, b, { x: mara.x + 6.5, y: mara.y + 0.5 });
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + 5, a.y, { steps: 3 });
  await dm.mouse.move(z.x, z.y, { steps: 20 });
  await dm.waitForTimeout(500);
  await dm.mouse.up();
  await dm.waitForTimeout(1200);
  await dm.keyboard.press("Escape");
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(400);
  await c.shot(dm, "extra-mounted");
  await ops.send({ t: "room.setPlayerScene", sceneId: c.state.crypt });
  await dm.waitForTimeout(800);
  return { mara: [mara.x, mara.y, mara.attached], horse: [horse.x, horse.y], text: (await dm.locator('[role="tabpanel"]').first().innerText()).slice(0, 900) };
};
