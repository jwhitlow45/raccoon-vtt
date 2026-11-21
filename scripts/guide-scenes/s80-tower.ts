import { uuidv7 as randomUUID } from "../../shared/ids.ts";
export default async (c: any) => {
  const ops = c.state.ops;
  const sceneId = randomUUID();
  c.state.tower = sceneId;
  await ops.send({ t: "scene.create", scene: { id: sceneId, name: "Watchtower", bounds: { w: 30, h: 20 }, background: "#141418", grid: { show: true, color: "#ffffff", opacity: 0.15, lineWidth: 1 }, autoWalls: "off", fogEnabled: false, blockMovement: true } });
  await ops.send({ t: "build.rect", sceneId, terrain: "grass", x: 0, y: 0, w: 30, h: 20 });
  // The rise: dirt, 10 ft up.
  const rise: string[] = [];
  for (let x = 14; x < 25; x++) for (let y = 4; y < 15; y++) rise.push(`${x},${y}`);
  await ops.send({ t: "build.paint", sceneId, terrain: "dirt", cells: rise });
  await ops.send({ t: "build.height", sceneId, cells: rise, height: 10 });
  // The tower top: stone, 30 ft up.
  const top: string[] = [];
  for (let x = 18; x < 22; x++) for (let y = 7; y < 11; y++) top.push(`${x},${y}`);
  await ops.send({ t: "build.paint", sceneId, terrain: "stone", cells: top });
  await ops.send({ t: "build.height", sceneId, cells: top, height: 30 });
  // A stair up the rise from the west, and a stepped stair up the tower.
  await ops.send({ t: "build.stairs", sceneId, cells: ["13,9", "13,10"], up: "e" });
  await ops.send({ t: "build.height", sceneId, cells: ["17,8"], height: 15 });
  await ops.send({ t: "build.height", sceneId, cells: ["17,9"], height: 20 });
  await ops.send({ t: "build.height", sceneId, cells: ["17,10"], height: 25 });
  await ops.send({ t: "build.stairs", sceneId, cells: ["17,8", "17,9", "17,10"], up: "a" });
  let z = 1;
  const stamp = (key: string, x: number, y: number, s = 2) => ({ id: randomUUID(), art: { key }, x, y, w: s, h: s, rotation: 0, z: z++, visibility: "all" });
  await ops.send({ t: "build.stamps", sceneId, put: [stamp("tree-1", 3, 3, 4), stamp("tree-4", 7, 15, 3), stamp("tree-9", 27, 4, 3), stamp("bush-2", 10, 6, 2), stamp("rocks-2", 26, 16, 2), stamp("young-pine", 4, 12, 2), stamp("campfire", 22.5, 12.5, 1.5)] });
  return { sceneId };
};
