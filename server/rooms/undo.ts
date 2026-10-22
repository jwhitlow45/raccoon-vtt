import { parseKey } from "#shared/keys.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { MAX_KEPT_ROUTES, MAX_RESTORE_ENTRIES, onPlayerUndoStack, type Op, type OpOf, type RefusalCode, type RestoreEntry } from "#shared/protocol.ts";

/** A route as `token.move` carries it. */
export type KeptRoute = NonNullable<OpOf<"token.move">["route"]>;
import { guardMatches } from "#shared/reducer/misc.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { LIMITS } from "#shared/limits.ts";
import { inSightOfNonOwners, stableStringify } from "#shared/project.ts";
import { holderOf } from "#shared/rules/attach.ts";
import { addTally, describeTally, type Tally } from "./undoLabels.ts";

/**
 * Per-member undo and redo stacks (design 7.7). They hold the inverses the
 * reducer returned, the last 50 per stack, in memory only: a restart loses
 * them, and that is fine because only the resolved `sys.restore` op is ever
 * logged.
 *
 * The DM's stack records every DM op. A player's stack records only their
 * own drawing ops, their token moves, a change of elevation or facing
 * alone included (isPoseOp), and their resizes (isResizeOp). A new op clears the member's redo
 * stack, as every editor does, so redo never replays an inverse made
 * against state that has since moved on.
 */
export const UNDO_DEPTH = 50;

/** The fields a move sets: a squeeze too, which stops a token in a narrow opening (docs/design-v1-maps-vision.md 4.1). */
type Place = Pick<Token, "x" | "y" | "elevation" | "rotation" | "squeeze">;

/**
 * Where a token stands: its scene and its place there, the path of its
 * turn that got it there, and its footprint's size. The scene counts
 * because the DM can send a token to another scene without changing its
 * place, and a spot on one map means nothing on another. The path counts
 * because a token moved away and back stands where it stood, with legs on
 * its path that a move's undo, which puts back the path it had, would
 * erase. The size counts because a resize can leave the place as it was
 * (docs/design-v1-token-window.md 8.7), and an undo of a move or a resize
 * would put back a footprint someone changed since.
 */
export type Pose = Place &
  Pick<Token, "sceneId" | "size" | "w" | "h"> & {
    path: string;
    attached: string;
    /**
     * The token rode along when the step was made by a chain not every
     * player sees (docs/design-v1-attach.md 8.3): a silent passenger, which
     * its undo and redo take back quietly or leave as it is, and which never
     * answers. Fixed when the step is made, so no hidden change since can
     * turn it into a token the answer reads. Not part of the comparison.
     */
    silent?: true;
    /**
     * The op named the token: a root of its groups (shared/rules/attach.ts
     * moveGroups), which never rides as a passenger. Kept so a redo built
     * from the step classes its passengers by the same roots.
     */
    root?: true;
  };

/** Which tokens the step's player sees now: a pose holds a link only as their copy shows it (docs/design-v1-attach.md 8.3). */
export type Shows = (tokenId: string) => boolean;

/**
 * One undo step: the restore that takes it back, what it did in words
 * (undoLabels.ts) for the toast that names it, and the gesture it came
 * from, if any.
 *
 * A player's token moves and resizes also keep `poses`, where and how big
 * the step left each token. Such a step takes back the move or the resize
 * alone (poseRestore), so it is refused only when someone moved or resized
 * the token since, not when the DM changed its HP.
 *
 * `origin` is the client op that made the step, the newest one of a merged
 * gesture. An undo that names it (the token bar's "Undo move") takes back
 * this step or nothing: the button's device cannot see an undo or a new
 * step from the member's other devices, and must not take back an older
 * step in its place.
 */
export type UndoEntry = {
  entries: RestoreEntry[];
  label: string;
  group?: string;
  poses?: Record<string, Pose>;
  origin?: Origin;
  tally?: Tally;
  /** The first op's own phrase, kept while `label` names the step by its tally, for when a later op of the group ends the tally. */
  opLabel?: string;
  /**
   * The step is a teleport's move (docs/design-v1-maps-vision.md 4.1), so
   * its redo is built with `teleport` and skips the wall and ledge test, as
   * the teleport did. Undone and redone it stays one.
   */
  teleport?: true;
  /**
   * The routes of the step's walks, by token, in the order the moves were
   * made (docs/design-v1-movement.md 7.4), a plain move kept as one piece.
   * A redo built from the step carries them, so a player's redo meets the
   * walls along each piece. Kept only while every move the step merged left
   * one, and `routed` once one of them walked a real route: a step of plain
   * moves alone redoes as before, by the straight leg.
   */
  routes?: Record<string, KeptRoute[]>;
  routed?: true;
  /**
   * The controlled rides a player's step ended or made, each with its
   * turn's seq (docs/design-v1-attach.md 8.3). Its undo and its redo carry
   * them, so a ride put back on the same turn shares the turn again.
   */
  rides?: Ride[];
};

/** A controlled ride on one turn's list of mounts. */
export type Ride = { seq: number; mount: string; rider: string };

/** One walk an op made, for the step's routes: the token, its route, and whether it bent or cost extra (UndoEntry.routes). */
export type Walk = { tokenId: string; route: KeptRoute; routed: boolean };

/** A client op: the client it came from (connection.ts clientKey) and its `n`. */
export type Origin = { client: string; n: number };

type Stacks = { undo: UndoEntry[]; redo: UndoEntry[] };

export class UndoStacks {
  #members = new Map<string, Stacks>();

  /**
   * Whether an applied op by this role goes on the stack at all. A scene's
   * new thumbnail alone does not: a DM device uploads it in the background
   * (docs/design-v1-maps-vision.md 3.3), and Ctrl+Z must take back what the
   * DM did, not a picture nobody asked for. Nor does an ask to change a
   * roll or its end (docs/design-v1-roll-request.md 7.5): the ask is the
   * player's, so a DM's undo of Keep would bring back an ask the player was
   * told was settled. Keep stands, as the Allow's roll does. Nor does a
   * close of an ask for saves, for the same reason.
   */
  static records(role: "dm" | "player", op: Op): boolean {
    if (op.t.startsWith("sys.")) return false;
    if (op.t === "roll.change") return false;
    // A dismissal answers the player, as Keep does, and a withdrawal is the player's own (docs/design-v1-player-save-spell.md 5.6).
    if (op.t === "cast.close") return false;
    if (op.t === "scene.update" && Object.keys(op.patch).every((field) => field === "thumb")) return false;
    if (role === "dm") return true;
    return onPlayerUndoStack(op);
  }

  /**
   * Records the inverse of a freshly applied op.
   *
   * Ops sent under one undo group (one brush stroke, one big room sent in
   * bands) are one step: an inverse whose group matches the newest entry's
   * is merged into it, so undo takes the whole gesture back at once. Only
   * the newest entry merges, so a group interrupted by another op starts a
   * new step rather than reaching back past it. So does an op that finds an
   * entity changed by someone else since the gesture's last op touched it
   * (mergeInverses).
   *
   * A cascade (a character deleted with its tokens on every scene) can touch
   * more entities than one `sys.restore` may carry, and the server refuses a
   * restore it could not replay. Such an op empties the stack instead, like
   * any action an editor cannot undo: skipping it would let the next undo
   * revert an older, unrelated change. A merged group that would grow past
   * that size starts a new step instead. A merged step keeps the label of
   * the gesture's first op, unless its ops added, moved or changed more
   * than one token between them, or renamed a folder on its scenes (`tally`,
   * undoLabels.ts), when it names how many ("adding 6 tokens") or the folder.
   * A grouped step of one op is named the same way, so renaming a folder that
   * holds one scene reads as the rename and not as moving that scene.
   * It keeps where its last op left each token, and names its last op as its
   * origin.
   */
  push(memberId: string, inverse: RestoreEntry[], label: string, group?: string, poses?: Record<string, Pose>, origin?: Origin, tally?: Tally, teleport = false, walk?: Walk, rides?: Ride[]): void {
    const s = this.#stacks(memberId);
    s.redo = [];
    if (inverse.length > MAX_RESTORE_ENTRIES) {
      s.undo = [];
      return;
    }
    const top = s.undo.at(-1);
    if (group !== undefined && top?.group === group && (top.poses === undefined) === (poses === undefined)) {
      const merged = mergeInverses(top.entries, inverse);
      if (merged && merged.length <= MAX_RESTORE_ENTRIES) {
        top.entries = merged;
        if (top.poses && poses) top.poses = { ...top.poses, ...poses };
        if (origin) top.origin = origin;
        else delete top.origin;
        const whole = addTally(top.tally, tally);
        if (whole) top.tally = whole;
        else delete top.tally;
        const named = whole && describeTally(whole);
        if (named) top.label = named;
        else if (!whole && top.opLabel !== undefined) top.label = top.opLabel;
        // A walk merged into a teleport's step is tested again on redo.
        if (!teleport) delete top.teleport;
        withWalk(top, walk);
        withRides(top, rides);
        return;
      }
    }
    const named = group !== undefined && tally ? describeTally(tally) : undefined;
    const entry: UndoEntry = group === undefined ? { entries: inverse, label } : { entries: inverse, label: named ?? label, group };
    if (named !== undefined && named !== label) entry.opLabel = label;
    if (teleport) entry.teleport = true;
    if (walk) {
      entry.routes = { [walk.tokenId]: [walk.route] };
      if (walk.routed) entry.routed = true;
    }
    withRides(entry, rides);
    s.undo.push(withExtras(group !== undefined && tally ? { ...entry, tally } : entry, poses, origin));
    if (s.undo.length > UNDO_DEPTH) s.undo.splice(0, s.undo.length - UNDO_DEPTH);
  }

  /** Takes the newest undo entry, dropping it from the stack whatever happens to it next. */
  popUndo(memberId: string): UndoEntry | null {
    return this.#stacks(memberId).undo.pop() ?? null;
  }

  popRedo(memberId: string): UndoEntry | null {
    return this.#stacks(memberId).redo.pop() ?? null;
  }

  /**
   * The step an undo or a redo would take now, left on its stack. The actor
   * reads the images it names before the undo joins the queue
   * (docs/design-v1-dm-tools.md 2.6).
   */
  peek(memberId: string, which: "undo" | "redo"): UndoEntry | null {
    return this.#members.get(memberId)?.[which].at(-1) ?? null;
  }

  /** Whether the newest undo entry is the step this client op made. */
  newestIs(memberId: string, origin: Origin): boolean {
    const top = this.#stacks(memberId).undo.at(-1)?.origin;
    return top !== undefined && top.client === origin.client && top.n === origin.n;
  }

  /**
   * After a restore applied: its own inverse goes on the opposite stack,
   * under the same label and origin, since a step undone and redone is
   * still the one its op made. It carries no group, so nothing sent later
   * merges into a step that was undone and redone.
   */
  pushRestored(memberId: string, from: "undo" | "redo", inverse: RestoreEntry[], label: string, poses?: Record<string, Pose>, origin?: Origin, teleport = false, walked?: Pick<UndoEntry, "routes" | "routed" | "rides">): void {
    const s = this.#stacks(memberId);
    if (inverse.length > MAX_RESTORE_ENTRIES) {
      s.undo = [];
      s.redo = [];
      return;
    }
    const target = from === "undo" ? s.redo : s.undo;
    const entry: UndoEntry = teleport ? { entries: inverse, label, teleport: true } : { entries: inverse, label };
    // Undone and redone, the step keeps the routes its walks took.
    if (walked?.routes) entry.routes = walked.routes;
    if (walked?.routed) entry.routed = true;
    if (walked?.rides) entry.rides = walked.rides;
    target.push(withExtras(entry, poses, origin));
    if (target.length > UNDO_DEPTH) target.splice(0, target.length - UNDO_DEPTH);
  }

  depth(memberId: string): { undo: number; redo: number } {
    const s = this.#members.get(memberId);
    return { undo: s?.undo.length ?? 0, redo: s?.redo.length ?? 0 };
  }

  #stacks(memberId: string): Stacks {
    let s = this.#members.get(memberId);
    if (!s) {
      s = { undo: [], redo: [] };
      this.#members.set(memberId, s);
    }
    return s;
  }
}

/**
 * A merged step's routes: the walk joins its token's list in order. A move
 * that left none, such as a group's, or a list past MAX_KEPT_ROUTES, drops
 * them all, and the step redoes as plain moves do, by the straight leg.
 */
function withWalk(entry: UndoEntry, walk: Walk | undefined): void {
  if (!entry.routes || !walk) {
    delete entry.routes;
    delete entry.routed;
    return;
  }
  const list = [...(entry.routes[walk.tokenId] ?? []), walk.route];
  if (list.length > MAX_KEPT_ROUTES) {
    delete entry.routes;
    delete entry.routed;
    return;
  }
  entry.routes = { ...entry.routes, [walk.tokenId]: list };
  if (walk.routed) entry.routed = true;
}

/** A merged step's rides: each new one joins the list once, up to the most a turn shares. */
function withRides(entry: UndoEntry, rides: readonly Ride[] | undefined): void {
  if (!rides || rides.length === 0) return;
  const list = [...(entry.rides ?? [])];
  for (const ride of rides) {
    if (list.length >= LIMITS.turnMounts) break;
    if (!list.some((r) => r.seq === ride.seq && r.mount === ride.mount && r.rider === ride.rider)) list.push(ride);
  }
  entry.rides = list;
}

/**
 * The controlled rides an op ended or made on the turn under way, from the
 * turn's list of mounts before and after it (docs/design-v1-attach.md 8.3).
 */
export function ridesChanged(before: RoomState, after: RoomState): Ride[] {
  const was = before.encounter?.turnStart;
  const now = after.encounter?.turnStart;
  const out: Ride[] = [];
  for (const start of [was, now]) {
    if (!start || start.seq === undefined) continue;
    const other = start === was ? now : was;
    for (const mount of start.mounts ?? []) {
      const kept = other?.seq === start.seq && (other.mounts ?? []).includes(mount);
      if (!kept && !out.some((r) => r.seq === start.seq && r.mount === mount)) out.push({ seq: start.seq, mount, rider: start.tokenId });
    }
  }
  return out;
}

function withExtras(entry: UndoEntry, poses: Record<string, Pose> | undefined, origin: Origin | undefined): UndoEntry {
  const out = poses ? { ...entry, poses } : entry;
  return origin ? { ...out, origin } : out;
}

function placeOf(token: Place): Place {
  const place: Place = { x: token.x, y: token.y, elevation: token.elevation, rotation: token.rotation };
  if (token.squeeze) place.squeeze = true;
  return place;
}

function poseOf(token: Token, shows: Shows): Pose {
  const link = token.attached && shows(token.attached.to) ? stableStringify(token.attached) : "";
  return { sceneId: token.sceneId, ...placeOf(token), ...sizeOf(token), path: stableStringify(token.path ?? null), attached: link };
}

/** A token's footprint size: Custom's width and height only where it has them. */
function sizeOf(token: Pick<Token, "size" | "w" | "h">): Pick<Token, "size" | "w" | "h"> {
  return { size: token.size, ...(token.w !== undefined ? { w: token.w } : {}), ...(token.h !== undefined ? { h: token.h } : {}) };
}

function samePose(a: Pose, b: Pose): boolean {
  return (
    a.sceneId === b.sceneId &&
    a.x === b.x &&
    a.y === b.y &&
    a.elevation === b.elevation &&
    a.rotation === b.rotation &&
    a.squeeze === b.squeeze &&
    a.size === b.size &&
    a.w === b.w &&
    a.h === b.h &&
    a.path === b.path &&
    a.attached === b.attached
  );
}

/** The tokens an op names, the roots of its groups (docs/design-v1-attach.md 8.2): every other token it moves rides on one of them. */
export function namedTokens(op: Op): string[] {
  if (op.t === "token.moveMany") return op.moves.map((m) => m.tokenId);
  return "tokenId" in op && typeof op.tokenId === "string" ? [op.tokenId] : [];
}

/** The roots a step's poses name (Pose.root). */
export function rootsOf(poses: Record<string, Pose> | undefined): Set<string> {
  return new Set(Object.entries(poses ?? {}).flatMap(([id, pose]) => (pose.root ? [id] : [])));
}

/**
 * How a step classes its passengers (Pose.silent), with `roots` the tokens
 * it named. An op's are read off `planned`, the state the move was planned
 * on, before a wall or the link pass broke any link on the way: a hidden
 * creature dragged into a wall and out of reach still carried its torch
 * along a chain no player sees. A restore's are the step's it takes back
 * (`kept`), so nothing changed since turns a silent one into one that
 * answers, through the undo and every redo after it.
 */
export type Passengers = { roots: ReadonlySet<string>; planned: RoomState } | { roots: ReadonlySet<string>; kept: Record<string, Pose> };

/** An op's passengers, by the state before it. */
export function plannedOn(before: RoomState, op: Op): Passengers {
  return { roots: new Set(namedTokens(op)), planned: before };
}

/** A restore's passengers, as the step it takes back classed them. */
export function keptFrom(poses: Record<string, Pose>): Passengers {
  return { roots: rootsOf(poses), kept: poses };
}

/**
 * Where each token an op or a restore touched stands in `state`, the state
 * it left, its link as the player's copy shows it, and whether it rode
 * along as a silent passenger (Passengers). Without `passengers`, each
 * token's nearest holder in the step stands for its root, in `state`.
 */
export function posesAfter(state: RoomState, inverse: RestoreEntry[], shows: Shows = () => true, passengers?: Passengers): Record<string, Pose> {
  const restoring = new Set<string>();
  for (const entry of inverse) {
    const parsed = parseKey(entry.key);
    if (parsed?.kind === "token") restoring.add(parsed.id);
  }
  const roots = passengers?.roots;
  const silent = (id: string) => {
    if (!passengers) return silentPassenger(state, id, restoring);
    return "kept" in passengers ? passengers.kept[id]?.silent === true : silentPassenger(passengers.planned, id, restoring, roots);
  };
  const poses: Record<string, Pose> = {};
  for (const id of restoring) {
    const token = state.tokens[id];
    if (!token) continue;
    const pose = poseOf(token, shows);
    if (roots?.has(id)) pose.root = true;
    if (silent(id)) pose.silent = true;
    poses[id] = pose;
  }
  return poses;
}

/**
 * Whether a token is carried in `state` under a root of the step by a chain not
 * every player sees (docs/design-v1-attach.md 8.3): a hidden passenger,
 * one only some players see, or a visible one with a hidden token or link
 * anywhere between it and its root, however deep, so a visible light on a
 * visible torch on a hidden imp is as silent as the torch. Such a
 * passenger never answers an undo: it rides back silently or stays. A
 * root itself never is.
 */
function silentPassenger(state: RoomState, tokenId: string, restoring: ReadonlySet<string>, roots?: ReadonlySet<string>): boolean {
  if (roots?.has(tokenId)) return false;
  let token = state.tokens[tokenId];
  const visited = new Set<string>([tokenId]);
  let open = true;
  while (token) {
    const holder = holderOf(state.tokens, token);
    if (!holder || visited.has(holder.id)) return false;
    visited.add(holder.id);
    if (!inSightOfNonOwners(state, token, {}) || !inSightOfNonOwners(state, state.tokens[holder.id]!, {})) open = false;
    if (roots ? roots.has(holder.id) : restoring.has(holder.id)) return !open;
    // Carried by a token the step did not move, it rode on no root of the step.
    if (!restoring.has(holder.id)) return false;
    token = state.tokens[holder.id];
  }
  return false;
}

/** `quiet` names the silent passengers among the entries, which the restore's checks leave alone (shared/permissions.ts). */
export type PoseRestore = { ok: true; entries: RestoreEntry[]; quiet?: string[] } | { ok: false; code: RefusalCode; message: string };

/**
 * Whether a silent passenger of the step still rides under the group now:
 * up its links, through tokens of the step, to one that is not a silent
 * passenger, the step's named tokens and their public members. One the DM
 * took off since, or whose own holder left the group, stays where it is.
 */
function stillUnder(state: RoomState, tokenId: string, restoring: ReadonlySet<string>, silent: ReadonlySet<string>): boolean {
  const visited = new Set<string>([tokenId]);
  for (let up = holderOf(state.tokens, state.tokens[tokenId]!)?.id; up !== undefined && !visited.has(up); up = state.tokens[up] ? holderOf(state.tokens, state.tokens[up]!)?.id : undefined) {
    visited.add(up);
    if (!restoring.has(up)) return false;
    if (!silent.has(up)) return true;
  }
  return false;
}

/**
 * The restore for a step of a player's token moves or resizes (features
 * 13): each token goes back to where and how big the step found it, with
 * the path of its turn as it was there (features 4), and everything else
 * about it stays as it is now, so damage the DM dealt since survives the
 * undo. It is refused only when the token stands somewhere other than
 * where the step left it, at another size, or its path is not what the
 * step left, because someone moved or resized it since, to another scene
 * or away and back included, or marked its move. It never puts a token
 * back on another scene, only in its place on this one.
 *
 * A token the player cannot see now answers as if it were gone, before its
 * position is looked at, so a refusal never tells a player that a creature
 * hidden from them has moved. The restore is guarded by the token's value
 * now, like every other (design 7.7), and replays the same way.
 */
export function poseRestore(state: RoomState, step: UndoEntry & { poses: Record<string, Pose> }, visible: (tokenId: string) => boolean): PoseRestore {
  const tokens: { key: string; before: Token; current: Token; left: Pose | undefined }[] = [];
  const quiet: RestoreEntry[] = [];
  const quietIds: string[] = [];
  const restoring = new Set<string>();
  for (const entry of step.entries) {
    const parsed = parseKey(entry.key);
    if (parsed?.kind === "token") restoring.add(parsed.id);
  }
  const silent = new Set([...restoring].filter((id) => step.poses[id]?.silent === true));
  for (const entry of step.entries) {
    const parsed = parseKey(entry.key);
    // An attach's rows and the turn's list stay as they are: the undo takes back the link and the seat only (docs/design-v1-attach.md 8.3).
    if (parsed?.kind === "encounter") continue;
    if (parsed?.kind !== "token") return { ok: false, code: "invalid", message: "only token moves and resizes undo this way" };
    const current = state.tokens[parsed.id];
    const before = entry.value as Token | null | undefined;
    // A silent passenger of the step rides back quietly while it is still under the group, and is left as it is otherwise,
    // gone or not. Either way it never answers (docs/design-v1-attach.md 8.3).
    if (silent.has(parsed.id)) {
      const back = current && stillUnder(state, parsed.id, restoring, silent) ? quietlyBack(current, before, step.poses[parsed.id], visible) : null;
      if (back && current) {
        quiet.push({ key: entry.key, value: back, expectHash: guardHash(entry.key, current) });
        quietIds.push(parsed.id);
      }
      continue;
    }
    // A passenger gone since, or one the player cannot see now and no longer under the group, is left out: it rode
    // along, and no answer reads it.
    if ((!current || !visible(parsed.id)) && before?.attached && restoring.has(before.attached.to)) continue;
    if (!current || !visible(parsed.id)) return { ok: false, code: "gone", message: "that is not here" };
    if (!before) return { ok: false, code: "invalid", message: "only token moves and resizes undo this way" };
    tokens.push({ key: entry.key, before, current, left: step.poses[parsed.id] });
  }
  if (tokens.some((t) => !t.left || !samePose(poseOf(t.current, visible), t.left))) return { ok: false, code: "invalid", message: MOVED_SINCE };
  return {
    ok: true,
    entries: [...tokens.map((t) => ({ key: t.key, value: putBack(t.current, t.before, (id) => state.tokens[id] !== undefined), expectHash: guardHash(t.key, t.current) })), ...quiet],
    ...(quietIds.length > 0 ? { quiet: quietIds } : {}),
  };
}

/**
 * A silent passenger's way back (docs/design-v1-attach.md 8.3): by the
 * displacement the step gave it, its own holder's actual move, from
 * wherever it sits now, so a visible torch on an invisible holder floats
 * back as it floated out. Its path goes back with it only where it still
 * stands as the step left it. Null when it has nothing to take back.
 */
function quietlyBack(current: Token, before: Token | null | undefined, left: Pose | undefined, shows: Shows): Token | null {
  if (!before || !left || before.sceneId !== left.sceneId || current.sceneId !== left.sceneId) return null;
  const dx = left.x - before.x;
  const dy = left.y - before.y;
  const dz = left.elevation - before.elevation;
  const still = samePose(poseOf(current, shows), left);
  if (dx === 0 && dy === 0 && dz === 0 && !still) return null;
  const out: Token = { ...current, x: current.x - dx, y: current.y - dy, elevation: current.elevation - dz };
  delete out.squeeze;
  if (still) {
    if (before.path) out.path = before.path;
    else delete out.path;
  }
  return out;
}

/**
 * The token as it is now, back where it stood before, at the size it had,
 * with the path it had there: the leg the move added, or the resize's stop,
 * goes with it. So does a squeeze: undoing a move into a corridor takes it
 * off, and undoing one out of it puts it back.
 */
function putBack(current: Token, before: Token, exists: (tokenId: string) => boolean): Token {
  const { path: _path, squeeze: _squeeze, w: _w, h: _h, attached: _attached, ...rest } = current;
  const out: Token = { ...rest, ...placeOf(before), ...sizeOf(before) };
  if (before.path) out.path = before.path;
  // The link goes back with the seat (docs/design-v1-attach.md 8.3). One to a holder the player cannot see now comes back
  // too, and the link pass keeps it only where it holds, so the player's answer is the one with no hidden holder at all.
  // One to a holder deleted since stays off, since a player's restore never refuses on a link.
  if (before.attached && exists(before.attached.to)) out.attached = before.attached;
  return out;
}

/** The refusal of a move's or a resize's undo. Like CHANGED_SINCE, it does not say who. */
export const MOVED_SINCE = "it was moved or resized since";

/** The refusal of an undo meant for a step that is no longer the newest, undone or covered by another device's change. */
export const NOT_NEWEST = "could not undo that move: it is no longer your newest change";

/**
 * One restore that undoes `older` and then `newer`, which was applied after
 * it, or null when the two cannot be one step. An entity both touched goes
 * back to the value it had before `older`, guarded by what `newer` left
 * there, because that is what it holds now when nobody else has changed it
 * since.
 *
 * That chain holds only if nobody changed the entity between the two ops
 * either: what `newer` found there must be what `older` left, which is what
 * the older entry's guard describes. Another DM painting the same chunk in
 * the middle of a stroke breaks it, and a merged step would then restore
 * over their paint without a word. Such an op starts a new step instead, so
 * each undo checks its own guard and the older one refuses.
 */
export function mergeInverses(older: RestoreEntry[], newer: RestoreEntry[]): RestoreEntry[] | null {
  const byKey = new Map(older.map((e) => [e.key, e]));
  for (const entry of newer) {
    const first = byKey.get(entry.key);
    if (!first) {
      byKey.set(entry.key, entry);
      continue;
    }
    if (!guardMatches(first, entry.value ?? null)) return null;
    const { value: _later, ...guard } = entry;
    byKey.set(entry.key, { ...guard, value: first.value });
  }
  return [...byKey.values()];
}
