import { keys } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectEntity } from "#shared/project.ts";
import { isPoseOp, isResizeOp, type Op } from "#shared/protocol.ts";
import { applyOp, type Applied } from "#shared/reducer.ts";
import { env } from "#shared/testutil.ts";
import { keptFrom, plannedOn, poseRestore, posesAfter, ridesChanged, UndoStacks, type Walk } from "./undo.ts";

/**
 * A room's ops and its members' undo stacks as the room actor keeps them
 * (actor.ts), without sockets or storage, for tests of undo and redo: a
 * player's op passes `canApply` first, goes on their stack with the poses
 * their copy shows and the rides it ended or made, and an undo or a redo
 * is built by `poseRestore` and passes `canApply` as the player before it
 * applies. Every applied op is kept in order, as the room's op log.
 */

const deps = { canUseAsset: () => true };

export type Played = { op: Op; who: Viewer; seq: number };

export class UndoTable {
  state: RoomState;
  seq = 0;
  stacks = new UndoStacks();
  /** Every op applied, in order, as the room stores them. */
  played: Played[] = [];
  /** The last op's result when it applied, with the op as applied (an undo or a redo as its built restore). */
  last: { op: Op; who: Viewer; applied: Applied; before: RoomState } | null = null;
  constructor(state: RoomState) {
    this.state = state;
  }

  #shows(who: Viewer): (id: string) => boolean {
    const state = this.state;
    return (id) => who.role === "dm" || projectEntity(keys.token(id), state, who, { sceneId: state.meta.playerSceneId }) !== null;
  }

  /** Whether the player's copy shows a path on the token now (undo.ts poseRestore). */
  #pathShown(who: Viewer): (id: string) => boolean {
    const state = this.state;
    return (id) => (who.role === "dm" ? state.tokens[id] : (projectEntity(keys.token(id), state, who, { sceneId: state.meta.playerSceneId }) as Partial<Token> | null))?.path !== undefined;
  }

  #apply(who: Viewer, op: Op): Applied | string {
    const before = this.state;
    const seq = this.seq + 1;
    const r = applyOp(before, op, who, env(seq));
    if (!r.ok) return r.message;
    this.seq = seq;
    this.state = r.state;
    this.played.push({ op, who, seq });
    this.last = { op, who, applied: r, before };
    return r;
  }

  /** An op as the actor takes it: the answer's words, or "ok". */
  play(who: Viewer, op: Op): string {
    this.last = null;
    const before = this.state;
    if (who.role === "player") {
      const allowed = canApply(op, who, before, deps);
      if (!allowed.ok) return allowed.message;
    }
    const r = this.#apply(who, op);
    if (typeof r === "string") return r;
    if (r.inverse && UndoStacks.records(who.role, op)) {
      const poses = who.role === "player" && (isPoseOp(op) || isResizeOp(op)) ? posesAfter(this.state, r.inverse, this.#shows(who), plannedOn(before, op)) : undefined;
      const teleport = op.t === "token.move" && op.teleport !== undefined;
      const walk: Walk | undefined = poses && op.t === "token.move" && !teleport ? { tokenId: op.tokenId, route: op.route ?? [[op.x, op.y, 0, 0]], routed: op.route !== undefined } : undefined;
      const rides = poses ? ridesChanged(before, this.state) : undefined;
      this.stacks.push(who.memberId, r.inverse, op.t, undefined, poses, undefined, undefined, teleport, walk, rides);
    }
    return "ok";
  }

  /** An undo or a redo as the actor builds it. A refused one is gone from the stack, as there. */
  restore(who: Viewer, from: "undo" | "redo"): string {
    this.last = null;
    const step = from === "undo" ? this.stacks.popUndo(who.memberId) : this.stacks.popRedo(who.memberId);
    if (!step) return `nothing to ${from}`;
    let entries = step.entries;
    let quiet: string[] | undefined;
    if (step.poses) {
      const moved = poseRestore(this.state, { ...step, poses: step.poses }, this.#shows(who), this.#pathShown(who));
      if (!moved.ok) return moved.message;
      entries = moved.entries;
      quiet = moved.quiet;
    }
    const op: Op = {
      t: "sys.restore",
      entries,
      from,
      deps: true,
      ...(step.teleport ? { teleport: true as const } : {}),
      ...(from === "redo" && step.routed && step.routes ? { routes: step.routes } : {}),
      ...(step.poses && step.rides && step.rides.length > 0 ? { rides: step.rides } : {}),
      ...(quiet ? { quiet } : {}),
    };
    const allowed = canApply(op, who, this.state, deps);
    if (!allowed.ok) return allowed.message;
    const r = this.#apply(who, op);
    if (typeof r === "string") return r;
    if (r.inverse) this.stacks.pushRestored(who.memberId, from, r.inverse, step.label, step.poses ? posesAfter(this.state, r.inverse, this.#shows(who), keptFrom(step.poses, this.last!.before)) : undefined, step.origin, step.teleport === true, step);
    return "ok";
  }

  undo(who: Viewer): string {
    return this.restore(who, "undo");
  }

  redo(who: Viewer): string {
    return this.restore(who, "redo");
  }

  t(id: string): Token {
    return this.state.tokens[id]!;
  }

  mounts(): string[] | undefined {
    return this.state.encounter?.turnStart?.mounts;
  }
}
