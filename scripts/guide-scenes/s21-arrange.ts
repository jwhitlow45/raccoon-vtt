export default async (c: any) => {
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.forest);
  const toks = Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.forest && t.kind === "monster") as any[];
  const spots: Record<string, [number, number]> = {
    "Goblin Warrior 1": [8, 7], "Goblin Warrior 2": [11, 6], "Goblin Warrior 3": [14, 5], "Goblin Warrior 4": [17, 5],
    "Goblin Boss": [12, 4], "Wolf 1": [9, 15], "Wolf 2": [12, 14],
  };
  const out: string[] = [];
  c.state.ambush = {};
  for (const t of toks) {
    const name = t.number ? `${t.name} ${t.number}` : t.name;
    c.state.ambush[name] = t.id;
    const s = spots[name];
    out.push(`${name} ${t.x},${t.y} vis=${t.visibility}`);
    if (s) await c.state.ops.send({ t: "token.move", tokenId: t.id, x: s[0], y: s[1] });
    // The ambush starts with every creature hidden, however the placement left the first one.
    if (t.visibility !== "dm") await c.state.ops.send({ t: "token.update", tokenId: t.id, patch: { visibility: "dm" } });
  }
  return out;
};
