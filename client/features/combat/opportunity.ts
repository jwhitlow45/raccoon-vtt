import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { PathStop, RoomState, TokenPath, Viewer } from "#shared/model.ts";
import type { Spot } from "#shared/rules/path.ts";
import { chunksNeeded, opportunityNoticesOn, reachInput, reachScan, reconcileLegs, rowStands, SLICE_WORK, type Chunks, type LegRecord, type ReachLeave, type ReachView, type SrdBlocks } from "#shared/rules/opportunity.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { scopeSlot, useRoomScope, type RoomScope } from "../../state/scope.ts";
import { useRoomView, useRoomYouIfAny } from "../../state/view.ts";
import { turnMoverId } from "../attach/turns.ts";
import { pathNow } from "../measure/movement.ts";
import { useModule } from "../modules/Gate.tsx";
import { NO_TURN_LEAVES, turnLeavesSlot, type TurnChunks, type TurnLeaves } from "../movement/store.ts";
import { answersFor } from "./logic.ts";

/*
 * The turn's leg jobs (docs/design/design-v1-opportunity-attacks.md 4, Leg
 * jobs, D-261128-057): each leg of a mover's path this turn is a movement
 * occurrence, scanned once by a job that takes the room as the leg first
 * appears on this device, waits until the SRD chunks its creatures need have
 * loaded or failed, and finishes its slices on that snapshot. Later changes
 * only remove rows, through `rowStands` over the room as it is now, so a push
 * of the goblin or a door closed after the walk never adds or drops one. The
 * room it reads is the server's copy, so a row leaves once the server takes
 * the change, and its Reaction used shows busy until then.
 *
 * Jobs queue and never cancel each other. A job goes only when its leg goes
 * (reconcileLegs removes it: an Undo, or a rewrite it cannot match), or the
 * room, the view or the turn it belongs to does. A join keeps its parts'
 * jobs, and its result is theirs together. Every leg scans with no creature
 * skipped, and the turn takes each creature's first leave of a leg that
 * provokes, so "Doesn't count" on a leg hands a creature's row to its next
 * leave, and pressing it back brings the row back.
 */

/** A leave as its job found it, with whether its reach was read from a block (`known`), for a player's "(5 ft counted)". */
export type Left = ReachLeave & { known: boolean };

/** A row of a mover's notice: a creature whose reach the turn's walk left, as the turn's first leave of it. */
export type ReachRow = { moverId: string; leg: number; left: Left };

/**
 * One occurrence's job as it stands: its result once done, where its leg
 * ended, for the toast's check of a drop's own line, and whether it
 * provokes now: by its own mark, kept from while it was a leg of its own,
 * and by every join's that holds it.
 */
export type PartOut = { id: number; to: Spot; provokes: boolean; done: boolean; over: boolean; leaves: readonly Left[] };

/** A leg as the jobs hold it: its occurrence, whether any of its parts provokes now, the provoking parts' result so far, and the occurrences behind it (itself, or a join's parts). */
export type LegOut = { id: number; provokes: boolean; done: boolean; over: boolean; leaves: readonly Left[]; parts: readonly PartOut[] };

/** One mover's notice this turn, on this device. */
export type MoverOut = {
  turn: number;
  legs: readonly LegOut[];
  rows: readonly ReachRow[];
  /** A job of the turn still waits for its chunks or scans. */
  checking: boolean;
  /** A leg passed the hard cap: "Too many creatures here to check this walk." */
  over: boolean;
};

export type TurnReach = {
  key: string | null;
  movers: Readonly<Record<string, MoverOut>>;
  /** Bumped on every publish that brought a row not shown before this turn on this device (the shown set), with those rows. */
  fresh: { seq: number; rows: readonly ReachRow[] };
};

const EMPTY: TurnReach = { key: null, movers: {}, fresh: { seq: 0, rows: [] } };

/** What the jobs run on: a timer between frames, the SRD's loaders, the tab's storage for the shown set, and the work a slice does (SLICE_WORK). Tests pass their own. */
export type LegJobsDeps = {
  later(run: () => void): () => void;
  load: { rolls(): Promise<SrdRolls>; monsters(): Promise<SrdBlocks> };
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  slice?: number;
};

/** The room, the viewer and whether notices run, as one sync gives them. `key` names the room and the view (role, member, View as a player): a new one starts afresh. */
/** `confirmed`: the server's copy under `view`, which rows leave by. Left out, they leave by `view`. */
export type SyncInput = { key: string; view: ReachView | null; confirmed?: ReachView | null; viewer: Viewer | null; on: boolean };

type Job = {
  id: number;
  moverId: string;
  /** The index of the leg's end stop in `path.stops` when it arrived, as reachInput names its legs. */
  end: number;
  view: ReachView;
  path: TokenPath;
  viewer: Viewer;
  need: { rolls: boolean; monsters: boolean };
  run: Generator<number, ReachLeave[] | "over"> | null;
  known: ReadonlyMap<string, boolean>;
  result: readonly Left[] | "over" | null;
  cancelled: boolean;
};

/** `marks`: each record's provoking mark by its id, a leg's as its stop holds it now and a join's parts' as they last held it as legs (marksOf). */
type Mover = { id: string; turn: number; sceneId: string; records: LegRecord[]; marks: ReadonlyMap<number, boolean> };

/** Where the shown set lives in the tab's storage: one room's one turn, so a reload announces no old row. */
export const SHOWN_KEY = "rvtt.opportunityShown";

/** A leg provokes while it counts and its holder did not carry it (a carried leg is always uncounted, docs/design/design-v1-attach.md 7.2). */
export function provokesAt(stop: PathStop): boolean {
  return stop.uncounted !== true && stop.carried !== true;
}

/** A path's legs, each from the stop before to its end stop, as reachInput reads them. */
export function legsOf(path: TokenPath): { from: PathStop; to: PathStop }[] {
  return path.stops.slice(1).map((to, i) => ({ from: path.stops[i]!, to }));
}

/**
 * The creatures whose moves this turn the notices read, with their paths:
 * the turn's creature and a controlled mount sharing its turn
 * (attach/turns.ts turnMoverId), each where this viewer may read the notice,
 * the DM for every one and a player for the turn they answer for. A player's
 * copy that holds no acting row reads the creatures they answer for that
 * came with a path (measure/movement.ts pathNow, review AT-HIDDENPATH).
 */
export function turnMovers(view: ReachView, viewer: Viewer): { id: string; path: TokenPath }[] {
  const encounter = view.encounter;
  if (!encounter || !(encounter.started ?? encounter.activeEntryId !== null)) return [];
  const ids: string[] = [];
  if (encounter.activeEntryId === null) {
    if (viewer.role === "player") for (const t of Object.values(view.tokens)) if (t.path && answersFor(view, viewer, { tokenId: t.id })) ids.push(t.id);
  } else {
    const creature = encounter.entries.find((e) => e.id === encounter.activeEntryId)?.tokenId;
    if (creature === undefined || (viewer.role !== "dm" && !answersFor(view, viewer, { tokenId: creature }))) return [];
    ids.push(creature);
    const mount = turnMoverId(view);
    if (mount !== undefined && mount !== creature) ids.push(mount);
  }
  return ids.flatMap((id) => {
    const token = view.tokens[id];
    const path = token ? pathNow(encounter, token, viewer.role) : null;
    return token && path ? [{ id, path }] : [];
  });
}

/** The records a record stands for: itself, or the parts a join holds, down to the legs that have jobs. */
function partsOf(record: LegRecord): LegRecord[] {
  return record.parts ? record.parts.flatMap(partsOf) : [record];
}

function occurrences(record: LegRecord): number[] {
  return partsOf(record).map((r) => r.id);
}

/**
 * Each record's provoking mark: a leg's from its stop now, and a part's
 * inside a join kept as it was while that part was a leg of its own. The
 * reducer's join counts unless both legs were uncounted, and is carried
 * only when both were (path.ts withStop), so its own mark would make a
 * Teleport, a "Doesn't count" or a carried part provoke once joined with a
 * walked one. A join made inside one update was never a leg, so it has no
 * mark and leaves its parts to theirs.
 */
function marksOf(records: readonly LegRecord[], legs: readonly { to: PathStop }[], was: ReadonlyMap<number, boolean>): Map<number, boolean> {
  const out = new Map<number, boolean>();
  const keep = (record: LegRecord): void => {
    const mark = was.get(record.id);
    if (mark !== undefined) out.set(record.id, mark);
    record.parts?.forEach(keep);
  };
  records.forEach((record, i) => {
    out.set(record.id, provokesAt(legs[i]!.to));
    record.parts?.forEach(keep);
  });
  return out;
}

/** The parts a record stands for, each provoking only where its own mark and every join's above it say so. */
function provokingParts(record: LegRecord, marks: ReadonlyMap<number, boolean>, above = true): { part: LegRecord; provokes: boolean }[] {
  const here = above && (marks.get(record.id) ?? true);
  return record.parts ? record.parts.flatMap((p) => provokingParts(p, marks, here)) : [{ part: record, provokes: here }];
}

export class LegJobs {
  readonly store: StoreApi<TurnReach> = createStore<TurnReach>(() => EMPTY);
  /** What a drag reads of the jobs (movement/store.ts turnLeavesSlot). */
  readonly leaves: StoreApi<TurnLeaves>;
  readonly #deps: LegJobsDeps;
  #key: string | null = null;
  #view: ReachView | null = null;
  #confirmed: ReachView | null = null;
  #viewer: Viewer | null = null;
  #movers = new Map<string, Mover>();
  #jobs = new Map<number, Job>();
  #queue: Job[] = [];
  #nextId = 1;
  #timer: (() => void) | null = null;
  #chunks: TurnChunks = { rolls: null, monsters: null };
  #loading = { rolls: false, monsters: false };
  #freshSeq = 0;

  constructor(deps: LegJobsDeps, leaves: StoreApi<TurnLeaves> = createStore<TurnLeaves>(() => NO_TURN_LEAVES)) {
    this.#deps = deps;
    this.leaves = leaves;
  }

  /** Reads a new room, viewer or setting: legs that appeared get jobs, legs gone lose theirs, and the rows read the room as it is now. */
  sync(input: SyncInput): void {
    const { view, viewer } = input;
    if (!input.on || !view || !viewer) {
      this.#reset(null);
      return;
    }
    if (input.key !== this.#key) this.#reset(input.key);
    const confirmed = input.confirmed ?? null;
    if (view === this.#view && viewer === this.#viewer && confirmed === this.#confirmed) return;
    this.#view = view;
    this.#confirmed = confirmed;
    this.#viewer = viewer;
    const now = turnMovers(view, viewer);
    const kept = new Set(now.map((m) => m.id));
    for (const [id, mover] of this.#movers) {
      const next = now.find((m) => m.id === id);
      const token = view.tokens[id];
      // A new turn, a floor or scene left, or a mount no longer sharing the turn: what its jobs scanned belongs to a turn that is over.
      if (!kept.has(id) || !next || next.path.turn !== mover.turn || token?.sceneId !== mover.sceneId) this.#dropMover(id);
    }
    for (const { id, path } of now) {
      const token = view.tokens[id]!;
      let mover = this.#movers.get(id);
      if (!mover) {
        mover = { id, turn: path.turn, sceneId: token.sceneId, records: [], marks: new Map() };
        this.#movers.set(id, mover);
      }
      const legs = legsOf(path);
      const got = reconcileLegs(mover.records, legs, () => this.#nextId++);
      mover.records = got.legs;
      mover.marks = marksOf(got.legs, legs, mover.marks);
      for (const record of got.added) {
        if (record.parts) continue;
        const end = got.legs.indexOf(record) + 1;
        const job: Job = { id: record.id, moverId: id, end, view, path, viewer, need: chunksNeeded(view, id), run: null, known: new Map(), result: null, cancelled: false };
        this.#jobs.set(job.id, job);
        this.#queue.push(job);
      }
      // A chunk the mover's walk will need loads now, so the turn's first drag can read it too.
      const need = chunksNeeded(view, id);
      if (need.rolls) this.#ensure("rolls");
      if (need.monsters) this.#ensure("monsters");
    }
    this.#cancelUnheld();
    this.#publish();
    this.#pump();
  }

  /** Stops every job and timer, as the page goes. */
  dispose(): void {
    this.#reset(null);
  }

  #reset(key: string | null): void {
    for (const job of this.#jobs.values()) job.cancelled = true;
    this.#jobs.clear();
    this.#queue = [];
    this.#movers.clear();
    this.#timer?.();
    this.#timer = null;
    this.#key = key;
    this.#view = null;
    this.#confirmed = null;
    this.#viewer = null;
    if (this.store.getState() !== EMPTY) this.store.setState({ ...EMPTY, key, fresh: this.store.getState().fresh }, true);
    this.leaves.setState({ on: key !== null, chunks: this.#chunks, movers: {} }, true);
  }

  #dropMover(id: string): void {
    this.#movers.delete(id);
    for (const job of this.#jobs.values()) if (job.moverId === id) job.cancelled = true;
    this.#cancelUnheld();
  }

  /** Cancels every job no record holds any more, directly or through a join. */
  #cancelUnheld(): void {
    const held = new Set<number>();
    for (const mover of this.#movers.values()) for (const r of mover.records) for (const id of occurrences(r)) held.add(id);
    for (const [id, job] of this.#jobs) {
      if (held.has(id) && !job.cancelled) continue;
      job.cancelled = true;
      this.#jobs.delete(id);
    }
    this.#queue = this.#queue.filter((j) => !j.cancelled);
  }

  #ensure(kind: "rolls" | "monsters"): void {
    if (this.#chunks[kind] !== null || this.#loading[kind]) return;
    this.#loading[kind] = true;
    const settle = (value: SrdRolls | SrdBlocks | "failed") => {
      this.#loading[kind] = false;
      this.#chunks = { ...this.#chunks, [kind]: value };
      this.#publish();
      this.#pump();
    };
    (kind === "rolls" ? this.#deps.load.rolls() : this.#deps.load.monsters()).then(settle, () => settle("failed"));
  }

  /** Runs the queue's first job a slice at a time, between frames, until it finishes. */
  #pump(): void {
    if (this.#timer) return;
    const job = this.#queue[0];
    if (!job) return;
    if (!job.run) {
      if (job.need.rolls) this.#ensure("rolls");
      if (job.need.monsters) this.#ensure("monsters");
      const { rolls, monsters } = this.#chunks;
      if ((job.need.rolls && rolls === null) || (job.need.monsters && monsters === null)) return;
      // A chunk the walk does not need is never read, so either word stands for it.
      const chunks: Chunks = { rolls: rolls ?? "failed", monsters: monsters ?? "failed" };
      const built = reachInput(job.view, job.moverId, job.path, chunks, job.viewer);
      const leg = built?.legs.find((l) => l.id === job.end);
      if (!built || !leg) {
        this.#finish(job, []);
        return;
      }
      job.known = new Map(built.input.reactors.map((r) => [r.id, r.known]));
      // Scanned as if it provokes: whether it does is read from the path now, so "Doesn't count" pressed and pressed back keeps its rows.
      job.run = reachScan(built.input, { ...leg, id: job.id, provokes: true }, new Set(), this.#deps.slice ?? SLICE_WORK);
    }
    this.#timer = this.#deps.later(() => {
      this.#timer = null;
      if (job.cancelled) {
        this.#pump();
        return;
      }
      const step = job.run!.next();
      if (step.done) this.#finish(job, step.value === "over" ? "over" : step.value.map((l) => ({ ...l, known: job.known.get(l.id) ?? false })));
      else this.#pump();
    });
  }

  #finish(job: Job, result: readonly Left[] | "over"): void {
    job.result = result;
    job.run = null;
    this.#queue = this.#queue.filter((j) => j !== job);
    this.#publish();
    this.#pump();
  }

  #publish(): void {
    const view = this.#view;
    const viewer = this.#viewer;
    if (!view || !viewer) return;
    const movers: Record<string, MoverOut> = {};
    const leaves: Record<string, TurnLeaves["movers"][string]> = {};
    const fresh: ReachRow[] = [];
    const shown = this.#readShown();
    const kept = this.#confirmed ?? view;
    for (const mover of this.#movers.values()) {
      const legs: LegOut[] = mover.records.map((record) => {
        const parts = provokingParts(record, mover.marks).map(({ part, provokes }): PartOut => {
          const result = this.#jobs.get(part.id)?.result ?? null;
          return { id: part.id, to: part.to, provokes, done: result !== null, over: result === "over", leaves: result === null || result === "over" ? [] : result };
        });
        // A join's result is its provoking parts' together, each creature at its first leave (JOIN-UNION).
        const provoking = parts.filter((p) => p.provokes);
        const union = provoking.flatMap((p) => p.leaves).filter((l, k, all) => all.findIndex((m) => m.id === l.id) === k);
        return { id: record.id, provokes: provoking.length > 0, done: parts.every((p) => p.done), over: provoking.some((p) => p.over), leaves: union, parts };
      });
      const seen = new Set<string>();
      const rows: ReachRow[] = [];
      for (const leg of legs) {
        if (!leg.provokes) continue;
        for (const left of leg.leaves) {
          if (seen.has(left.id)) continue;
          seen.add(left.id);
          if (view.tokens[left.id] !== undefined && rowStands(kept, left, viewer)) rows.push({ moverId: mover.id, leg: leg.id, left });
        }
      }
      const checking = legs.some((l) => !l.done);
      movers[mover.id] = { turn: mover.turn, legs, rows, checking, over: legs.some((l) => l.over) };
      leaves[mover.id] = { turn: mover.turn, skip: seen, settled: !checking };
      for (const row of rows) {
        const id = `${row.moverId}|${row.left.id}`;
        if (shown.ids.has(id) && shown.turn === mover.turn) continue;
        fresh.push(row);
      }
    }
    const turns = [...this.#movers.values()].map((m) => m.turn);
    if (fresh.length > 0) {
      this.#freshSeq++;
      this.#writeShown(turns[0] ?? 0, [...(turns[0] === shown.turn ? shown.ids : []), ...fresh.map((r) => `${r.moverId}|${r.left.id}`)]);
    }
    this.store.setState({ key: this.#key, movers, fresh: fresh.length > 0 ? { seq: this.#freshSeq, rows: fresh } : this.store.getState().fresh }, true);
    this.leaves.setState({ on: true, chunks: this.#chunks, movers: leaves }, true);
  }

  /** The shown set for this room's view: the row ids shown this turn, by the turn's seq, empty where storage fails or holds another room's or turn's. */
  #readShown(): { turn: number | null; ids: ReadonlySet<string> } {
    try {
      const raw = this.#deps.storage?.getItem(SHOWN_KEY);
      const got = raw ? (JSON.parse(raw) as { key?: unknown; turn?: unknown; ids?: unknown }) : null;
      if (got && got.key === this.#key && typeof got.turn === "number" && Array.isArray(got.ids)) return { turn: got.turn, ids: new Set(got.ids.filter((x): x is string => typeof x === "string")) };
    } catch {
      // Storage that fails keeps nothing, so every row is new once.
    }
    const kept = this.#memoryShown;
    return kept && kept.key === this.#key ? kept : { turn: null, ids: new Set() };
  }

  /** Kept in memory too, so a tab whose storage fails still announces a row once. */
  #memoryShown: { key: string | null; turn: number; ids: ReadonlySet<string> } | null = null;

  #writeShown(turn: number, ids: readonly string[]): void {
    this.#memoryShown = { key: this.#key, turn, ids: new Set(ids) };
    try {
      this.#deps.storage?.setItem(SHOWN_KEY, JSON.stringify({ key: this.#key, turn, ids }));
    } catch {
      // As above: the memory copy holds it.
    }
  }
}

function sessionStore(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

const PAGE_DEPS: LegJobsDeps = {
  later: (run) => {
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  },
  load: { rolls: loadSrdRolls, monsters: loadMonsters },
  storage: sessionStore(),
};

/** The Room page's jobs, one set per page, whichever surfaces read them. */
export const legJobsSlot = scopeSlot(
  () => ({ jobs: null as LegJobs | null }),
  (slot) => slot.jobs?.dispose(),
);

/** The page's jobs, made on first use. */
export function turnJobs(scope: Pick<RoomScope, "get">): LegJobs {
  const slot = scope.get(legJobsSlot);
  slot.jobs ??= new LegJobs(PAGE_DEPS, scope.get(turnLeavesSlot));
  return slot.jobs;
}

/** Whether notices run on this page: the part shows on this device, the room's switch is on, and this is no table display's page. */
export function noticesOn(input: { shown: boolean; room: { display: boolean } | null; view: Pick<ReachView, "meta"> | null }): boolean {
  return input.shown && input.room !== null && !input.room.display && input.view !== null && opportunityNoticesOn(input.view.meta.settings);
}

/**
 * The turn's notices on this page: syncs the jobs with the room as this
 * viewer holds it, while the room's notices and this device's part are on,
 * and reads what they found. Every surface that shows them calls it, and
 * the jobs run once for all of them. A table display reads none.
 */
export function useTurnReach(): TurnReach {
  const scope = useRoomScope();
  const jobs = useMemo(() => turnJobs(scope), [scope]);
  const room = useRoomYouIfAny();
  const view = useRoomView((s) => s.view);
  // The copy `view` is built on, read as the view is (GroupSave.tsx reads it so too).
  const confirmed = useRoomView((s) => s.confirmed as RoomState | null);
  const you = useRoomView((s) => s.you);
  const shown = useModule("opportunity");
  const viewer = useMemo(() => (you ? { memberId: you.memberId, role: you.role } : null), [you]);
  const on = noticesOn({ shown, room, view });
  const key = `${room?.roomId ?? ""}|${viewer?.role ?? ""}|${viewer?.memberId ?? ""}`;
  useEffect(() => jobs.sync({ key, view, confirmed, viewer, on }), [jobs, key, view, confirmed, viewer, on]);
  return useStore(jobs.store);
}
