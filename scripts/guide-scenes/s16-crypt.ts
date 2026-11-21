import { uuidv7 as randomUUID } from "../../shared/ids.ts";
// The crypt: a builder scene with rooms, a corridor, doors, a secret door, pillars and lights, dark, with party vision.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.pickTool(dm, "Select").catch(() => {});
  const ops = c.state.ops;
  const sceneId = randomUUID();
  c.state.crypt = sceneId;
  await ops.send({
    t: "scene.create",
    scene: { id: sceneId, name: "Crypt", bounds: { w: 30, h: 20 }, background: "#141418", grid: { show: true, color: "#ffffff", opacity: 0.15, lineWidth: 1 }, fogEnabled: true, blockMovement: true, vision: { on: true, light: "dark" } },
  });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 1, y: 7, w: 7, h: 6 });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 8, y: 9, w: 6, h: 1 });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 14, y: 4, w: 10, h: 11 });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 24, y: 9, w: 1, h: 1 });
  await ops.send({ t: "build.rect", sceneId, terrain: "wood", x: 25, y: 7, w: 4, h: 5 });
  await ops.send({ t: "build.paint", sceneId, terrain: "pillar", cells: ["16,6", "21,6", "16,12", "21,12"] });
  await ops.send({ t: "build.paint", sceneId, terrain: "rubble", cells: ["2,11", "3,11", "2,12"] });
  await ops.send({
    t: "build.edge",
    sceneId,
    edges: [
      { key: "8,9,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } },
      { key: "14,9,w", feature: { kind: "door", state: "locked", secret: false, discovered: false } },
      { key: "24,9,w", feature: { kind: "door", state: "closed", secret: true, discovered: false } },
    ],
  });
  let z = 1;
  const stamp = (key: string, x: number, y: number, w = 1, h = 1, rot = 0, visibility = "all") => ({ id: randomUUID(), art: { key }, x, y, w, h, rotation: rot, z: z++, visibility });
  await ops.send({
    t: "build.stamps",
    sceneId,
    put: [
      stamp("table", 18.5, 9.5, 3, 2), stamp("barrel", 2.5, 7.5), stamp("crate", 3.5, 7.5), stamp("chest", 27.5, 8.5, 1, 1, 0, "dm"),
      stamp("bookshelf", 26.5, 7.5, 2, 1), stamp("bed", 27.5, 10.5, 1, 2), stamp("bucket", 6.5, 12.5),
    ],
  });
  await ops.send({
    t: "build.lights",
    sceneId,
    put: [
      { id: randomUUID(), x: 4.5, y: 9.5, bright: 20, dim: 20, on: true, walls: true, label: "Torch" },
      { id: randomUUID(), x: 18.5, y: 5, bright: 10, dim: 10, on: false, walls: true, label: "Brazier" },
      { id: randomUUID(), x: 18.5, y: 14, bright: 10, dim: 10, on: false, walls: true, label: "Brazier" },
      { id: randomUUID(), x: 27, y: 9.5, bright: 5, dim: 5, on: true, walls: true, label: "Candle" },
    ],
  });
  await ops.send({ t: "build.label", sceneId, labelId: randomUUID(), label: { x: 19, y: 3.5, text: "Crypt of the Ash Rider", size: 0.7 } });
  return { sceneId };
};
