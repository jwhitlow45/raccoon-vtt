import { type AreaTemplate, type BuildChunk, type Drawing, type FreeWall, type RoomState, type Token, type Trap, type Viewer } from "#shared/model.ts";
import { keys } from "#shared/keys.ts";
import { projectEntity, projectState, stampCells } from "#shared/project.ts";
import { labelBox } from "#shared/rules/labels.ts";
import type { Rect } from "../../lib/camera.ts";
import { displayName, footprint } from "../../lib/scene.ts";
import { shippedStamp } from "../builder/stamps/rules.ts";
import { zoneBox } from "../traps/rules.ts";
import { unionView } from "../vision/union.ts";

/**
 * The scene outliner's rows (docs/design-v1-dm-tools.md 3.2), as pure
 * functions over the DM's view: everything on the scene in view, grouped,
 * each with what players get of it and the rectangle a tap frames.
 *
 * What players get is read through the projection itself, never a second
 * copy of its rules: the scene's contents are projected once for a player
 * who owns nothing, as if the scene were the players', and a row the
 * projection leaves out is marked by why. So the outliner and what players
 * receive never disagree, through fog, party vision, hidden tokens, DM-only
 * stamps and pins linked to pages.
 *
 * On a per-player scene that player sees what any player sees, the union
 * of every source and every player's map (docs/design-v1-per-player-vision.md
 * decision 14, vision/union.ts), so a row is marked only when no player
 * gets it.
 */

export type OutlineGroup = "tokens" | "map" | "areas" | "drawings" | "doors" | "traps";

export const GROUPS: readonly { id: OutlineGroup; title: string; chip: string }[] = [
  { id: "tokens", title: "Creatures and objects", chip: "Creatures" },
  { id: "map", title: "Map", chip: "Map" },
  { id: "areas", title: "Areas", chip: "Areas" },
  { id: "drawings", title: "Drawings", chip: "Drawings" },
  { id: "doors", title: "Doors", chip: "Doors" },
  { id: "traps", title: "Traps", chip: "Traps" },
];

export type OutlineKind = "token" | "stamp" | "label" | "pin" | "light" | "area" | "drawing" | "door" | "window" | "trap";

export type OutlineRow = {
  /** Unique in the list: kind and id. */
  key: string;
  group: OutlineGroup;
  kind: OutlineKind;
  id: string;
  name: string;
  /** A second line: a creature's kind, a drawing's owner, a door's state. */
  detail: string;
  /** What players get of it, when that is less than all of it. */
  mark: string | null;
  /** What a tap frames, in cells. */
  rect: Rect;
  /** A door or window's line, which flashes where it runs. */
  segment?: { a: { x: number; y: number }; b: { x: number; y: number } };
  /** The lowercase text the search reads. */
  search: string;
};

/** A player who owns nothing: what anyone at the table may see. */
const ANYONE: Viewer = { memberId: "outliner", role: "player" };

/**
 * The view as the projection reads it for players, with this scene as
 * theirs and no blackout, so a scene being prepared reads as it will once
 * the players are moved to it.
 */
function asPlayersScene(view: RoomState, sceneId: string): RoomState {
  return { ...view, meta: { ...view.meta, playerSceneId: sceneId, view: { ...view.meta.view, blackout: false } } };
}

function rectOf(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function pointRect(x: number, y: number): Rect {
  return rectOf(x - 0.5, y - 0.5, x + 0.5, y + 0.5);
}

function boundsOf(points: readonly number[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    x0 = Math.min(x0, points[i]!);
    y0 = Math.min(y0, points[i + 1]!);
    x1 = Math.max(x1, points[i]!);
    y1 = Math.max(y1, points[i + 1]!);
  }
  return x0 === Infinity ? pointRect(0, 0) : rectOf(x0, y0, x1, y1);
}

const KIND_WORD: Record<Token["kind"], string> = { pc: "Character", npc: "NPC", monster: "Monster", object: "Object" };
const DRAWING_WORD: Record<Drawing["kind"], string> = {
  free: "Freehand",
  line: "Line",
  rect: "Rectangle",
  ellipse: "Ellipse",
  polygon: "Polygon",
  arrow: "Arrow",
  text: "Text",
  ruler: "Kept ruler",
};
const TRAP_STATE_WORD: Record<Trap["state"], string> = { armed: "Armed", sprung: "Sprung", disarmed: "Disarmed" };
const SHAPE_WORD: Record<AreaTemplate["shape"], string> = {
  cone: "Cone",
  cube: "Cube",
  cylinder: "Cylinder",
  emanation: "Emanation",
  line: "Line",
  sphere: "Sphere",
};

/**
 * A companion's detail and mark (docs/design-v1-combat-flow.md 3.6.10):
 * whose it is, in place of its kind word, so searching "companion" lists
 * them all, and "Away from Bree" when no token of its character stands on
 * the scene, as when the party moved on and left it behind.
 */
function companionOf(view: RoomState, t: Token, sceneId: string): { detail: string; away: string | null } | null {
  if (!t.companion) return null;
  const characterId = t.companion.of;
  const name = view.characters[characterId]?.name ?? "a character";
  const here = Object.values(view.tokens).some((o) => o?.sceneId === sceneId && "ref" in o.actor && o.actor.ref === characterId);
  return { detail: `Companion of ${name}`, away: here ? null : `Away from ${name}` };
}

/** Every row for the scene, in group order, each group sorted by name. */
export function outlineRows(view: RoomState, sceneId: string): OutlineRow[] {
  const scene = view.scenes[sceneId];
  if (!scene) return [];
  const forPlayers = asPlayersScene(unionView(view), sceneId);
  const seen = projectState(forPlayers, ANYONE, { sceneId: null });
  const vision = scene.vision?.on === true;
  const memberName = (id: string) => view.members[id]?.name ?? "A former member";
  const feet = view.meta.settings.feetPerCell > 0 ? view.meta.settings.feetPerCell : 5;
  const rows: OutlineRow[] = [];
  const add = (row: Omit<OutlineRow, "search" | "key">) => rows.push({ ...row, key: `${row.kind}:${row.id}`, search: `${row.name} ${row.detail}`.toLowerCase() });

  const tokenMark = (t: Token): string | null => {
    if (seen.tokens[t.id]) return null;
    if (t.visibility === "dm") return "Hidden";
    return vision ? "Out of the party's sight" : "Under fog";
  };

  for (const t of Object.values(view.tokens)) {
    if (!t || t.sceneId !== sceneId) continue;
    const fp = footprint(t);
    const companion = companionOf(view, t, sceneId);
    add({
      group: "tokens",
      kind: "token",
      id: t.id,
      name: displayName(t),
      detail: companion?.detail ?? KIND_WORD[t.kind] ?? "",
      mark: companion?.away ?? tokenMark(t),
      rect: rectOf(t.x, t.y, t.x + fp.w, t.y + fp.h),
    });
  }

  for (const s of Object.values(view.stamps ?? {})) {
    if (!s || s.sceneId !== sceneId) continue;
    const name = "key" in s.art ? (shippedStamp(s.art.key)?.name ?? s.art.key) : "Image";
    const cells = stampCells(s);
    const mark = s.visibility === "dm" ? "DM only" : seen.stamps[s.id] ? null : "Under fog";
    add({ group: "map", kind: "stamp", id: s.id, name, detail: "Stamp", mark, rect: rectOf(cells.x0, cells.y0, cells.x1, cells.y1) });
  }
  for (const l of Object.values(view.labels ?? {})) {
    if (!l || l.sceneId !== sceneId) continue;
    const box = labelBox(l);
    add({ group: "map", kind: "label", id: l.id, name: l.text, detail: "Label", mark: seen.labels[l.id] ? null : "Under fog", rect: rectOf(box.x0, box.y0, box.x1, box.y1) });
  }
  for (const p of Object.values(view.pins ?? {})) {
    if (!p || p.sceneId !== sceneId) continue;
    const page = p.pageId !== undefined ? view.journal?.[p.pageId] : undefined;
    add({ group: "map", kind: "pin", id: p.id, name: p.label || page?.title || "Pin", detail: page ? `Pin, ${page.title}` : "Pin", mark: pinMark(forPlayers, p.id, p.visibility, page?.access, seen.pins[p.id] !== undefined, memberName), rect: pointRect(p.x, p.y) });
  }
  for (const l of Object.values(view.lights ?? {})) {
    if (!l || l.sceneId !== sceneId) continue;
    // Lights are the DM's in every wave: players see only what they light.
    add({ group: "map", kind: "light", id: l.id, name: l.label || "Light", detail: l.on ? `Light, ${l.bright} ft bright` : "Light, off", mark: "DM only", rect: pointRect(l.x, l.y) });
  }

  for (const a of Object.values(view.templates ?? {})) {
    if (!a || a.sceneId !== sceneId) continue;
    const attached = a.attachedTo !== undefined ? view.tokens[a.attachedTo] : undefined;
    const r = a.size / feet;
    const center = attached ? { x: attached.x + footprint(attached).w / 2, y: attached.y + footprint(attached).h / 2 } : a.origin;
    const mark =
      a.visibility === "dm"
        ? "DM only"
        : seen.templates[a.id]
          ? null
          : attached && !seen.tokens[attached.id]
            ? tokenMark(attached)
            : `Only ${memberName(a.ownerId)}`;
    add({
      group: "areas",
      kind: "area",
      id: a.id,
      name: a.label || a.spell || SHAPE_WORD[a.shape],
      detail: `${SHAPE_WORD[a.shape]}, ${a.size} ft, ${memberName(a.ownerId)}`,
      mark,
      rect: rectOf(center.x - r, center.y - r, center.x + r, center.y + r),
    });
  }

  for (const d of Object.values(view.drawings ?? {})) {
    if (!d || d.sceneId !== sceneId) continue;
    const word = DRAWING_WORD[d.kind] ?? "Drawing";
    const name = d.kind === "text" && d.text ? d.text : word;
    const mark = d.visibility === "dm" ? "DM only" : seen.drawings[d.id] ? null : "Under fog";
    add({ group: "drawings", kind: "drawing", id: d.id, name, detail: `${word}, ${memberName(d.ownerId)}`, mark, rect: boundsOf(d.points) });
  }

  for (const door of sceneDoors(view.buildChunks, sceneId)) add(door);

  for (const t of Object.values(view.traps ?? {})) {
    if (!t || t.sceneId !== sceneId) continue;
    const box = zoneBox(t, view.buildChunks);
    const doorGone = "door" in t.zone && box === null;
    // Found is the party's (docs/design-v1-traps.md 4.5): a found trap reaches players by its name and place, unless the fog covers it.
    const mark = !t.found ? "Hidden" : seen.traps[t.id] ? "Found" : "Found, under fog";
    add({
      group: "traps",
      kind: "trap",
      id: t.id,
      name: t.name,
      detail: `${TRAP_STATE_WORD[t.state]}${doorGone ? ". Its door is gone" : ""}`,
      mark,
      rect: box ? rectOf(box.x0, box.y0, box.x1, box.y1) : pointRect(0, 0),
    });
  }

  const order = new Map(GROUPS.map((g, i) => [g.id, i]));
  return rows.sort(
    (a, b) =>
      order.get(a.group)! - order.get(b.group)! ||
      // Secret doors first among the doors, hidden ones before found ones, as the DM looks for them most.
      (a.group === "doors" ? secretRank(a) - secretRank(b) : 0) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

function secretRank(row: Pick<OutlineRow, "mark">): number {
  return row.mark === "Secret door, hidden" ? 0 : row.mark === "Secret door, found" ? 1 : 2;
}

/**
 * A pin's mark: DM only by its own switch or by a DM-only page, the player
 * it is private to when its page is one player's, or under fog as labels
 * go. A pin on a page private to a player is projected for that player, so
 * the fog is read as they get it.
 */
function pinMark(
  state: RoomState,
  pinId: string,
  visibility: "all" | "dm",
  access: "dm" | "all" | { member: string } | undefined,
  seenByAnyone: boolean,
  memberName: (id: string) => string,
): string | null {
  if (visibility === "dm" || access === "dm") return "DM only";
  if (access !== undefined && access !== "all") {
    const shown = projectEntity(keys.pin(pinId), state, { memberId: access.member, role: "player" }, { sceneId: null }) !== null;
    return shown ? `Only ${memberName(access.member)}` : "Under fog";
  }
  return seenByAnyone ? null : "Under fog";
}

/** Every door and window of the scene's build, on grid edges and free walls alike. */
function sceneDoors(chunks: Readonly<Record<string, BuildChunk | undefined>>, sceneId: string): Omit<OutlineRow, "search" | "key">[] {
  const out: Omit<OutlineRow, "search" | "key">[] = [];
  for (const chunk of Object.values(chunks)) {
    if (!chunk || chunk.sceneId !== sceneId) continue;
    for (const [edge, feature] of Object.entries(chunk.edges)) {
      if (feature.kind !== "door" && feature.kind !== "window") continue;
      const [xs, ys, side] = edge.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (!Number.isInteger(x) || !Number.isInteger(y) || (side !== "n" && side !== "w")) continue;
      const a = { x, y };
      const b = side === "n" ? { x: x + 1, y } : { x, y: y + 1 };
      out.push(doorRow(`${chunk.cx},${chunk.cy}:${edge}`, feature, a, b));
    }
    for (const wall of chunk.walls ?? []) {
      if (wall.f.kind !== "door" && wall.f.kind !== "window") continue;
      out.push(doorRow(`${chunk.cx},${chunk.cy}:${wall.id}`, wall.f, { x: wall.a[0], y: wall.a[1] }, { x: wall.b[0], y: wall.b[1] }));
    }
  }
  return out;
}

type Opening = Extract<FreeWall["f"], { kind: "door" | "window" }>;

function doorRow(id: string, f: Opening, a: { x: number; y: number }, b: { x: number; y: number }): Omit<OutlineRow, "search" | "key"> {
  const where = `at ${Math.round(Math.min(a.x, b.x))}, ${Math.round(Math.min(a.y, b.y))}`;
  const rect = rectOf(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
  if (f.kind === "window") return { group: "doors", kind: "window", id, name: "Window", detail: where, mark: null, rect, segment: { a, b } };
  const state = f.state === "open" ? "open" : f.state === "locked" ? "locked" : "closed";
  return {
    group: "doors",
    kind: "door",
    id,
    name: f.secret ? "Secret door" : "Door",
    detail: `${state[0]!.toUpperCase()}${state.slice(1)}, ${where}`,
    // A hidden secret door is the wall players think it is (shared/project.ts projectChunkForPlayer).
    mark: f.secret ? (f.discovered ? "Secret door, found" : "Secret door, hidden") : null,
    rect,
    segment: { a, b },
  };
}

/** The rows a search and a group chip leave, matching every word of the search. */
export function filterRows(rows: readonly OutlineRow[], query: string, group: OutlineGroup | null): OutlineRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => (group === null || r.group === group) && words.every((w) => r.search.includes(w)));
}

/** One line of the windowed list: a group's header with its count, or a row. */
export type ListItem = { kind: "header"; group: OutlineGroup; title: string; count: number; folded: boolean } | { kind: "row"; row: OutlineRow };

/** The list as drawn: each group with rows a header, then its rows unless folded. */
export function listItems(rows: readonly OutlineRow[], folded: ReadonlySet<OutlineGroup>): ListItem[] {
  const out: ListItem[] = [];
  for (const g of GROUPS) {
    const inGroup = rows.filter((r) => r.group === g.id);
    if (inGroup.length === 0) continue;
    const isFolded = folded.has(g.id);
    out.push({ kind: "header", group: g.id, title: g.title, count: inGroup.length, folded: isFolded });
    if (!isFolded) for (const row of inGroup) out.push({ kind: "row", row });
  }
  return out;
}

/** Every line is this tall, so the window is plain arithmetic. */
export const ROW_PX = 56;

/**
 * Which lines to render: those in view, and a few past each edge so a
 * quick scroll never shows a gap. `listTop` is where the list's top sits in
 * its scrolling box's view, negative once scrolled past.
 */
export function windowRange(input: { listTop: number; viewHeight: number; count: number; rowPx?: number; overscan?: number }): { start: number; end: number } {
  const rowPx = input.rowPx ?? ROW_PX;
  const overscan = input.overscan ?? 8;
  const first = Math.floor(-input.listTop / rowPx);
  const last = Math.ceil((input.viewHeight - input.listTop) / rowPx);
  const start = Math.max(0, Math.min(input.count, first - overscan));
  const end = Math.max(start, Math.min(input.count, last + overscan));
  return { start, end };
}

/**
 * What a tap frames: the item with room around it, at least a few cells
 * across, so a door or a light is not framed at a zoom that shows nothing
 * else (the Find my token framing takes any rectangle, features/find).
 */
export function frameRect(rect: Rect, roomCells = 3): Rect {
  const width = Math.max(rect.width, 2) + roomCells * 2;
  const height = Math.max(rect.height, 2) + roomCells * 2;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}
