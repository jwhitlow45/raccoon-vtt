// TR-SHOT-1, the card: Thorn walks from the corridor through the chamber's door towards the table, and the Hidden Pit
// stops him where he stands wholly over it, opens and drops him 30 ft. The DM's toast and card come in.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  await dm.waitForTimeout(300);
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
  await c.shot(dm, "tr-card-toast");
  await dm.waitForTimeout(5000);
  await c.shot(dm, "tr-card");
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.crypt);
  const t = st.tokens[c.state.cryptThorn];
  return { thorn: [t.x, t.y, t.elevation], trap: st.traps?.[c.state.pit]?.state, card: await dm.getByRole("group", { name: "Hidden Pit went off" }).first().innerText().catch(() => "no card") };
};
