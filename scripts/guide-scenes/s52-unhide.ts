export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("switch", { name: /^(Row hidden|Hidden) from players/ }).or(panel.getByRole("checkbox", { name: /^(Row hidden|Hidden) from players/ })).first().click();
  await dm.waitForTimeout(600);
  await panel.getByRole("button", { name: "Goblin Boss options" }).click();
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.forest);
  const out: string[] = [];
  for (const e of st.encounter.entries) {
    const tok = st.tokens[e.tokenId];
    if (e.hidden && tok && tok.name.startsWith("Goblin")) {
      await c.state.ops.send({ t: "encounter.update", entryId: e.id, patch: { hidden: false } });
      out.push(`${tok.name} ${tok.number}`);
    }
    if (tok?.name === "Goblin Boss") out.push(`boss hidden=${e.hidden}`);
  }
  await dm.waitForTimeout(800);
  return out.join(", ");
};
