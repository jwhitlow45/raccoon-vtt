import { createStore } from "zustand/vanilla";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { SrdBlocks } from "#shared/rules/opportunity.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { DragRead } from "../measure/movement.ts";
import type { Point, StopBlocker } from "./drop.ts";
import type { StopNote } from "./teleport.ts";

/**
 * A lone token's drag held at a wall or a ledge (docs/design/design-v1-maps-vision.md
 * 4.1): the spot the preview stays on and what is in the way. The canvas
 * writes it only when it changes, never on every pointer frame, and the
 * movement layer draws the red outline and the label from it. `noWay`
 * marks a drag that found no way a creature it drags beside it can follow
 * (drop.ts holdLabel, docs/design/design-v1-attach.md 4.2), or a creature
 * that closes the way (LP40-MOVE-2).
 */
export type Hold = { tokenId: string; at: Point; blocker: StopBlocker; noWay?: true };

export const holdSlot = scopeSlot(() => createStore<{ hold: Hold | null }>(() => ({ hold: null })));

export function sameHold(a: Hold | null, b: Hold | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tokenId === b.tokenId && a.at.x === b.at.x && a.at.y === b.at.y && a.blocker === b.blocker && a.noWay === b.noWay;
}

/**
 * The note after a stopped drop, with its ghost and "Teleport here", and
 * whether the teleport is on its way (the button then reads
 * "Teleporting…" and ignores another tap).
 */
export type NoteState = { note: StopNote | null; busy: boolean };

export const stopNoteSlot = scopeSlot(() => createStore<NoteState>(() => ({ note: null, busy: false })));

/**
 * A lone token drag's walk as the board draws it (docs/design/design-v1-movement.md
 * 3.1): where the drop would land, the route's corners between, top-left as
 * the token's position is, and how it reads. The drag writes it when the
 * spot or the search's answer changes, never on every pointer frame.
 */
export type DragRoute = {
  tokenId: string;
  /** Where the drop would land. */
  to: Point;
  /** The drop squeezes it in at `to`. */
  squeeze?: true;
  /** The walk is cut short of the finger's spot, after 64 pieces: `to` is where it lands. */
  cut: boolean;
  /** The route's corners, none for the straight leg. */
  corners: Point[];
  /** The search has not settled the spot yet: the line waits grey and straight. */
  searching: boolean;
  /** The finger is up and the drop waits at the ghost for the search. */
  waiting: boolean;
  read: DragRead;
  /** The creature whose space the walk would end in, by the name this viewer sees. */
  endsIn: string | null;
};

export const routeSlot = scopeSlot(() => createStore<{ route: DragRoute | null }>(() => ({ route: null })));

/**
 * The creatures whose reach a lone drag's walk leaves, for their dashed
 * amber rings (docs/design/design-v1-opportunity-attacks.md 1): written with
 * the route, and cleared at the drop, a cancel or the drag's end. With the
 * height the walk lands at, which a drop's kept line matches its leg by.
 */
export type ReachMarks = { tokenId: string; ids: readonly string[]; elevation: number };

export const reachSlot = scopeSlot(() => createStore<{ reach: ReachMarks | null }>(() => ({ reach: null })));

/**
 * The creatures a drop's line named, so the DM's toast skips the leg that
 * drop lands, which this device's own line already showed (section 1, The
 * DM's toast). Kept for its turn (`turn`, as reachTurn names it) and for
 * the token's first leg since the drop that ends where it was dropped, x,
 * y and height: a leg whose occurrence is past `after`, the last the turn's
 * jobs had given at the drop (TurnLeaves). So an earlier leg to the same
 * spot, a later turn's, or one at another height is never skipped. Only a
 * line that named creatures is kept, and only the last few drops.
 */
export type ShownLeaves = { tokenId: string; turn: string; after: number; x: number; y: number; elevation: number; ids: readonly string[] };

export const shownLeavesSlot = scopeSlot(() => createStore<{ shown: readonly ShownLeaves[] }>(() => ({ shown: [] })));

/** How many drops' lines the toast's skip remembers: more than a turn's drops can land before it reads them. */
export const SHOWN_LEAVES_KEPT = 8;

/** Remembers what a drop's line named. Two drops to one spot are two legs, so each is kept. */
export function rememberShown(shown: readonly ShownLeaves[], next: ShownLeaves): ShownLeaves[] {
  return [...shown, next].slice(-SHOWN_LEAVES_KEPT);
}

/**
 * The turn the DM's toasts read and a drop's line is kept for: the jobs'
 * room and view (`key`), and the turn's row, round and seq. A room from
 * before turns carried a seq reads the turn of the paths its jobs hold.
 */
export function reachTurn(key: string | null, encounter: { activeEntryId: string | null; round?: number; turnStart?: { seq?: number } } | null | undefined, pathTurn: number | undefined): string {
  return `${key ?? ""}|${encounter?.activeEntryId ?? ""}|${encounter?.round ?? ""}|${encounter?.turnStart?.seq ?? pathTurn ?? ""}`;
}

/** A chunk of the SRD's data the turn's scans read: loaded, failed, or still on its way (null). */
export type TurnChunks = { rolls: SrdRolls | "failed" | null; monsters: SrdBlocks | "failed" | null };

/**
 * What the turn's leg jobs (combat/opportunity.ts) tell a drag, so its line
 * skips the creatures earlier legs left: whether notices run on this page
 * (the room's switch and this device's part), the SRD chunks they loaded,
 * and for each mover of the turn its turn's seq, the creatures its stored
 * legs left, and whether every one of that turn's jobs has finished. Until
 * they have, the drag names no one (section 4, Leg jobs). `key` names the
 * jobs' room and view, and `last` is the last occurrence id they gave, for
 * the line a drop keeps (ShownLeaves).
 */
export type TurnLeaves = {
  on: boolean;
  key: string | null;
  last: number;
  chunks: TurnChunks;
  movers: Readonly<Record<string, { turn: number; skip: ReadonlySet<string>; settled: boolean }>>;
};

export const NO_TURN_LEAVES: TurnLeaves = { on: false, key: null, last: 0, chunks: { rolls: null, monsters: null }, movers: {} };

export const turnLeavesSlot = scopeSlot(() => createStore<TurnLeaves>(() => NO_TURN_LEAVES));
