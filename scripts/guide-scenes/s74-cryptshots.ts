export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.crypt);
  const skel = Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.crypt && t.name === "Skeleton") as any[];
  const spots = [[17, 8], [21, 9], [18, 12]];
  for (let i = 0; i < skel.length; i++) await c.state.ops.send({ t: "token.move", tokenId: skel[i].id, x: spots[i]![0], y: spots[i]![1] });
  c.state.skeletons = skel.map((s) => s.id);
  // Vision settings in the Scenes panel.
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(500);
  // The vision settings are the Fog and vision group.
  const { rowsIntoView } = await import(`./lib.ts?t=${Date.now()}`);
  await rowsIntoView(dm, "^Fog and vision$");
  await dm.waitForTimeout(400);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-vision-settings");
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  const i = Math.max(0, t.search(/Fog and vision/i));
  return t.slice(i, i + 900);
};
