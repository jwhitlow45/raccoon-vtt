import type { AttachKind, RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { attachDistanceFt, attachReachFt, holderOf, isCreature, kindRefusal, linkLimitRefusal, onHolder, seatSpot } from "#shared/rules/attach.ts";
import { sizeCategory } from "#shared/rules/footprint.ts";
import { legStop } from "#shared/rules/movement.ts";
import { publicToken } from "#shared/rules/walkWorld.ts";
import { displayName } from "../../lib/scene.ts";
import { dropView, walkerOf, walkersStop } from "../movement/drop.ts";
import { attachAllowed, grappledSeen, type AttachViewer } from "./rights.ts";
import { walkersFor } from "./walk.ts";

/**
 * The Attach list (docs/design-v1-attach.md 4.1), as plain functions for
 * node --test: every token this viewer sees within reach of the selected
 * one, nearest first, each with the sentence its choice makes, and for the
 * DM the tokens up to 30 ft away under "Farther away", since the DM also
 * sets scenes up. A row is listed only when the viewer may use it: the
 * kind fits the two (kindRefusal), there is a seat, the limits and loops
 * hold on the viewer's own copy (linkLimitRefusal), the viewer has the
 * right (rights.ts), and for a player on a scene whose walls stop moves,
 * the step onto the seat is clear.
 */

/** At most this many rows, so a crowd never makes a list to scroll through on a phone. */
export const MAX_ROWS = 12;

/** How far the DM's list looks beyond reach. */
export const FARTHER_FT = 30;

/** What a row does, which picks its sentence. A carry onto an object is "Get on", a carry of the other token "Carry". */
export type AttachChoice = "ride" | "perch" | "getOn" | "carry" | "drag";

export type AttachRow = {
  key: string;
  /** The other token, whose portrait and name the row shows. */
  otherId: string;
  choice: AttachChoice;
  kind: AttachKind;
  carriedId: string;
  holderId: string;
  /** "Ride Warhorse", "Drag Goblin 2". */
  text: string;
  /** Where the carried token goes: its seat on the holder, or for a drag where it stands. */
  at: { x: number; y: number; elevation: number };
  /** Beyond reach, in the DM's "Farther away". */
  farther: boolean;
};

const KIND: Record<AttachChoice, AttachKind> = { ride: "ride", perch: "perch", getOn: "carry", carry: "carry", drag: "drag" };

function sentence(choice: AttachChoice, name: string): string {
  switch (choice) {
    case "ride":
      return `Ride ${name}`;
    case "perch":
      return `Perch on ${name}`;
    case "getOn":
      return `Get on ${name}`;
    case "carry":
      return `Carry ${name}`;
    case "drag":
      return `Drag ${name}`;
  }
}

/**
 * The choices a pair offers before any check, in the order they list:
 * the selected token getting on the other, then the other getting on it,
 * then a drag. A creature carried by a creature is one the viewer sees
 * Grappled, as the rules carry a grappled foe, and a friend is dragged.
 * Beyond reach nothing is dragged. A token already carried offers only
 * what it would hold, Carry and Drag: it changes mounts through Get off,
 * which charges the dismount (docs/design-v1-attach.md 4.3).
 */
function choicesFor(view: RoomState, selected: Token, other: Token, farther: boolean): AttachChoice[] {
  const out: AttachChoice[] = [];
  const carried = holderOf(view.tokens, selected) !== undefined;
  if (isCreature(selected) && !carried) {
    if (!isCreature(other)) out.push("getOn");
    else out.push(sizeCategory(selected) === "tiny" ? "perch" : "ride");
  }
  if (!isCreature(other) || !isCreature(selected) || grappledSeen(view, other)) out.push("carry");
  if (!farther && isCreature(selected) && isCreature(other)) out.push("drag");
  return out;
}

/** The rows for the selected token, nearest first, at most MAX_ROWS. */
export function attachRows(view: RoomState, viewer: AttachViewer, selectedId: string): AttachRow[] {
  const selected = view.tokens[selectedId];
  if (!selected) return [];
  const settings = view.meta.settings;
  const reach = attachReachFt(settings.feetPerCell);
  const others: { token: Token; feet: number; name: string }[] = [];
  for (const t of Object.values(view.tokens)) {
    if (!t || t.id === selected.id || t.sceneId !== selected.sceneId) continue;
    const feet = attachDistanceFt(settings, selected, t);
    if (feet > reach && (viewer.role !== "dm" || feet > FARTHER_FT)) continue;
    others.push({ token: t, feet, name: displayName(t) });
  }
  others.sort((a, b) => a.feet - b.feet || a.name.localeCompare(b.name) || (a.token.id < b.token.id ? -1 : 1));
  const near: AttachRow[] = [];
  const far: AttachRow[] = [];
  for (const { token: other, feet, name } of others) {
    const farther = feet > reach;
    for (const choice of choicesFor(view, selected, other, farther)) {
      const onOther = choice === "ride" || choice === "perch" || choice === "getOn";
      const row = checkedRow(view, viewer, choice, onOther ? selected : other, onOther ? other : selected, other, name, farther);
      if (row) (farther ? far : near).push(row);
    }
  }
  return [...near, ...far].slice(0, MAX_ROWS);
}

function checkedRow(view: RoomState, viewer: AttachViewer, choice: AttachChoice, carried: Token, holder: Token, other: Token, otherName: string, farther: boolean): AttachRow | null {
  const kind = KIND[choice];
  // Already joined so: nothing to choose.
  if (carried.attached?.to === holder.id && carried.attached.kind === kind) return null;
  const names = { carried: displayName(carried), holder: displayName(holder) };
  if (kindRefusal(kind, carried, holder, names) !== null) return null;
  let at = { x: carried.x, y: carried.y, elevation: carried.elevation };
  if (onHolder(kind)) {
    const seat = seatSpot(carried, holder);
    if (!seat) return null;
    at = { x: seat.x, y: seat.y, elevation: holder.elevation };
  }
  if (!attachAllowed(view, viewer, kind, carried, holder)) return null;
  // The DM's limits count the whole graph, a player's what every player sees and the two named (8.0).
  const inGraph = viewer.role === "dm" ? () => true : (t: { id: string }) => t.id === carried.id || t.id === holder.id || seenByAll(view, t.id);
  if (linkLimitRefusal(view.tokens, carried.id, holder.id, inGraph, names) !== null) return null;
  if (viewer.role === "player" && onHolder(kind) && stepStopped(view, carried, at)) return null;
  return { key: `${choice}:${carried.id}:${holder.id}`, otherId: other.id, choice, kind, carriedId: carried.id, holderId: holder.id, text: sentence(choice, otherName), at, farther };
}

/**
 * Whether a wall stops the step onto a seat, on a scene whose walls stop a
 * player's moves (shared/permissions.ts legCheck and draggedWalls): every
 * attach but a drag steps onto its seat, a grappled creature carried by a
 * creature included (docs/design-v1-attach.md 4.1), and what the stepping
 * token drags follows the step as on any walk (4.2). A token rising where it
 * stands crosses no edge.
 */
function stepStopped(view: RoomState, carried: Token, at: AttachRow["at"]): boolean {
  if (view.scenes[carried.sceneId]?.blockMovement !== true || (at.x === carried.x && at.y === carried.y)) return false;
  // Walked as the server's check walks it (drop.ts walkerOf): as its rider until clear of a holder every player sees that stands on the ground, then on the ground.
  const walking = walkerOf(dropView(view, "player"), carried);
  if (legStop(view, walking, at) !== null) return true;
  const from = { x: carried.x, y: carried.y, elevation: carried.elevation };
  return walkersStop(view, walking, [from, at], walkersFor(view, carried.id, "player")) !== null;
}

function seenByAll(view: RoomState, tokenId: string): boolean {
  const t = view.tokens[tokenId];
  return t !== undefined && publicToken(view, t, { role: "player" });
}

/** The empty list's words: what the list is for, and for a player how a grappled foe joins it. */
export function emptyWords(role: "dm" | "player"): string[] {
  const first = "Nothing within 5 ft to ride, carry or drag.";
  return role === "player" ? [first, "A grappled creature can be dragged once the DM marks it Grappled."] : [first];
}

/** Ride's one more question (4.1): controlled, the default, or independent. Only a ride asks it. */
export function asksControl(row: Pick<AttachRow, "kind">): boolean {
  return row.kind === "ride";
}

/** The op a row sends. `steer` only on a ride. */
export function attachOp(row: AttachRow, steer: boolean): ClientOp {
  return { t: "token.attach", tokenId: row.carriedId, to: row.holderId, kind: row.kind, ...(steer && row.kind === "ride" ? { steer: true as const } : {}), ...row.at };
}

/**
 * Whether the answer must come from the server before the list can close
 * (8.4): a controlled ride while a fight is set up changes the order, which
 * a player's copy cannot work out. The DM's copy can, as for any other
 * attach, which lands at once.
 */
export function waitsForServer(viewer: AttachViewer, view: Pick<RoomState, "encounter">, row: Pick<AttachRow, "kind">, steer: boolean): boolean {
  return viewer.role === "player" && row.kind === "ride" && steer && view.encounter !== null;
}

/** What became of an attach the server answered, as the store tells it (state/types.ts OpAnswer). */
export type AttachAnswer = "taken" | "refused" | "unknown";

/**
 * The list's sends (4.1, 8.4), kept free of React so a randomized test can
 * drive it: one row waits for the server at a time, a second tap meanwhile
 * sends nothing, an answer closes the list unless it was a refusal, which
 * leaves the list open for another choice, and once the list has gone, or
 * for a row no longer waiting, an answer does nothing.
 */
export class AttachSends {
  #pending: string | null = null;
  #gone = false;

  /** The row waiting for its answer, which shows busy. */
  get pending(): string | null {
    return this.#pending;
  }

  /** A tap on a row: whether to send its op. A row whose answer the list waits for (waitsForServer) waits from now. */
  tap(key: string, waits: boolean): boolean {
    if (this.#gone || this.#pending !== null) return false;
    if (waits) this.#pending = key;
    return true;
  }

  /** The op never left this device (the store refused to queue it): the row waits no more. */
  unsent(key: string): void {
    if (this.#pending === key) this.#pending = null;
  }

  /** The server's answer for a row: "close" the list, "stay" open after a refusal, or null when it no longer waits for that row. */
  answer(key: string, answer: AttachAnswer): "close" | "stay" | null {
    if (this.#gone || this.#pending !== key) return null;
    this.#pending = null;
    return answer === "refused" ? "stay" : "close";
  }

  /** The list closed or unmounted: nothing more happens. */
  gone(): void {
    this.#gone = true;
    this.#pending = null;
  }
}
