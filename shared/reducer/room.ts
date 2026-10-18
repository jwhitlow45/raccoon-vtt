import { keys } from "../keys.ts";
import type { Scene } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { autoWallsOf } from "../rules/autoWalls.ts";
import { setGridWithPhases, setMapWithPhases, withPhases } from "./phases.ts";
import { forgetExplored } from "./map.ts";
import { invalid, gone, type Tx } from "./tx.ts";
import { deleteToken, sortedById } from "./tokens.ts";

export function roomUpdate(tx: Tx, op: OpOf<"room.update">): void {
  const meta = tx.state.meta;
  tx.write(keys.meta, {
    ...meta,
    name: op.name ?? meta.name,
    settings: op.settings ? { ...meta.settings, ...op.settings } : meta.settings,
  });
}

export function roomSetPlayerScene(tx: Tx, op: OpOf<"room.setPlayerScene">): void {
  tx.scene(op.sceneId);
  tx.write(keys.meta, { ...tx.state.meta, playerSceneId: op.sceneId });
}

export function viewFollow(tx: Tx, op: OpOf<"view.follow">): void {
  const meta = tx.state.meta;
  tx.write(keys.meta, { ...meta, view: { ...meta.view, follow: op.follow } });
}

export function viewBlackout(tx: Tx, op: OpOf<"view.blackout">): void {
  const meta = tx.state.meta;
  tx.write(keys.meta, { ...meta, view: { ...meta.view, blackout: op.blackout } });
}

export function memberUpdate(tx: Tx, op: OpOf<"member.update">): void {
  const member = tx.state.members[op.memberId];
  if (!member) throw gone("member");
  tx.write(keys.member(member.id), { ...member, name: op.name ?? member.name, color: op.color ?? member.color });
}

export function sysMemberJoin(tx: Tx, op: OpOf<"sys.memberJoin">): void {
  if (tx.state.members[op.member.id]) throw invalid("member already exists");
  tx.write(keys.member(op.member.id), { ...op.member, rev: 0 });
  tx.addEvent({ type: "member", memberId: op.member.id, action: "join" });
}

/**
 * A member's roster label changes. A member made a DM reads every journal
 * page, so a page private to them becomes the DM's in the same op, as a
 * removed member's does (sysMemberRemove): the page's pins never go on
 * naming a DM as their reader (docs/design-v1-dm-tools.md 3.7). Rooms with
 * no pages, every room from before wave 5, change exactly as before.
 */
export function sysMemberSetKind(tx: Tx, op: OpOf<"sys.memberSetKind">): void {
  const member = tx.state.members[op.memberId];
  if (!member) throw gone("member");
  if (member.kind === op.kind) return;
  tx.write(keys.member(member.id), { ...member, kind: op.kind });
  if (op.kind === "dm") privatePagesToDm(tx, member.id);
  tx.addEvent({ type: "member", memberId: member.id, action: op.kind === "dm" ? "dm" : "undm" });
}

/** A member's private pages made DM only, in id order so a replay writes the same keys in the same order. */
function privatePagesToDm(tx: Tx, memberId: string): void {
  for (const page of sortedById(Object.values(tx.state.journal))) {
    if (typeof page.access === "object" && page.access.member === memberId) tx.write(keys.journal(page.id), { ...page, access: "dm" });
  }
}

/**
 * A member leaves the roster for good (S-15). Nothing may name it as an
 * owner afterwards: it is dropped from every token's and character's
 * owners, and the drawings and areas it made go with it, since a single
 * owner cannot be cleared and nobody could act as it again. It is dropped
 * from every handout's recipients too, and a handout shown to nobody else
 * closes, since no player could see it and the DM would keep a dead one
 * open. A journal page private to it becomes the DM's (wave 5), and it
 * leaves the lists of who may move any token and who may draw. Its log
 * entries stay, as the record of what happened, and one more says it was
 * removed. Each collection is walked in id order, so a replay touches the
 * same keys in the same order.
 */
export function sysMemberRemove(tx: Tx, op: OpOf<"sys.memberRemove">): void {
  if (!tx.state.members[op.memberId]) throw gone("member");
  const byId = <T extends { id: string }>(items: Iterable<T>): T[] => [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const token of byId(Object.values(tx.state.tokens))) {
    if (token.ownerIds.includes(op.memberId)) tx.write(keys.token(token.id), { ...token, ownerIds: token.ownerIds.filter((m) => m !== op.memberId) });
  }
  for (const character of byId(Object.values(tx.state.characters))) {
    if (character.ownerIds.includes(op.memberId)) {
      tx.write(keys.character(character.id), { ...character, ownerIds: character.ownerIds.filter((m) => m !== op.memberId) });
    }
  }
  for (const template of byId(Object.values(tx.state.templates))) if (template.ownerId === op.memberId) tx.remove(keys.template(template.id));
  for (const drawing of byId(Object.values(tx.state.drawings))) if (drawing.ownerId === op.memberId) tx.remove(keys.drawing(drawing.id));
  for (const handout of byId(Object.values(tx.state.handouts))) {
    if (handout.to === "all" || !handout.to.includes(op.memberId)) continue;
    const to = handout.to.filter((m) => m !== op.memberId);
    if (to.length === 0) tx.remove(keys.handout(handout.id));
    else tx.write(keys.handout(handout.id), { ...handout, to });
  }
  privatePagesToDm(tx, op.memberId);
  const moveAny = tx.state.meta.settings.playersMoveAny;
  if (Array.isArray(moveAny) && moveAny.includes(op.memberId)) {
    const meta = tx.state.meta;
    tx.write(keys.meta, { ...meta, settings: { ...meta.settings, playersMoveAny: moveAny.filter((m) => m !== op.memberId) } });
  }
  const draw = tx.state.meta.settings.playersDraw;
  if (Array.isArray(draw) && draw.includes(op.memberId)) {
    const meta = tx.state.meta;
    tx.write(keys.meta, { ...meta, settings: { ...meta.settings, playersDraw: draw.filter((m) => m !== op.memberId) } });
  }
  tx.remove(keys.member(op.memberId));
  tx.addEvent({ type: "member", memberId: op.memberId, action: "remove" });
}

const DEFAULT_GRID: Scene["grid"] = { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 };
const DEFAULT_BACKGROUND = "#2b2b31";

export function sceneCreate(tx: Tx, op: OpOf<"scene.create">): void {
  const input = op.scene;
  if (tx.state.scenes[input.id]) throw invalid("scene already exists");
  const order = Object.values(tx.state.scenes).reduce((max, s) => Math.max(max, s.order + 1), 0);
  const scene: Scene = {
    id: input.id,
    rev: 0,
    name: input.name,
    order,
    bounds: input.bounds,
    grid: input.grid ?? DEFAULT_GRID,
    background: input.background ?? DEFAULT_BACKGROUND,
    // A map has something to hide, a blank mat does not (design 13.2).
    fogEnabled: input.fogEnabled ?? input.map !== undefined,
    wallsVersion: 0,
  };
  if (input.map) scene.map = input.map;
  if (input.defaultView) scene.defaultView = input.defaultView;
  // Only when the client says so: a stored create from before wave 3 replays as a scene under today's rule ("all").
  if (input.autoWalls !== undefined) scene.autoWalls = input.autoWalls;
  if (input.folder !== undefined) scene.folder = input.folder;
  if (input.blockMovement !== undefined) scene.blockMovement = input.blockMovement;
  if (input.vision !== undefined) {
    scene.vision = input.vision;
    // Only fog remembers what the party explored (docs/design-v1-maps-vision.md 4.3.1).
    if (input.vision.on && input.fogEnabled === undefined) scene.fogEnabled = true;
  }
  if (input.gridFromFile) scene.gridFromFile = true;
  tx.write(keys.scene(scene.id), scene);
}

export function sceneUpdate(tx: Tx, op: OpOf<"scene.update">): void {
  const scene = tx.scene(op.sceneId);
  const next: Scene = { ...scene };
  const p = op.patch;
  if (p.name !== undefined) next.name = p.name;
  if (p.bounds !== undefined) next.bounds = p.bounds;
  if (p.grid !== undefined) next.grid = p.grid;
  if (p.background !== undefined) next.background = p.background;
  if (p.fogEnabled !== undefined) next.fogEnabled = p.fogEnabled;
  if (p.defaultView === null) delete next.defaultView;
  else if (p.defaultView !== undefined) next.defaultView = p.defaultView;
  if (p.folder === null) delete next.folder;
  else if (p.folder !== undefined) next.folder = p.folder;
  if (p.thumb === null) delete next.thumb;
  else if (p.thumb !== undefined) next.thumb = p.thumb;
  if (p.autoWalls !== undefined) {
    next.autoWalls = p.autoWalls;
    // A new rule moves walls on every chunk, so the caches keyed on the version drop them (section 2.1).
    if (autoWallsOf(scene) !== p.autoWalls) next.wallsVersion = scene.wallsVersion + 1;
  }
  if (p.blockMovement !== undefined) next.blockMovement = p.blockMovement;
  if (p.vision !== undefined) {
    next.vision = p.vision;
    // Turning vision on turns fog on, since only fog remembers what the party explored (section 4.3.1). The DM can turn it
    // off again, and a patch that names fog itself decides.
    if (p.vision.on && scene.vision?.on !== true && p.fogEnabled === undefined) next.fogEnabled = true;
  }
  tx.write(keys.scene(scene.id), p.phases !== undefined ? withPhases(next, p.phases) : next);
}

/** Removes a scene and everything on it. The last scene stays, so a room is never empty. */
export function sceneDelete(tx: Tx, op: OpOf<"scene.delete">): void {
  const scene = tx.scene(op.sceneId);
  if (Object.keys(tx.state.scenes).length <= 1) throw invalid("a room needs at least one scene");
  const s = tx.state;
  // By id: removing a token can pause durations, and those log entries must be numbered the same on replay.
  for (const token of sortedById(Object.values(s.tokens))) if (token.sceneId === scene.id) deleteToken(tx, token.id);
  for (const t of Object.values(s.templates)) if (t.sceneId === scene.id) tx.remove(keys.template(t.id));
  for (const d of Object.values(s.drawings)) if (d.sceneId === scene.id) tx.remove(keys.drawing(d.id));
  for (const l of Object.values(s.labels)) if (l.sceneId === scene.id) tx.remove(keys.label(l.id));
  for (const c of Object.values(s.buildChunks)) if (c.sceneId === scene.id) tx.remove(keys.chunk(c.sceneId, c.cx, c.cy));
  for (const f of Object.values(s.fogTiles)) if (f.sceneId === scene.id) tx.remove(keys.fog(f.sceneId, f.tx, f.ty));
  forgetExplored(tx, scene.id);
  if (s.fogDrafts[scene.id]) tx.remove(keys.fogDraft(scene.id));
  for (const st of Object.values(s.stamps)) if (st.sceneId === scene.id) tx.remove(keys.stamp(st.id));
  for (const l of Object.values(s.lights)) if (l.sceneId === scene.id) tx.remove(keys.light(l.id));
  for (const p of Object.values(s.pins)) if (p.sceneId === scene.id) tx.remove(keys.pin(p.id));
  tx.remove(keys.scene(scene.id));
  if (s.meta.playerSceneId === scene.id) {
    const remaining = Object.values(tx.state.scenes).sort((a, b) => a.order - b.order);
    tx.write(keys.meta, { ...tx.state.meta, playerSceneId: remaining[0]?.id ?? null });
  }
}

export function sceneReorder(tx: Tx, op: OpOf<"scene.reorder">): void {
  const seen = new Set<string>();
  op.order.forEach((id, index) => {
    if (seen.has(id)) throw invalid("duplicate scene in order");
    seen.add(id);
    const scene = tx.scene(id);
    if (scene.order !== index) tx.write(keys.scene(id), { ...scene, order: index });
  });
}

export function sceneSetMap(tx: Tx, op: OpOf<"scene.setMap">): void {
  const scene = tx.scene(op.sceneId);
  if (scene.phases) {
    tx.write(keys.scene(scene.id), setMapWithPhases(scene, op.map));
    return;
  }
  const next: Scene = { ...scene };
  if (op.map === null) delete next.map;
  else next.map = op.map;
  tx.write(keys.scene(scene.id), next);
}

export function sceneSetGrid(tx: Tx, op: OpOf<"scene.setGrid">): void {
  const scene = tx.scene(op.sceneId);
  if (!scene.map) throw invalid("the scene has no map to align");
  if (scene.phases) {
    tx.write(keys.scene(scene.id), setGridWithPhases(scene, op));
    return;
  }
  tx.write(keys.scene(scene.id), { ...scene, map: { ...scene.map, cellPx: op.cellPx, originPx: op.originPx } });
}
