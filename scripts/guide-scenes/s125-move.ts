// MV-SHOT-1: in the crypt, two squares of difficult ground in the corridor, and Mara dragged from the hall's lower half
// to the corridor's far end. The walk bends at the corridor's mouth and the label names the terrain's extra.
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const b = { w: 30, h: 20 };
  const crypt = c.state.crypt;
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await c.harness.pickTool(dm, "Select");
  await ops.send({ t: "build.rough", sceneId: crypt, cells: ["10,9", "11,9"], on: true });
  await ops.send({ t: "door.set", sceneId: crypt, door: { edge: "8,9,w" }, state: "open" }).catch(() => {});
  await ops.send({ t: "token.move", tokenId: c.state.cryptPcs.ivo, x: 2, y: 8 });
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, crypt);
  const byName = (n: string) => (Object.values(st.tokens) as any[]).find((t) => t.sceneId === crypt && t.name === n)?.id;
  c.state.cryptThorn = byName("Thorn");
  await ops.send({ t: "token.move", tokenId: c.state.cryptThorn, x: 15, y: 13 });
  await ops.send({ t: "token.move", tokenId: c.state.cryptPcs.mara, x: 5, y: 11 });
  const mara = (st.characters as any)[c.state.chars.mara] ?? (Object.values(st.characters) as any[]).find((ch) => ch.name === "Mara");
  for (const e of mara.actor.effects) await ops.send({ t: "actor.effect.remove", target: { characterId: mara.id }, effectId: e.id });
  await c.harness.openSideTab(dm, "Initiative");
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("0");
  await dm.waitForTimeout(800);
  const mid = await c.harness.pagePoint(dm, b, { x: 3, y: 10 });
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 2; i++) { await dm.mouse.wheel(0, -120); await dm.waitForTimeout(150); }
  await dm.waitForTimeout(800);
  const a = await c.harness.pagePoint(dm, b, { x: 5.5, y: 11.5 });
  const z = await c.harness.pagePoint(dm, b, { x: 12.5, y: 9.5 });
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + 5, a.y, { steps: 3 });
  await dm.mouse.move(z.x, z.y, { steps: 20 });
  await dm.waitForTimeout(900);
  await c.shot(dm, "mv-movement");
  const label = (await dm.locator("body").innerText()).slice(0, 300);
  await dm.keyboard.press("Escape");
  await dm.mouse.up();
  await dm.waitForTimeout(500);
  await ops.send({ t: "token.move", tokenId: c.state.cryptPcs.mara, x: 5, y: 11 }).catch(() => {});
  return label;
};
