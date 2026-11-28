// A fight with Goblin Warrior 1 first: it walks into the aura, and the picture is taken while the reminder's notice
// shows. Then the fight ends, the aura and Bree's Concentrating go, and Bree and the goblin are put back as they were.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const ops = c.state.ops;
  const g = c.state.guard;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  await c.harness.openSideTab(dm, "Initiative");
  await dm.getByRole("button", { name: /^Everyone here/ }).click();
  await dm.waitForTimeout(1000);
  let st = await roomState(c, c.state.forest);
  for (const e of st.encounter.entries) {
    const tok = st.tokens[e.tokenId];
    await ops.send({ t: "encounter.setValue", entryId: e.id, value: e.tokenId === g.gw1 ? 20 : tok?.kind === "monster" ? 8 : 12 });
  }
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Start", exact: true }).first().click();
  await dm.waitForTimeout(800);
  await c.harness.openSideTab(dm, "Areas");
  await c.harness.dragWorld(dm, b, { x: 6.5, y: 6.5 }, { x: 10.5, y: 7.5 });
  await dm.waitForTimeout(1500);
  const body = await dm.locator("body").innerText();
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-guardians");
  const areas = (await dm.locator('[role="tabpanel"]').first().innerText()).slice(0, 300);

  await c.harness.openSideTab(dm, "Initiative");
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("button", { name: "End the fight" }).click();
  await panel.getByRole("button", { name: /(?:Tap|Click) again/ }).first().click();
  await dm.waitForTimeout(500);
  st = await roomState(c, c.state.forest);
  for (const t of Object.values(st.templates) as any[]) if (t.sceneId === c.state.forest) await ops.send({ t: "template.delete", templateId: t.id });
  const ch = st.characters[c.state.chars.bree];
  for (const e of ch?.actor?.effects ?? []) if (JSON.stringify(e).includes("oncentrat")) await ops.send({ t: "actor.effect.remove", target: { characterId: c.state.chars.bree }, effectId: e.id });
  await ops.send({ t: "token.move", tokenId: c.state.forestPcs.bree, x: g.breeFrom.x, y: g.breeFrom.y });
  await ops.send({ t: "token.move", tokenId: g.gw1, x: g.gw1From.x, y: g.gw1From.y });
  await ops.send({ t: "actor.hp", target: { tokenId: g.gw1 }, change: { kind: "damage", amount: 10 } });
  await dm.waitForTimeout(800);
  const end = await roomState(c, c.state.forest);
  const gw1 = end.tokens[g.gw1];
  return [(body.match(/[^\n]*entered Spirit Guardians[^\n]*/g) ?? ["no notice"]).join(" | "), areas, `gw1 ${gw1.x},${gw1.y} ${JSON.stringify(gw1.actor?.hp)} ${gw1.actor?.life}`, `templates left ${Object.values(end.templates).filter((t: any) => t.sceneId === c.state.forest).length}`].join("\n");
};
