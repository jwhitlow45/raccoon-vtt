import { keys } from "../keys.ts";
import { LIMITS, serializedBytes } from "../limits.ts";
import { type LogEntry, type LogEvent, type Token, type Trap, type TrapAction, type TrapDue, type TrapRig } from "../model.ts";
import { seenByNonOwners, stableStringify } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { doorExists, isPlainId, pitFloorOf, pitOpen } from "../rules/traps.ts";
import { splitCheck } from "../rules/walls.ts";
import { sightPiecesCheck } from "../visionLimits.ts";
import { buildHeight, heightsPainted } from "./heights.ts";
import { doorSet } from "./map.ts";
import { gone, invalid, Refuse, type Tx } from "./tx.ts";

/**
 * Traps (docs/design-v1-traps.md 6), the DM's: making, changing and
 * deleting them, doing a waiting springing's effects, and settling it. What
 * a trap does when it goes off by itself is the trap step's, which writes
 * through the helpers here.
 */

export const GIVE_IT_USES = "Give it at least one use, or no limit.";
export const DONE_MEANWHILE = "It was done meanwhile.";
export const SETTLED_MEANWHILE = "It was settled meanwhile.";

/**
 * A trap's own fields (6.1): everything but what the reducer writes on it,
 * its `due`, `noticedBy`, `state`, `found`, `usesLeft` and `rev`. Their size
 * is capped (LIMITS.trapBytes), and the size guard counts them exactly in
 * place of the whole trap, so a springing never moves a measure (6.7).
 */
export function trapOwnFields(trap: Trap): Omit<Trap, "rev" | "state" | "found" | "rig"> & { rig?: Omit<TrapRig, "usesLeft" | "noticedBy" | "due"> } {
  const { rev: _rev, state: _state, found: _found, rig, ...rest } = trap;
  if (!rig) return rest;
  const { usesLeft: _uses, noticedBy: _noticed, due: _due, ...own } = rig;
  return { ...rest, rig: own };
}

export function trapOwnBytes(trap: Trap): number {
  return serializedBytes(trapOwnFields(trap));
}

/** Why a trap as an op leaves it cannot be, or null (6.1, 6.2): its zone on its scene and the rig fitting the zone. */
function trapProblem(tx: Tx, trap: Trap): string | null {
  const scene = tx.scene(trap.sceneId);
  const { w, h } = scene.bounds;
  const rig = trap.rig;
  const zone = trap.zone;
  const rectsInside = (rects: readonly { x: number; y: number; w: number; h: number }[]) => rects.every((r) => r.x + r.w <= w && r.y + r.h <= h);
  if ("cells" in zone) {
    if (!rectsInside(zone.cells)) return "a trap's squares lie inside its scene";
  } else if ("wire" in zone) {
    const { a, b } = zone.wire;
    if (Math.max(a[0], b[0]) > w || Math.max(a[1], b[1]) > h) return "a trip wire lies inside its scene";
  }
  if (!rig) return null;
  const squares = "cells" in zone;
  if (squares && (rig.on.length < 1 || rig.on.length > 4)) return "a trap on squares goes off one to four ways";
  if (!squares && rig.on.length > 0) return "a trip wire goes off when crossed and a door when opened";
  if (!squares && rig.pit) return "only a trap on squares opens a pit";
  if (!squares && rig.hits === "zone") return "only a trap on squares hits everyone on it";
  if (typeof rig.hits === "object" && "cells" in rig.hits && !rectsInside(rig.hits.cells)) return "the squares it hits lie inside its scene";
  if (trapOwnBytes(trap) > LIMITS.trapBytes) return `a trap is at most ${LIMITS.trapBytes / 1024} KiB`;
  return null;
}

/**
 * Why a ref of the trap's own (its door, its actions' doors, lights,
 * stamps and tokens) is not on its scene, or null, naming what is wrong.
 * Only the actions an edit adds or changes are read: one whose target has
 * gone since is the card's to name when the trap goes off (5.7), so it
 * never blocks the DM's other edits.
 */
function refProblem(tx: Tx, trap: Trap, zone: boolean, actions: boolean, had: readonly TrapAction[] = []): string | null {
  const sceneId = trap.sceneId;
  if (zone && "door" in trap.zone && !doorExists(tx.state, sceneId, trap.zone.door)) return "that door is not on the trap's scene";
  if (!actions) return null;
  const kept = new Set(had.map((a) => stableStringify(a)));
  for (const a of trap.rig?.actions ?? []) {
    if (kept.has(stableStringify(a))) continue;
    if ("door" in a && !doorExists(tx.state, sceneId, a.door)) return "a door it sets is not on the trap's scene";
    if ("light" in a) {
      const light = tx.state.lights[a.light];
      if (!light) return "a light it sets was deleted";
      if (light.sceneId !== sceneId) return `the light ${light.label ? `"${light.label}"` : "it sets"} is on another scene`;
    }
    if ("show" in a) {
      if ("tokenId" in a.show) {
        const token = tx.state.tokens[a.show.tokenId];
        if (!token) return "a creature it shows was deleted";
        if (token.sceneId !== sceneId) return `${token.name} is on another scene`;
      } else {
        const stamp = tx.state.stamps[a.show.stampId];
        if (!stamp) return "a stamp it shows was deleted";
        if (stamp.sceneId !== sceneId) return "a stamp it shows is on another scene";
      }
    }
  }
  return null;
}

export function trapCreate(tx: Tx, op: OpOf<"trap.create">): void {
  const input = op.trap;
  tx.scene(input.sceneId);
  if (tx.state.traps[input.id]) throw invalid("a trap with that id is already on the map");
  const trap: Trap = { id: input.id, rev: 0, sceneId: input.sceneId, name: input.name, zone: input.zone, state: "armed", found: input.found ?? false, rig: { ...input.rig } };
  const why = trapProblem(tx, trap) ?? refProblem(tx, trap, true, true);
  if (why) throw invalid(why);
  tx.write(keys.trap(trap.id), trap);
}

/**
 * Changes only the fields the patch names, each replaced whole (6.2), so
 * two DM devices editing different fields never undo each other and an
 * edit never overwrites what the reducer wrote. A change of the find
 * checks forgets who noticed it, so the hint can name someone again.
 * Arming a trap with no uses left needs uses in the same patch.
 */
export function trapUpdate(tx: Tx, op: OpOf<"trap.update">): void {
  const trap = tx.state.traps[op.trapId];
  if (!trap) throw gone("trap");
  const p = op.patch;
  const next: Trap = { ...trap };
  if (p.name !== undefined) next.name = p.name;
  if (p.zone !== undefined) next.zone = p.zone;
  if (p.state !== undefined) next.state = p.state;
  if (p.found !== undefined) next.found = p.found;
  if (p.rig !== undefined && trap.rig) {
    const rig: Record<string, unknown> = { ...trap.rig };
    for (const [field, value] of Object.entries(p.rig)) {
      if (value === undefined) continue;
      if (value === null) delete rig[field];
      else rig[field] = value;
    }
    if (p.rig.find !== undefined) delete rig.noticedBy;
    next.rig = rig as TrapRig;
  }
  if (p.state === "armed" && next.rig?.usesLeft === 0) throw invalid(GIVE_IT_USES);
  const why = trapProblem(tx, next) ?? refProblem(tx, next, p.zone !== undefined, p.rig?.actions !== undefined, trap.rig?.actions);
  if (why) throw invalid(why);
  tx.write(keys.trap(trap.id), next);
}

export function trapDelete(tx: Tx, op: OpOf<"trap.delete">): void {
  if (!tx.state.traps[op.trapId]) throw gone("trap");
  tx.remove(keys.trap(op.trapId));
}

/** The occurrence a DM op names, still waiting. */
function dueOf(trap: Trap | undefined, id: string): TrapDue | undefined {
  return trap?.rig?.due?.find((d) => d.id === id);
}

/**
 * Do its effects (6.2): a private springing in a player's op left them
 * waiting, so its doors, lights and reveals and its players' line run now,
 * once, and the occurrence is marked so. Like Set it off it is the DM's
 * reveal, so it marks the trap found when the trap says so. The save and
 * damage stay waiting.
 */
export function trapAct(tx: Tx, op: OpOf<"trap.act">): void {
  const trap = tx.state.traps[op.trapId];
  const due = dueOf(trap, op.due);
  if (!trap || !trap.rig || !due || due.acted) throw invalid(DONE_MEANWHILE);
  runActions(tx, trap);
  // Who every player sees now, as the DM's reveal shows them.
  playersLine(tx, trap, due.by.filter((id) => {
    const token = tx.state.tokens[id];
    return token !== undefined && seenByNonOwners(tx.state, token, tx.env);
  }));
  const now = tx.state.traps[trap.id]!;
  const rig = now.rig!;
  const next: Trap = { ...now, rig: { ...rig, due: (rig.due ?? []).map((d) => (d.id === due.id ? { ...d, acted: true as const } : d)) } };
  if (rig.foundOnSpring) next.found = true;
  tx.write(keys.trap(trap.id), next);
}

/** Dismiss, and Mark sprung (6.2): the occurrence leaves, and the trap is sprung with `sprung`. Refused when it is not waiting. */
export function trapSettle(tx: Tx, op: OpOf<"trap.settle">): void {
  settleTrap(tx, op.trapId, op.due, op.sprung === true);
}

/** Settles a waiting occurrence, refused when it is not waiting: a second DM device's Apply or Dismiss, or a resend. */
export function settleTrap(tx: Tx, trapId: string, dueId: string, sprung = false): void {
  const trap = tx.state.traps[trapId];
  if (!dueOf(trap, dueId)) throw invalid(SETTLED_MEANWHILE);
  writeSettled(tx, trap!, dueId, sprung);
}

/** The trap with an occurrence settled: gone from its list, the trap sprung when asked. */
export function writeSettled(tx: Tx, trap: Trap, dueId: string, sprung: boolean): void {
  const rig = trap.rig!;
  const due = (rig.due ?? []).filter((d) => d.id !== dueId);
  const { due: _due, ...rest } = rig;
  const next: Trap = { ...trap, rig: due.length > 0 ? { ...rest, due } : rest };
  if (sprung) next.state = "sprung";
  tx.write(keys.trap(trap.id), next);
}

// ---------------------------------------------------------------------------
// What a trap does (5.7) and the lines it writes (6.3)

/** One action's outcome, by its index in the trap's list (-1 the pit), as the DM's line keeps it. */
export type Did = { action: number; ok: boolean };

/** The pit's place among a line's outcomes (6.3): after the listed actions, as -1. */
export const PIT_ACTION = -1;

/**
 * A trap's actions in their listed order (5.7): a door set, a light put
 * out or lit, a hidden creature or stamp shown, and then its pit. A target
 * gone since, or moved to another scene, is skipped and named on the card.
 * None of them can refuse the op: a door's change is the door op's own, a
 * reveal of a lit token passes the lit token cap as a reveal on a turn
 * does, and a pit's geometry is counted from the moment the trap exists
 * (6.7), so only a pit whose opened ground would still pass a cap fails,
 * shut. A pit already open changes nothing and has no outcome to name.
 */
export function runActions(tx: Tx, trap: Trap): Did[] {
  const did: Did[] = [];
  for (const [i, action] of (trap.rig?.actions ?? []).entries()) did.push({ action: i, ok: runAction(tx, trap.sceneId, action) });
  const pit = openPit(tx, trap);
  if (pit !== null) did.push({ action: PIT_ACTION, ok: pit });
  return did;
}

/**
 * A pit opens (5.7): each of its squares' ground goes to the stored floor
 * through `buildHeight`, which sets every token standing there on the
 * ground it leaves by attach's group rules, a holder taking what sits on
 * it down with it and a dragged creature keeping to its own ground. The
 * caller runs attach's link pass again. Null when every square is already
 * at the floor, false when it could not open.
 */
function openPit(tx: Tx, trap: Trap): boolean | null {
  const pit = trap.rig?.pit;
  if (!pit || !("cells" in trap.zone)) return null;
  if (pitOpen(tx.state.buildChunks, trap.sceneId, trap.zone.cells, pit)) return null;
  const floor = pitFloorOf(pit);
  const cells: string[] = [];
  const seen = new Set<string>();
  for (const r of trap.zone.cells) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cells.push(key);
      }
    }
  }
  const op: OpOf<"build.height"> = { t: "build.height", sceneId: trap.sceneId, cells, height: floor };
  try {
    if (!openedFits(tx, op)) return false;
    buildHeight(tx, op);
    return true;
  } catch (err) {
    if (err instanceof Refuse) return false;
    throw err;
  }
}

/**
 * Whether the scene's walls with the pit open stay within the split's caps
 * and the sight pieces' (6.7), read before anything is written. Counting a
 * pit's border ahead keeps every op within them, but nothing counted an
 * imported room's pits so, and there a pit over a cap stays shut.
 */
function openedFits(tx: Tx, op: OpOf<"build.height">): boolean {
  const opened = { scenes: tx.state.scenes, buildChunks: heightsPainted(tx.state.buildChunks, tx.scene(op.sceneId), op) };
  return splitCheck(opened, op.sceneId).ok && sightPiecesCheck(opened, op.sceneId, tx.state).ok;
}

function runAction(tx: Tx, sceneId: string, action: TrapAction): boolean {
  if ("door" in action) {
    if (!doorExists(tx.state, sceneId, action.door)) return false;
    try {
      doorSet(tx, { t: "door.set", sceneId, door: action.door, state: action.state });
      return true;
    } catch (err) {
      if (err instanceof Refuse) return false;
      throw err;
    }
  }
  if ("light" in action) {
    const light = tx.state.lights[action.light];
    if (!light || light.sceneId !== sceneId) return false;
    if (light.on !== action.on) tx.write(keys.light(light.id), { ...light, on: action.on });
    return true;
  }
  if ("tokenId" in action.show) {
    const token = tx.state.tokens[action.show.tokenId];
    if (!token || token.sceneId !== sceneId) return false;
    if (token.visibility !== "all") tx.write(keys.token(token.id), { ...token, visibility: "all" });
    return true;
  }
  const stamp = tx.state.stamps[action.show.stampId];
  if (!stamp || stamp.sceneId !== sceneId) return false;
  if (stamp.visibility !== "all") tx.write(keys.stamp(stamp.id), { ...stamp, visibility: "all" });
  return true;
}

/** Plain ids only, in order, at most `max`, the rest counted (6.1): so each list stays within its reserve. */
export function plainList(ids: readonly string[], max: number): { list: string[]; more: number } {
  const list: string[] = [];
  let more = 0;
  for (const id of ids) {
    if (isPlainId(id) && list.length < max) list.push(id);
    else more++;
  }
  return { list, more };
}

/** A line cut to its log's bound (6.3): its creatures dropped from the end into `more` until it fits. */
function cutLine(data: Extract<LogEvent, { type: "trap" | "trapSeen" }>, tx: Tx): LogEvent {
  const size = (d: LogEvent) => serializedBytes({ id: `${tx.env.seq}:999999`, at: tx.env.at, kind: "event", data: d } satisfies LogEntry);
  let out = data;
  while (size(out) > LIMITS.trapLineBytes && out.by.length > 0) {
    const by = out.by.slice(0, -1);
    const more = (out.more ?? 0) + 1;
    out = { ...out, by, more } as typeof data;
    if (out.type === "trap" && out.seen) {
      const seen = out.seen.filter((i) => i < by.length);
      out = seen.length > 0 ? { ...out, seen } : (({ seen: _seen, ...rest }) => rest)(out);
    }
  }
  return out;
}

/**
 * The players' line (6.3), when the trap has one: every player and table
 * display receives it, so `shown` names only creatures every player saw
 * when it went off, which each viewer gets cut to those they see.
 */
export function playersLine(tx: Tx, trap: Trap, shown: readonly string[]): boolean {
  const message = trap.rig?.message;
  if (!message) return false;
  const { list, more } = plainList(shown, LIMITS.trapBy);
  const data: Extract<LogEvent, { type: "trapSeen" }> = { type: "trapSeen", by: list, ...(more > 0 ? { more } : {}), message, ...(trap.rig?.sound ? { sound: trap.rig.sound } : {}) };
  tx.addTrapLine("trapSeen", cutLine(data, tx), LIMITS.trapSeenLines);
  return true;
}

/** Who set a trap off, as a line and an occurrence keep it (6.1): those players own or see first, then by id, plain ids only. */
export function orderedBy(by: readonly string[], shown: (id: string) => boolean): { list: string[]; more: number } {
  const first = by.filter(shown);
  const rest = by.filter((id) => !shown(id));
  return plainList([...first, ...rest], LIMITS.trapBy);
}

/**
 * The DM's line (6.3): the trap's name, how, who set it off, how many it
 * hits, what its actions did and which of its creatures players could see.
 * Its id names the occurrence.
 */
export function dmLine(tx: Tx, trap: Trap, line: { how: TrapDue["how"]; by: readonly string[]; more: number; hits: number; did: readonly Did[]; seen: ReadonlySet<string>; hidden: boolean }): LogEntry {
  const seen = line.by.flatMap((id, i) => (line.seen.has(id) ? [i] : []));
  const data: Extract<LogEvent, { type: "trap" }> = {
    type: "trap",
    trapId: trap.id,
    name: trap.name,
    how: line.how,
    by: [...line.by],
    ...(line.more > 0 ? { more: line.more } : {}),
    hits: line.hits,
    did: [...line.did],
    ...(seen.length > 0 ? { seen } : {}),
    ...(line.hidden ? { hidden: true as const } : {}),
  };
  return tx.addTrapLine("trapLog", cutLine(data, tx), LIMITS.trapLogLines);
}

/**
 * Adds an occurrence (6.1): a trap's fourth drops that trap's own oldest,
 * then a room's eleventh the room's oldest, so a busy trap never pushes out
 * another trap's card while it has its own to give up.
 */
export function addDue(tx: Tx, trapId: string, due: TrapDue): void {
  const trap = tx.state.traps[trapId]!;
  const own = [...(trap.rig?.due ?? []), due];
  while (own.length > LIMITS.trapDuePerTrap) own.shift();
  tx.write(keys.trap(trap.id), { ...trap, rig: { ...trap.rig!, due: own } });
  for (;;) {
    const all = Object.values(tx.state.traps).flatMap((t) => (t.rig?.due ?? []).map((d) => ({ trap: t, due: d })));
    if (all.length <= LIMITS.trapDuePerRoom) return;
    all.sort((a, b) => compareIds(a.due.id, b.due.id));
    const oldest = all[0]!;
    writeSettled(tx, oldest.trap, oldest.due.id, false);
  }
}

/**
 * The room's cap after a restore (6.1, 6.5): an undone Apply or Dismiss
 * brings its occurrence back, which may make the room's eleventh. The
 * room's oldest that the restore did not bring back then goes, as an
 * eleventh springing drops it, so what the undo brought back stays.
 */
export function capRestoredDues(tx: Tx, before: Readonly<Record<string, Trap>> | undefined): void {
  const had = new Set(Object.values(before ?? {}).flatMap((t) => (t.rig?.due ?? []).map((d) => d.id)));
  for (;;) {
    const all = Object.values(tx.state.traps ?? {}).flatMap((t) => (t.rig?.due ?? []).map((d) => ({ trap: t, due: d })));
    if (all.length <= LIMITS.trapDuePerRoom) return;
    const older = all.filter((x) => had.has(x.due.id)).sort((a, b) => compareIds(a.due.id, b.due.id));
    const oldest = older[0] ?? all.sort((a, b) => compareIds(a.due.id, b.due.id))[0]!;
    writeSettled(tx, oldest.trap, oldest.due.id, false);
  }
}

function compareIds(a: string, b: string): number {
  const [as, ai] = a.split(":");
  const [bs, bi] = b.split(":");
  return Number(as) - Number(bs) || Number(ai ?? 0) - Number(bi ?? 0);
}

/** A token by id when it is a creature on the trap's scene, for the lists a springing keeps. */
export function onScene(tx: Tx, trap: Trap, id: string): Token | undefined {
  const token = tx.state.tokens[id];
  return token && token.sceneId === trap.sceneId ? token : undefined;
}
