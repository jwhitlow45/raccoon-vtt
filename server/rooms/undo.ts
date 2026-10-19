import { parseKey } from "#shared/keys.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { MAX_RESTORE_ENTRIES, onPlayerUndoStack, type Op, type RefusalCode, type RestoreEntry } from "#shared/protocol.ts";
import { guardMatches } from "#shared/reducer/misc.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { stableStringify } from "#shared/project.ts";
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
export type Pose = Place & Pick<Token, "sceneId" | "size" | "w" | "h"> & { path: string };

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
};

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
  push(memberId: string, inverse: RestoreEntry[], label: string, group?: string, poses?: Record<string, Pose>, origin?: Origin, tally?: Tally, teleport = false): void {
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
        return;
      }
    }
    const named = group !== undefined && tally ? describeTally(tally) : undefined;
    const entry: UndoEntry = group === undefined ? { entries: inverse, label } : { entries: inverse, label: named ?? label, group };
    if (named !== undefined && named !== label) entry.opLabel = label;
    if (teleport) entry.teleport = true;
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
  pushRestored(memberId: string, from: "undo" | "redo", inverse: RestoreEntry[], label: string, poses?: Record<string, Pose>, origin?: Origin, teleport = false): void {
    const s = this.#stacks(memberId);
    if (inverse.length > MAX_RESTORE_ENTRIES) {
      s.undo = [];
      s.redo = [];
      return;
    }
    const target = from === "undo" ? s.redo : s.undo;
    target.push(withExtras(teleport ? { entries: inverse, label, teleport: true } : { entries: inverse, label }, poses, origin));
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

function withExtras(entry: UndoEntry, poses: Record<string, Pose> | undefined, origin: Origin | undefined): UndoEntry {
  const out = poses ? { ...entry, poses } : entry;
  return origin ? { ...out, origin } : out;
}

function placeOf(token: Place): Place {
  const place: Place = { x: token.x, y: token.y, elevation: token.elevation, rotation: token.rotation };
  if (token.squeeze) place.squeeze = true;
  return place;
}

function poseOf(token: Token): Pose {
  return { sceneId: token.sceneId, ...placeOf(token), ...sizeOf(token), path: stableStringify(token.path ?? null) };
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
    a.path === b.path
  );
}

/** Where each token an op or a restore touched stands in `state`, the state it left. */
export function posesAfter(state: RoomState, inverse: RestoreEntry[]): Record<string, Pose> {
  const poses: Record<string, Pose> = {};
  for (const entry of inverse) {
    const parsed = parseKey(entry.key);
    const token = parsed?.kind === "token" ? state.tokens[parsed.id] : undefined;
    if (token) poses[token.id] = poseOf(token);
  }
  return poses;
}

export type PoseRestore = { ok: true; entries: RestoreEntry[] } | { ok: false; code: RefusalCode; message: string };

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
  for (const entry of step.entries) {
    const parsed = parseKey(entry.key);
    if (parsed?.kind !== "token") return { ok: false, code: "invalid", message: "only token moves and resizes undo this way" };
    const current = state.tokens[parsed.id];
    if (!current || !visible(parsed.id)) return { ok: false, code: "gone", message: "that is not here" };
    const before = entry.value as Token | null | undefined;
    if (!before) return { ok: false, code: "invalid", message: "only token moves and resizes undo this way" };
    tokens.push({ key: entry.key, before, current, left: step.poses[parsed.id] });
  }
  if (tokens.some((t) => !t.left || !samePose(poseOf(t.current), t.left))) return { ok: false, code: "invalid", message: MOVED_SINCE };
  return {
    ok: true,
    entries: tokens.map((t) => ({ key: t.key, value: putBack(t.current, t.before), expectHash: guardHash(t.key, t.current) })),
  };
}

/**
 * The token as it is now, back where it stood before, at the size it had,
 * with the path it had there: the leg the move added, or the resize's stop,
 * goes with it. So does a squeeze: undoing a move into a corridor takes it
 * off, and undoing one out of it puts it back.
 */
function putBack(current: Token, before: Token): Token {
  const { path: _path, squeeze: _squeeze, w: _w, h: _h, ...rest } = current;
  const out: Token = { ...rest, ...placeOf(before), ...sizeOf(before) };
  if (before.path) out.path = before.path;
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
