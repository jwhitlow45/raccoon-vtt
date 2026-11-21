import { uuidv7 as randomUUID } from "../../shared/ids.ts";
// guidepass6: the Hex keep, a battle mat on hex rows built with wall lines: a hall with a 10 ft terrace and a stair,
// a corridor one hex wide behind a door, and a chamber. Thorn rides a warhorse in the hall, Bree and Mara beside him,
// a goblin waits in the chamber. Everything is the app's own: walls, heights and tokens laid out by ops.
const W = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export default async (c: any) => {
  const { placedOnHex } = await import(`${W}/shared/rules/footprint.ts`);
  const { hexCorners, cornerAt, hexNeighbors, sceneHexes } = await import(`${W}/shared/rules/hex.ts`);
  const { actor } = await import(`./lib.ts?t=${Date.now()}`);
  const G = { shape: "hex", orient: "rows" };
  const bounds = { w: 30, h: 20 };
  const ops = c.state.ops;
  const dm = c.state.dm;
  const sceneId = randomUUID();
  c.state.hexKeep = sceneId;
  await ops.send({
    t: "scene.create",
    scene: { id: sceneId, name: "Hex keep", bounds, background: "#2a2a30", gridShape: "hexRows", grid: { show: true, color: "#ffffff", opacity: 0.18, lineWidth: 1 }, fogEnabled: false, blockMovement: true },
  });
  const hall = (h: any) => h.col >= 2 && h.col <= 11 && h.row >= 3 && h.row <= 16;
  const corridor = (h: any) => h.row === 10 && h.col >= 12 && h.col <= 18;
  const chamber = (h: any) => h.col >= 19 && h.col <= 27 && h.row >= 5 && h.row <= 15;
  const open = (h: any) => hall(h) || corridor(h) || chamber(h);
  let n = 0;
  const wall = (a: any, b: any, f: any = { kind: "wall" }) => ({ id: `gpk${String(n++).padStart(9, "0")}`, a: [a.x, a.y], b: [b.x, b.y], f });
  const side = (h: any, d: number, f?: any) => {
    const k = hexCorners(G, h);
    return wall(cornerAt(G, k[(d + 1) % 6]), cornerAt(G, k[(d + 2) % 6]), f);
  };
  const walls: any[] = [];
  for (const h of sceneHexes(G, bounds)) {
    if (open(h)) continue;
    hexNeighbors(G, h).forEach((nb: any, d: number) => {
      if (open(nb)) walls.push(side(h, d));
    });
  }
  // An open door across the corridor's west mouth, where the hall's last hex meets the corridor's first.
  walls.push(side({ col: 11, row: 10 }, 0, { kind: "door", state: "open", secret: false, discovered: false }));
  for (let i = 0; i < walls.length; i += 100) await ops.send({ t: "build.walls", sceneId, put: walls.slice(i, i + 100) });
  // The terrace in the hall's north-west corner, 10 ft up, and a stair climbing west onto it.
  const terrace: string[] = [];
  for (let col = 2; col <= 5; col++) for (let row = 3; row <= 6; row++) terrace.push(`${col},${row}`);
  await ops.send({ t: "build.height", sceneId, cells: terrace, height: 10 });
  await ops.send({ t: "build.height", sceneId, cells: ["6,5"], height: 5 });
  await ops.send({ t: "build.stairs", sceneId, cells: ["6,5"], up: "3" });
  await ops.send({ t: "build.lights", sceneId, put: [{ id: randomUUID(), x: 3.5, y: 4, bright: 20, dim: 20, on: true, walls: true, label: "Lantern" }] });
  const at = (size: string, col: number, row: number) => placedOnHex(G, { size, x: 0, y: 0 }, { col, row });
  const pc = async (key: string, col: number, row: number, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await ops.send({ t: "token.create", token: { id, sceneId, kind: "pc", name: key[0]!.toUpperCase() + key.slice(1), size: "medium", ...at("medium", col, row), disposition: "ally", visibility: "all", actor: { ref: c.state.chars[key] }, image: c.state.icons?.[key], ...extra } });
    return id;
  };
  const ids: Record<string, string> = {};
  ids.horse = randomUUID();
  await ops.send({ t: "token.create", token: { id: ids.horse, sceneId, kind: "npc", name: "Warhorse", size: "large", ...at("large", 8, 10), disposition: "ally", visibility: "all", image: { icon: "skoll/chess-knight", color: "#ad7f58" }, actor: { inline: actor(19, 11, { speeds: { walk: 60 } }) } } });
  ids.thorn = await pc("thorn", 7, 11, { light: { bright: 20, dim: 20 } });
  const seat = at("medium", 8, 10);
  await ops.send({ t: "token.attach", tokenId: ids.thorn, to: ids.horse, kind: "ride", steer: true, x: seat.x, y: seat.y, elevation: 0 });
  ids.bree = await pc("bree", 6, 12);
  ids.mara = await pc("mara", 4, 5, { elevation: 10 });
  ids.goblin = randomUUID();
  await ops.send({ t: "token.create", token: { id: ids.goblin, sceneId, kind: "monster", name: "Goblin Warrior", size: "small", ...at("small", 24, 10), disposition: "hostile", visibility: "all", image: { icon: "delapouite/goblin-head", color: "#e93d82" }, actor: { inline: actor(10, 15) } } });
  c.state.hexKeepIds = ids;
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  await dm.getByText("Hex keep", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  return { walls: walls.length, ids };
};
