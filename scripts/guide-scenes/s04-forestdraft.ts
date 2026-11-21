import { uuidv7 as randomUUID } from "../../shared/ids.ts";
// A forest road built with the map builder, to export as an image for the map-image scene.
export default async (c: any) => {
  const ops = c.state.ops;
  const sceneId = randomUUID();
  c.state.forestDraft = sceneId;
  await ops.send({ t: "scene.create", scene: { id: sceneId, name: "Forest road (builder)", bounds: { w: 30, h: 20 }, background: "#1b1b20", autoWalls: "off", fogEnabled: false } });
  await ops.send({ t: "build.rect", sceneId, terrain: "grass", x: 0, y: 0, w: 30, h: 20 });
  // A road that bends: three dirt bands.
  const road: string[] = [];
  for (let x = 0; x < 30; x++) {
    const mid = x < 10 ? 11 : x < 20 ? 11 - Math.round((x - 10) * 0.4) : 7;
    for (let y = mid - 1; y <= mid + 1; y++) road.push(`${x},${y}`);
  }
  await ops.send({ t: "build.paint", sceneId, terrain: "dirt", cells: road });
  // A stream along the bottom edge.
  const water: string[] = [];
  for (let x = 0; x < 30; x++) for (let y = 18; y < 20; y++) if (!(x > 12 && x < 15 && y === 18)) water.push(`${x},${y}`);
  await ops.send({ t: "build.paint", sceneId, terrain: "water", cells: water });
  const difficult: string[] = [];
  for (const [x, y] of [[4, 4], [5, 4], [5, 5], [22, 13], [23, 13], [23, 14], [24, 14]]) difficult.push(`${x},${y}`);
  await ops.send({ t: "build.paint", sceneId, terrain: "difficult", cells: difficult });
  let z = 1;
  const stamp = (key: string, x: number, y: number, s = 2, rot = 0) => ({ id: randomUUID(), art: { key }, x, y, w: s, h: s, rotation: rot, z: z++, visibility: "all" });
  const stamps = [
    stamp("tree-1", 2, 2, 4), stamp("tree-3", 7, 3, 3), stamp("tree-5", 12, 2, 4), stamp("tree-2", 17, 1.5, 3), stamp("tree-7", 21, 3, 4),
    stamp("tree-4", 26, 2, 3), stamp("young-pine", 28, 4.5, 2), stamp("tree-8", 3, 15, 4), stamp("tree-9", 8, 16, 3), stamp("tree-6", 18, 15, 4),
    stamp("tree-10", 26, 14, 4), stamp("young-pine", 14, 14.5, 2), stamp("young-pine", 23, 10.5, 2),
    stamp("bush-1", 9.5, 6.5, 2), stamp("bush-3", 15, 5.5, 2), stamp("bush-2", 19, 11.5, 2), stamp("bush-4", 4.5, 9, 1.5), stamp("ferns-1", 11, 14, 2),
    stamp("ferns-2", 24.5, 5.5, 2), stamp("mossy-rock-1", 16.5, 8.5, 1.5), stamp("rocks-1", 6, 13, 2), stamp("rock-2", 21, 16.5, 1.5),
    stamp("woodpile-long", 13, 7.6, 3, 10), stamp("wheel", 27.5, 9.5, 1, 30),
  ];
  await ops.send({ t: "build.stamps", sceneId, put: stamps });
  return { sceneId };
};
