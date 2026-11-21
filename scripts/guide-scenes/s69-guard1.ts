// Spirit Guardians on the forest road, as the guide's scenario tells it: Bree wades in among the goblins after the
// ambush, and Goblin Warrior 1, back on its feet for the picture, steps away to walk into the aura on its turn.
// s69-guard3 puts everything back. This step moves them and gives Bree Concentrating from her Token panel.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const ops = c.state.ops;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.forest);
  const toks = Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.forest) as any[];
  const gw1 = toks.find((t) => t.name === "Goblin Warrior" && t.number === 1);
  const bree = st.tokens[c.state.forestPcs.bree];
  c.state.guard = { gw1: gw1.id, gw1From: { x: gw1.x, y: gw1.y }, breeFrom: { x: bree.x, y: bree.y } };
  await ops.send({ t: "actor.hp", target: { tokenId: gw1.id }, change: { kind: "heal", amount: 10 } });
  await ops.send({ t: "token.move", tokenId: gw1.id, x: 6, y: 6 });
  await ops.send({ t: "token.move", tokenId: bree.id, x: 12, y: 7 });
  await dm.waitForTimeout(600);
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  await c.harness.tapCell(dm, b, { x: 12, y: 7 });
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Details", exact: true }).first().click();
  await dm.waitForTimeout(800);
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("button", { name: "Add", exact: true }).first().click();
  await dm.waitForTimeout(400);
  await panel.getByRole("button", { name: /^Concentrating/ }).first().click();
  await dm.waitForTimeout(400);
  await panel.getByLabel("Spell").fill("Spirit Guardians");
  await panel.getByRole("button", { name: "Add", exact: true }).last().click();
  await dm.waitForTimeout(600);
  const after = await roomState(c, c.state.forest);
  return { gw1: after.tokens[gw1.id] ? { x: after.tokens[gw1.id].x, y: after.tokens[gw1.id].y } : null, from: c.state.guard };
};
