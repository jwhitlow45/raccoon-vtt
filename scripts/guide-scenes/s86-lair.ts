import { uuidv7 as randomUUID } from "../../shared/ids.ts";
export default async (c: any) => {
  const ops = c.state.ops;
  const sceneId = randomUUID();
  c.state.lair = sceneId;
  await ops.send({ t: "scene.create", scene: { id: sceneId, name: "Dragon's lair", bounds: { w: 30, h: 20 }, background: "#141418", grid: { show: true, color: "#ffffff", opacity: 0.15, lineWidth: 1 }, fogEnabled: false, blockMovement: true } });
  await ops.send({ t: "build.poly", sceneId, terrain: "cave", points: [2, 6, 8, 2, 20, 2, 27, 5, 28, 13, 23, 18, 10, 18, 3, 15] });
  const rubble: string[] = [];
  for (const [x, y] of [[6, 6], [7, 6], [6, 7], [22, 15], [23, 15], [23, 14], [12, 4], [13, 4]]) rubble.push(`${x},${y}`);
  await ops.send({ t: "build.paint", sceneId, terrain: "rubble", cells: rubble });
  const pit: string[] = [];
  for (let x = 19; x < 23; x++) for (let y = 7; y < 10; y++) pit.push(`${x},${y}`);
  await ops.send({ t: "build.paint", sceneId, terrain: "water", cells: pit });
  let z = 1;
  const stamp = (key: string, x: number, y: number, s = 1, rot = 0) => ({ id: randomUUID(), art: { key }, x, y, w: s, h: s, rotation: rot, z: z++, visibility: "all" });
  await ops.send({ t: "build.stamps", sceneId, put: [stamp("chest", 24.5, 11.5), stamp("chest", 25.5, 12.5, 1, 30), stamp("rocks-1", 9, 15, 2), stamp("rock-3", 16, 3.5, 1.5), stamp("campfire-embers", 15.5, 9.5, 1.5)] });
  return sceneId;
};
