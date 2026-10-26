import { keys } from "../keys.ts";
import type { Encounter, GridShape, MemberId, PathStop, RoomSettings, Scene, SceneVision, TurnStart } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { autoWallsOf } from "../rules/autoWalls.ts";
import { HEX_ORIGIN, OWN_SQUARE_GRID, gridOfShape, hexOriginBefore, switchRefusal } from "../rules/grid.ts";
import { setGridWithPhases, setMapWithPhases, withPhases } from "./phases.ts";
import { forgetExplored, forgetHolder } from "./map.ts";
import { invalid, gone, type Tx } from "./tx.ts";
import { deleteToken, sortedById } from "./tokens.ts";

export function roomUpdate(tx: Tx, op: OpOf<"room.update">): void {
  const meta = tx.state.meta;
  tx.write(keys.meta, {
    ...meta,
    name: op.name ?? meta.name,
    settings: op.settings ? patchedSettings(meta.settings, op.settings) : meta.settings,
  });
}

/** Settings after a patch. New scenes on "squares" is stored as no setting, as every room from before it has. */
function patchedSettings(settings: RoomSettings, patch: NonNullable<OpOf<"room.update">["settings"]>): RoomSettings {
  const { newScenes, ...rest } = patch;
  const next: RoomSettings = { ...settings, ...rest };
  if (newScenes === "squares") delete next.newScenes;
  else if (newScenes !== undefined) next.newScenes = newScenes;
  return next;
}

/** A shape as an op names it, stored: squares as no shape at all. */
function storedShape(choice: "squares" | GridShape): GridShape | undefined {
  return choice === "squares" ? undefined : choice;
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
  scrubSight(tx, op.memberId);
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

/**
 * Takes a member off per-player vision's lists (docs/design-v1-per-player-vision.md
 * 6.8): every holder list's entry, every holder layer, and every list of
 * who saw a stop or a turn's start, the encounter's and each saved step's,
 * so the lists stay within the roster. Log lines hold no list once their
 * op is done (Tx.settleLog).
 */
function scrubSight(tx: Tx, memberId: MemberId): void {
  for (const sceneId of Object.keys(tx.state.holders ?? {}).sort()) {
    const list = tx.state.holders[sceneId]!;
    if (!list.entries.some((e) => e.memberId === memberId)) continue;
    forgetHolder(tx, sceneId, memberId);
    const entries = list.entries.filter((e) => e.memberId !== memberId);
    if (entries.length === 0) tx.remove(keys.holders(sceneId));
    else tx.write(keys.holders(sceneId), { ...list, entries });
  }
  const without = <T extends { seenBy?: MemberId[] }>(mark: T): T => (mark.seenBy?.includes(memberId) ? { ...mark, seenBy: mark.seenBy.filter((m) => m !== memberId) } : mark);
  for (const token of Object.values(tx.state.tokens).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const stops = token.path?.stops;
    if (!stops?.some((stop) => stop.seenBy?.includes(memberId))) continue;
    tx.write(keys.token(token.id), { ...token, path: { ...token.path!, stops: stops.map((stop: PathStop) => without(stop)) } });
  }
  const scrubbed = (encounter: Encounter): Encounter => (encounter.turnStart?.seenBy?.includes(memberId) ? { ...encounter, turnStart: without<TurnStart>(encounter.turnStart) } : encounter);
  const encounter = tx.state.encounter;
  if (encounter && scrubbed(encounter) !== encounter) tx.write(keys.encounter, scrubbed(encounter));
  const history = tx.state.encounterHistory;
  if (history.some((step) => scrubbed(step.encounter) !== step.encounter)) tx.write(keys.encounterHistory, history.map((step) => ({ ...step, encounter: scrubbed(step.encounter) })));
}

/**
 * A scene's vision after a patch (docs/design-v1-per-player-vision.md 6.7):
 * the patch's, keeping the scene's `perPlayer` when the patch names none,
 * and stored only while true. A whole-party scene's is the patch's as sent.
 */
export function patchedVision(was: SceneVision | undefined, patch: { on: boolean; light: SceneVision["light"]; perPlayer?: boolean }): SceneVision {
  const { perPlayer, ...rest } = patch;
  return (perPlayer ?? was?.perPlayer === true) ? { ...rest, perPlayer: true } : rest;
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
  const shape = input.gridShape === undefined ? undefined : storedShape(input.gridShape);
  if (shape !== undefined) {
    // A Universal VTT scene's walls stand in its file's squares (docs/design-v1-hex-grids.md HX-D13).
    if (scene.gridFromFile) throw invalid(OWN_SQUARE_GRID);
    scene.gridShape = shape;
  }
  tx.write(keys.scene(scene.id), onHexGrid(scene));
}

/**
 * A scene as an op leaves it, refused when it is on hexes with its map's
 * origin before the image (D-261026-8), so `cameWithGrid` never reads a hex
 * scene as a file's own square grid.
 */
function onHexGrid(scene: Scene): Scene {
  if (hexOriginBefore(scene)) throw invalid(HEX_ORIGIN);
  return scene;
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
  if (p.gridShape !== undefined) {
    // Cell data belongs to the shape it was written under, so the scene must hold none to change (HX-D14).
    const shape = storedShape(p.gridShape);
    const refusal = switchRefusal(tx.state, scene, gridOfShape(shape));
    if (refusal !== null) throw invalid(refusal);
    if (shape === undefined) delete next.gridShape;
    else next.gridShape = shape;
  }
  if (p.vision !== undefined) {
    next.vision = patchedVision(scene.vision, p.vision);
    // Turning vision on turns fog on, since only fog remembers what the party explored (section 4.3.1). The DM can turn it
    // off again, and a patch that names fog itself decides.
    if (p.vision.on && scene.vision?.on !== true && p.fogEnabled === undefined) next.fogEnabled = true;
  }
  // A new phase list writes the map from the scene's reference grid, held on hexes as every other map write is (review HX2-OPUS-04).
  tx.write(keys.scene(scene.id), p.phases !== undefined ? onHexGrid(withPhases(next, p.phases)) : next);
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
  for (const t of Object.values(s.traps ?? {})) if (t.sceneId === scene.id) tx.remove(keys.trap(t.id));
  tx.remove(keys.scene(scene.id));
  // On the server, only a delete stored before canApply refused the players' scene (permissions.ts MOVE_PLAYERS_FIRST) reaches this, and replays as it did.
  // A DM's pending delete, replayed with no canApply over a view where the players have since moved here (client/state/store.ts replayPending), reaches it too until the server refuses it.
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
    tx.write(keys.scene(scene.id), onHexGrid(setMapWithPhases(scene, op.map)));
    return;
  }
  const next: Scene = { ...scene };
  if (op.map === null) delete next.map;
  else next.map = op.map;
  tx.write(keys.scene(scene.id), onHexGrid(next));
}

export function sceneSetGrid(tx: Tx, op: OpOf<"scene.setGrid">): void {
  const scene = tx.scene(op.sceneId);
  if (!scene.map) throw invalid("the scene has no map to align");
  if (scene.phases) {
    tx.write(keys.scene(scene.id), onHexGrid(setGridWithPhases(scene, op)));
    return;
  }
  tx.write(keys.scene(scene.id), onHexGrid({ ...scene, map: { ...scene.map, cellPx: op.cellPx, originPx: op.originPx } }));
}
