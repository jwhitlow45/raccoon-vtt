// TR-SHOT-1, the card, as taken: s132's springing was dismissed and taken back by hand (Thorn back in the corridor,
// the pit's four squares at the ground again, the trap armed and unfound), since a reload had cleared the DM's undo.
// Then Thorn walks into it again, framed with the pit below the alerts.
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const b = { w: 30, h: 20 };
  const crypt = c.state.crypt;
  await dm.getByRole("group", { name: "Hidden Pit went off" }).first().getByRole("button", { name: "Dismiss" }).click().catch(() => {});
  await dm.waitForTimeout(600);
  await ops.send({ t: "token.move", tokenId: c.state.cryptThorn, x: 12, y: 9, elevation: 0 });
  await ops.send({ t: "build.height", sceneId: crypt, cells: ["15,9", "16,9", "15,10", "16,10"], height: 0 });
  await ops.send({ t: "trap.update", trapId: c.state.pit, patch: { state: "armed", found: false } });
  await dm.waitForTimeout(800);
  await dm.keyboard.press("0");
  await dm.waitForTimeout(600);
  const mid = await c.harness.pagePoint(dm, b, { x: 12, y: 6 });
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 2; i++) { await dm.mouse.wheel(0, -120); await dm.waitForTimeout(150); }
  await dm.waitForTimeout(800);
  const a = await c.harness.pagePoint(dm, b, { x: 12.5, y: 9.5 });
  const z = await c.harness.pagePoint(dm, b, { x: 18.5, y: 11.5 });
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + 5, a.y, { steps: 3 });
  await dm.mouse.move(z.x, z.y, { steps: 20 });
  await dm.waitForTimeout(600);
  await dm.mouse.up();
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "tr-card");
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, crypt);
  const t = st.tokens[c.state.cryptThorn];
  return { thorn: [t.x, t.y, t.elevation], trap: st.traps[c.state.pit]?.state };
};
