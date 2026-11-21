export default async (c: any) => {
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.forest);
  const owl = Object.values(st.tokens).find((t: any) => t.name === "Hoot") as any;
  const inFight = st.encounter.entries.some((e: any) => e.tokenId === owl?.id);
  c.state.owl = owl?.id;
  const dm = c.state.dm;
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  return { owl: owl && { id: owl.id, x: owl.x, y: owl.y, companion: owl.companion, size: owl.size }, inFight, panel: t.slice(0, 400) };
};
