import { uuidv7 as randomUUID } from "../../shared/ids.ts";
// guidepass6: the Narrow way, a battle mat on squares with a hall, a corridor one square wide, a corridor two squares
// wide and a far room. Thorn rides a warhorse that drags a goblin, and Bree, Mara, Ivo and Wren ride an elephant.
// Everything is laid out by ops: rooms, automatic walls, tokens and links.
export default async (c: any) => {
  const { actor, roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const ops = c.state.ops;
  const dm = c.state.dm;
  // A rerun drops the scene an earlier run made first.
  if (c.state.narrow) await ops.send({ t: "scene.delete", sceneId: c.state.narrow }).catch(() => {});
  const sceneId = randomUUID();
  c.state.narrow = sceneId;
  await ops.send({
    t: "scene.create",
    scene: { id: sceneId, name: "Narrow way", bounds: { w: 28, h: 14 }, background: "#202026", grid: { show: true, color: "#ffffff", opacity: 0.15, lineWidth: 1 }, fogEnabled: false, blockMovement: true },
  });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 1, y: 1, w: 9, h: 12 });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 10, y: 4, w: 10, h: 1 });
  await ops.send({ t: "build.rect", sceneId, terrain: "stone", x: 10, y: 8, w: 10, h: 2 });
  await ops.send({ t: "build.rect", sceneId, terrain: "wood", x: 20, y: 1, w: 7, h: 12 });
  // Wren is no character in this room, so she rides as an NPC of her own.
  const pc = async (key: string, x: number, y: number) => {
    const id = randomUUID();
    const who = key === "wren"
      ? { kind: "npc", actor: { inline: actor(36, 14) }, image: { icon: "delapouite/woman-elf-face", color: "#15803d" } }
      : { kind: "pc", actor: { ref: c.state.chars[key] }, image: c.state.icons[key] };
    await ops.send({ t: "token.create", token: { id, sceneId, name: key[0]!.toUpperCase() + key.slice(1), size: "medium", x, y, disposition: "ally", visibility: "all", ...who } });
    return id;
  };
  const ids: Record<string, string> = {};
  ids.horse = randomUUID();
  await ops.send({ t: "token.create", token: { id: ids.horse, sceneId, kind: "npc", name: "Warhorse", size: "large", x: 6, y: 3, disposition: "ally", visibility: "all", image: { icon: "skoll/chess-knight", color: "#ad7f58" }, actor: { inline: actor(19, 11, { speeds: { walk: 60 } }) } } });
  ids.thorn = await pc("thorn", 6, 3);
  await ops.send({ t: "token.attach", tokenId: ids.thorn, to: ids.horse, kind: "ride", steer: true, x: 7, y: 3, elevation: 0 });
  ids.goblin = randomUUID();
  await ops.send({ t: "token.create", token: { id: ids.goblin, sceneId, kind: "monster", name: "Goblin Warrior", size: "small", x: 5, y: 4, disposition: "hostile", visibility: "all", image: { icon: "delapouite/goblin-head", color: "#e93d82" }, actor: { inline: actor(10, 15) } } });
  await ops.send({ t: "token.attach", tokenId: ids.goblin, to: ids.horse, kind: "drag", x: 5, y: 4, elevation: 0 });
  ids.elephant = randomUUID();
  await ops.send({ t: "token.create", token: { id: ids.elephant, sceneId, kind: "npc", name: "Elephant", size: "huge", x: 3, y: 7, disposition: "ally", visibility: "all", image: { icon: "delapouite/elephant", color: "#6b7280" }, actor: { inline: actor(76, 12, { speeds: { walk: 40 } }) } } });
  const seats: Record<string, [number, number]> = { bree: [3, 7], mara: [5, 7], ivo: [3, 9], wren: [5, 9] };
  for (const [k, [x, y]] of Object.entries(seats)) {
    ids[k] = await pc(k, x, y);
    await ops.send({ t: "token.attach", tokenId: ids[k], to: ids.elephant, kind: "ride", x, y, elevation: 0 });
  }
  c.state.narrowIds = ids;
  if (!(await dm.getByRole("tablist", { name: "Panels" }).count())) {
    await dm.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).first().click();
    await dm.waitForTimeout(600);
  }
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  await dm.getByText("Narrow way", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  const st = await roomState(c, sceneId);
  return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, [st.tokens[id]?.x, st.tokens[id]?.y, st.tokens[id]?.attached ?? null]]));
};
