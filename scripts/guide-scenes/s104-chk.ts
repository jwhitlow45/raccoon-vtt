export default async (c: any) => {
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.forest);
  return Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.forest && (t.kind === "pc" || t.companion)).map((t: any) => `${t.name} ${t.kind}`);
};
