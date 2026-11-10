import { createHash } from "node:crypto";
import type { BuildChunk, RoomState, Scene, Viewer } from "../model.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { projectChunkForPlayer, projectState, type ProjectedState, type ProjectedToken } from "../project.ts";
import { asPlayerCopy } from "../rankTestutil.ts";
import { applyOp, type ApplyResult } from "../reducer.ts";

/**
 * The replay of ops stored at op version 40 or lower that name a member of
 * Object.prototype (records.ts readsOwnKeys), worked out the same way on the
 * build before own-key reads and on today's, so the two can be compared
 * (opVersion40.differential.test.ts). It imports only what both builds
 * have, so a copy of it runs on the older one to record what that did.
 */

/** "prototype" is no member of Object.prototype and stands for an ordinary id beside them. */
const NAMES = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"] as const;

const AT = "2026-10-12T20:00:00.000Z";
const STORED = 40;

export type Who = "dm1" | "p1" | "p2";

const VIEWERS: Record<Who, Viewer> = { dm1: { memberId: "dm1", role: "dm" }, p1: { memberId: "p1", role: "player" }, p2: { memberId: "p2", role: "player" } };

type Slot = { path: (string | number)[]; key: boolean };

/** Every string in an op and every object key, by path, the op's tag aside. */
function slots(value: unknown, path: (string | number)[] = [], out: Slot[] = []): Slot[] {
  if (typeof value === "string") out.push({ path, key: false });
  else if (Array.isArray(value)) value.forEach((v, i) => slots(v, [...path, i], out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (path.length === 0 && k === "t") continue;
      // A restore's values are entities as the server stored them: their field names are no ids.
      if (!(path[0] === "entries" && path[2] === "value")) out.push({ path: [...path, k], key: true });
      slots(v, [...path, k], out);
    }
  }
  return out;
}

/** The value with one slot set to `name`, every object rebuilt with own properties, so "__proto__" stays a key. */
function replaced(value: unknown, path: readonly (string | number)[], name: string, key: boolean): unknown {
  if (path.length === 0) return name;
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((v, i) => (i === head ? replaced(v, rest, name, key) : v));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (k !== head) return [k, v];
      return key && rest.length === 0 ? [name, v] : [k, replaced(v, rest, name, key)];
    }),
  );
}

function at(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((v, p) => (v as Record<string | number, unknown>)[p], value);
}

/**
 * The op with each name in each slot, and in an entity key's id
 * ("token:constructor"), as replay reads a stored op: through the schema
 * of every op (server/rooms/persistence.ts storedOp).
 */
function variants(op: Op): { op: Op; label: string }[] {
  const raw = JSON.parse(JSON.stringify(op)) as unknown;
  const out: { op: Op; label: string }[] = [];
  for (const slot of slots(raw)) {
    const text = slot.key ? null : (at(raw, slot.path) as string);
    const colon = text?.indexOf(":") ?? -1;
    for (const name of NAMES) {
      const tries: string[] = [name];
      if (text !== null && colon > 0 && /^[A-Za-z]+$/.test(text.slice(0, colon))) tries.push(`${text.slice(0, colon)}:${name}`);
      for (const value of tries) {
        const parsed = opSchema.safeParse(replaced(raw, slot.path, value, slot.key));
        if (parsed.success) out.push({ op: parsed.data, label: `${op.t} ${slot.key ? "key" : "value"} ${slot.path.join(".")} = ${value}` });
      }
    }
  }
  return out;
}

/** Rooms share every entity an op did not write with the room before it, so each object's text is worked out once. */
const texts = new WeakMap<object, string>();
/** Objects whose text holds what a snapshot loses, in them or in what they hold. */
const lossy = new WeakSet<object>();

/**
 * Text that tells two values apart wherever JSON would not: object keys
 * sorted, a function, an undefined array item or a number JSON has no
 * word for named, and an object whose prototype is no longer Object's
 * (what writing "__proto__" by assignment does) marked, with the
 * prototype's own fields. A long text stands as its digest inside the text
 * of what holds it. Nothing writes an object after the op that made it
 * has returned, so its text never goes stale.
 */
function canon(value: unknown, holder?: object): string {
  if (typeof value !== "object" || value === null) {
    const text = value === undefined ? "u" : typeof value === "function" ? "f" : typeof value === "number" && !Number.isFinite(value) ? `n${String(value)}` : (JSON.stringify(value) ?? "u");
    if (holder && (typeof value === "function" || (typeof value === "number" && !Number.isFinite(value)) || (value === undefined && Array.isArray(holder)))) lossy.add(holder);
    return text;
  }
  const known = texts.get(value);
  if (known !== undefined) {
    if (holder && lossy.has(value)) lossy.add(holder);
    return known;
  }
  let text: string;
  if (Array.isArray(value)) text = `[${value.map((v) => canon(v, value)).join(",")}]`;
  else {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canon(record[k], value)}`);
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype) {
      parts.push(`"~proto":${proto === null ? "null" : canon({ ...proto })}`);
      lossy.add(value);
    }
    text = `{${parts.join(",")}}`;
  }
  if (text.length > 256) text = `#${digest(text)}`;
  texts.set(value, text);
  if (holder && lossy.has(value)) lossy.add(holder);
  return text;
}

/** Whether a snapshot of the room holds less than the room: only then may a replay from it go otherwise, as the reducer reads nothing else. */
function snapshotLoses(state: RoomState): boolean {
  canon(state);
  return lossy.has(state);
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Whether a record of the room took a prototype from "__proto__", which its projections read by key and no snapshot of it holds. */
function reparented(state: RoomState): boolean {
  return Object.values(state).some((v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype);
}

/**
 * A player's copy with every scene with fog off read as players got it
 * before D-261110-530, as secretDoorTestutil.ts storedFogOff reads it: its
 * chunks as projectChunkForPlayer gives them and the scene's own automatic
 * walls rule. Written out here, since this file runs on the older build too,
 * where it changes nothing.
 */
function storedFogOff(state: RoomState, view: ProjectedState): ProjectedState {
  const rules = new Map<string, Scene["autoWalls"]>();
  for (const id of Object.keys(view.scenes)) {
    const scene = Object.hasOwn(state.scenes, id) ? state.scenes[id] : undefined;
    if (scene && !scene.fogEnabled) rules.set(id, scene.autoWalls);
  }
  if (rules.size === 0) return view;
  const buildChunks: Record<string, BuildChunk> = Object.fromEntries(Object.entries(view.buildChunks).filter(([, chunk]) => !rules.has(chunk.sceneId)));
  for (const [key, chunk] of Object.entries(state.buildChunks)) {
    if (!rules.has(chunk.sceneId)) continue;
    const shown = projectChunkForPlayer(state.buildChunks, chunk, rules.get(chunk.sceneId));
    if (shown) buildChunks[key] = shown;
  }
  // Built by entries, so a scene keyed "__proto__" stays an own key.
  const scenes: Record<string, Scene> = Object.fromEntries(
    Object.entries(view.scenes).map(([id, scene]) => {
      if (!rules.has(id)) return [id, scene];
      const { autoWalls: _sent, ...rest } = scene;
      const rule = rules.get(id);
      return [id, rule === undefined ? rest : { ...rest, autoWalls: rule }];
    }),
  );
  return { ...view, buildChunks, scenes };
}

/**
 * A copy as the builds before creature numbers the table gives sent it
 * (shared/numbering.ts): with each creature's stored number, but none on a
 * player's copy of a creature they do not own, which carries no owners,
 * while its name is hidden. These rooms met no creature, so today's copies
 * carry none. The copy's other records, and the tokens' own prototype, are
 * kept as they are.
 */
function numberedBefore(state: RoomState, view: ProjectedState): ProjectedState {
  const tokens = Object.defineProperties(Object.create(Object.getPrototypeOf(view.tokens)) as ProjectedState["tokens"], Object.getOwnPropertyDescriptors(view.tokens));
  let changed = false;
  for (const id of Object.keys(view.tokens)) {
    const token = Object.getOwnPropertyDescriptor(view.tokens, id)!.value as ProjectedToken;
    const real = Object.hasOwn(state.tokens, id) ? state.tokens[id] : undefined;
    const stored = token.ownerIds === undefined && real?.nameHidden === true ? undefined : real?.number;
    if (token.number === stored) continue;
    const { number: _table, ...rest } = token;
    Object.defineProperty(tokens, id, { value: stored === undefined ? rest : { ...rest, number: stored }, enumerable: true, writable: true, configurable: true });
    changed = true;
  }
  return changed ? { ...view, tokens } : view;
}

/** A projection reads only the room, so rooms alike have projections alike, worked out once. */
const viewsByRoom = new Map<string, string[]>();

/** Each viewer's projection of the room as a digest, or what threw, marked where a record took a prototype (reparented). */
function viewsOf(state: RoomState): string[] {
  const room = digest(canon(state));
  const known = viewsByRoom.get(room);
  if (known) return known;
  const mark = reparented(state) ? "reparented " : "";
  const views = (["dm1", "p1", "p2"] as const).map((who) => {
    try {
      const view = numberedBefore(state, projectState(state, VIEWERS[who], { sceneId: null }));
      // A player's copy in the form this build sends it, recorded the same way (rankTestutil.ts).
      return mark + digest(canon(who === "dm1" ? view : storedFogOff(state, asPlayerCopy(view))));
    } catch (err) {
      return `threw ${(err as Error).message}`;
    }
  });
  viewsByRoom.set(room, views);
  return views;
}

/** What one replayed op gave: its refusal or throw, or a digest of the state, log, touched keys, global flag and undo it left, and the room's projections. */
type Line = { name: string; effect: string; views: string[] };

function step(name: string, state: RoomState, op: Op, who: Who, seq: number): { line: Line; result: ApplyResult | null } {
  let result: ApplyResult;
  try {
    result = applyOp(state, op, VIEWERS[who], { seq, at: AT, opVersion: STORED });
  } catch (err) {
    return { line: { name, effect: `threw ${(err as Error).message}`, views: [] }, result: null };
  }
  if (!result.ok) return { line: { name, effect: `refused ${result.code} ${result.message}`, views: [] }, result };
  const effect = canon({ state: result.state, log: result.log, touched: result.touched, global: result.global, inverse: result.inverse });
  return { line: { name, effect: `ok ${digest(effect)}`, views: viewsOf(result.state) }, result };
}

/** A snapshot of the room, as a row holds it and a load reads it back. */
function snapshot(state: RoomState): RoomState {
  return JSON.parse(JSON.stringify(state)) as RoomState;
}

/** The restore that takes back an op, as the server builds and stores one for an undo or a redo (server/rooms/undo.ts). */
function restoreOf(entries: RestoreEntry[], from: "undo" | "redo"): Op | null {
  const parsed = opSchema.safeParse(JSON.parse(JSON.stringify({ t: "sys.restore", entries, from, deps: true })));
  return parsed.success ? parsed.data : null;
}

const KINDS: Partial<Record<keyof RoomState, string>> = {
  scenes: "scene",
  members: "member",
  characters: "character",
  templates: "template",
  drawings: "drawing",
  labels: "label",
  handouts: "handout",
  monsters: "monster",
  savedEncounters: "savedEncounter",
  stamps: "stamp",
  lights: "light",
  journal: "journal",
  pins: "pin",
  rolls: "roll",
  handoutDocs: "handoutDoc",
  companionBlocks: "companionBlock",
  casts: "cast",
  traps: "trap",
};

/** Ops that delete what the op made under ids the room did not hold, such as the token keyed "undefined" an update of "constructor" wrote. */
function deletesOfNew(before: RoomState, after: RoomState): Op[] {
  const out: Op[] = [];
  const add = (op: unknown) => {
    const parsed = opSchema.safeParse(op);
    if (parsed.success) out.push(parsed.data);
  };
  for (const id of Object.keys(after.tokens)) if (!Object.hasOwn(before.tokens, id)) add({ t: "token.delete", tokenId: id });
  for (const [name, kind] of Object.entries(KINDS)) {
    const was = (before[name as keyof RoomState] ?? {}) as object;
    for (const id of Object.keys((after[name as keyof RoomState] ?? {}) as object)) {
      if (!Object.hasOwn(was, id)) add({ t: "sys.restore", entries: [{ key: `${kind}:${id}`, value: null }], from: "undo", deps: true });
    }
  }
  return out;
}

/**
 * The op, then the ops stored after it that read what it wrote: its undo
 * and that undo's redo, and deletes of what it made under new ids. A room
 * loads from a snapshot taken between any two ops, so where a snapshot of
 * the room the op left holds less than the room, each later op replays on
 * that snapshot too.
 */
function sequence(state: RoomState, op: Op, who: Who): Line[] {
  const first = step("op", state, op, who, 2);
  const lines = [first.line];
  if (!first.result?.ok) return lines;
  const after = first.result.state;
  const loaded = snapshotLoses(after) ? snapshot(after) : null;
  const undo = first.result.inverse ? restoreOf(first.result.inverse, "undo") : null;
  if (undo) {
    const undone = step("undo", after, undo, who, 3);
    lines.push(undone.line);
    if (loaded) lines.push(step("undo from a snapshot", loaded, undo, who, 3).line);
    const redo = undone.result?.ok && undone.result.inverse ? restoreOf(undone.result.inverse, "redo") : null;
    if (redo && undone.result?.ok) lines.push(step("redo", undone.result.state, redo, who, 4).line);
  }
  let room = after;
  let read = loaded;
  deletesOfNew(state, after).forEach((del, i) => {
    const kept = step("delete", room, del, "dm1", 5 + i);
    lines.push(kept.line);
    if (kept.result?.ok) room = kept.result.state;
    if (!read) return;
    const fromSnapshot = step("delete from a snapshot", read, del, "dm1", 5 + i);
    lines.push(fromSnapshot.line);
    if (fromSnapshot.result?.ok) read = fromSnapshot.result.state;
  });
  return lines;
}

/**
 * Every variant of one stored op with the sequence after each, summed up:
 * a digest of what the ops did, and every projection of the room after
 * each op that applied, in order. `lines` keeps the detail for a failure's
 * message.
 */
export type Group = { n: number; effects: string; views: string[]; lines: string[] };

export function groupOf(state: RoomState, op: Op, who: Who): Group {
  const lines: string[] = [];
  const effects: string[] = [];
  const views: string[] = [];
  const all = variants(op);
  for (const v of all) {
    for (const line of sequence(state, v.op, who)) {
      effects.push(`${v.label}: ${line.name} ${line.effect}`);
      lines.push(`${v.label}: ${line.name} ${line.effect} ${line.views.join(" ")}`);
      views.push(...line.views);
    }
  }
  return { n: all.length, effects: digest(effects.join("\n")), views, lines };
}

/** A digest of a group's projections, those at the places in `open` left out. */
export function viewsDigest(views: readonly string[], open: ReadonlySet<number>): string {
  return digest(views.map((v, i) => (open.has(i) ? "open" : v)).join("\n"));
}
