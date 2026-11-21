export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.forest);
  const enc = st.encounter;
  const vals: Record<string, number> = { Thorn: 9, Bree: 6, Mara: 17, Ivo: 11 };
  const out: string[] = [];
  for (const e of enc.entries ?? Object.values(enc.entriesById ?? {})) {
    const tok = st.tokens[e.tokenId];
    const name = tok?.name;
    if (name && vals[name] !== undefined) {
      await c.state.ops.send({ t: "encounter.setValue", entryId: e.id, value: vals[name] });
      out.push(`${name}=${vals[name]}`);
    }
  }
  // A fight now rolls the monsters' Initiative as it starts, so the button is off unless a creature is left unrolled.
  const auto = dm.getByRole("button", { name: /^Auto initiative \(/i });
  if (await auto.isEnabled()) await auto.click();
  await dm.waitForTimeout(2500);
  // The monsters' rolls set to the order the later steps follow (the warriors, the wolves, then the boss after Ivo),
  // so every run takes the same turns.
  const rolled = await roomState(c, c.state.forest);
  const fixed = (name: string) => (/^Goblin Warrior/.test(name) ? 22 : /^Wolf/.test(name) ? 20 : name === "Goblin Boss" ? 11 : undefined);
  for (const e of rolled.encounter.entries) {
    const value = fixed(rolled.tokens[e.tokenId]?.name ?? "");
    if (value !== undefined) await c.state.ops.send({ t: "encounter.setValue", entryId: e.id, value });
  }
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-auto");
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  return out.join(" ") + "\n" + t.slice(0, 1800) + "\nkeys:" + Object.keys(enc).join(",");
};
