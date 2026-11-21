// Deletes the Forest clearing scene s119 made, and puts the DM back on the Select tool.
export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState, sceneByName } = await import(`./lib.ts?t=${Date.now()}`);
  const scene = sceneByName(await roomState(c), "Forest clearing");
  if (scene) await c.state.ops.send({ t: "scene.delete", sceneId: scene.id });
  await dm.waitForTimeout(800);
  await c.harness.pickTool(dm, "Select").catch(() => {});
  return scene ? `deleted ${scene.id}` : "no scene";
};
