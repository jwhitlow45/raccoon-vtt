export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  let st = await roomState(c, c.state.lair);
  const dragon = Object.values(st.tokens).find((t: any) => t.sceneId === c.state.lair && t.name === "Adult Red Dragon") as any;
  c.state.dragon = dragon.id;
  await c.harness.openSideTab(dm, "Initiative");
  await dm.getByRole("button", { name: /^Everyone here/ }).click();
  await dm.waitForTimeout(1200);
  st = await roomState(c, c.state.lair);
  const vals: Record<string, number> = { Thorn: 14, Bree: 9, Mara: 19, Ivo: 12 };
  for (const e of st.encounter.entries) {
    const tok = st.tokens[e.tokenId];
    if (tok && vals[tok.name] !== undefined) await c.state.ops.send({ t: "encounter.setValue", entryId: e.id, value: vals[tok.name] });
    if (tok?.name === "Adult Red Dragon") await c.state.ops.send({ t: "encounter.setValue", entryId: e.id, value: 22 });
  }
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Start", exact: true }).first().click();
  await dm.waitForTimeout(1000);
  return dragon.legendary ?? dragon.actor?.inline?.legendary ?? "no legendary field";
};
