import { keys } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { canApply, MOVE_PLAYERS_FIRST_BACK } from "#shared/permissions.ts";
import { projectEntity } from "#shared/project.ts";
import { isPoseOp, isResizeOp, serverOnlyOpSchema, type ClientOp, type Op, type RefusalCode } from "#shared/protocol.ts";
import { applyOp, type Applied } from "#shared/reducer.ts";
import { CHANGED_SINCE, DEPENDED_ON, PARENT_GONE, restoreReferenceConflicts } from "#shared/reducer/misc.ts";
import { env } from "#shared/testutil.ts";
import type { HistoryScope } from "#shared/undoContract.ts";
import { undoScope } from "#shared/undoScope.ts";
import { keptFrom, MOVED_SINCE, plannedOn, poseRestore, posesAfter, ridesChanged, TRAPPED_ON_THE_WAY, UndoStacks, type UndoEntry, type Walk } from "./undo.ts";
import { dmHistoryValues, dmPoseRestore } from "./undoDm.ts";
import { describeOp } from "./undoLabels.ts";

/**
 * A room's ops and its members' undo stacks as the room actor keeps them
 * (actor.ts), without sockets or storage, for tests of undo and redo: a
 * DM action enters its classified scope with semantic after-values and
 * eligible poses. DM restores adapt those poses and carry correction data.
 * A player's op passes `canApply` first, goes on their stack with the poses
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

  #apply(who: Viewer, op: Op): ReturnType<typeof applyOp> {
    const before = this.state;
    const seq = this.seq + 1;
    const r = applyOp(before, op, who, env(seq));
    if (!r.ok) return r;
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
    if (!r.ok) return r.message;
    const scope = undoScope(op, before);
    if (scope !== "none" && r.inverse && UndoStacks.records(who.role, op, before)) {
      const pose = who.role === "player" && (isPoseOp(op) || isResizeOp(op));
      const inverse = pose && r.trapWrote ? r.inverse.filter((entry) => !r.trapWrote!.has(entry.key)) : r.inverse;
      const poses = pose ? posesAfter(this.state, inverse, this.#shows(who), plannedOn(before, op)) : undefined;
      const teleport = op.t === "token.move" && op.teleport !== undefined;
      const walk: Walk | undefined = poses && op.t === "token.move" && !teleport ? { tokenId: op.tokenId, route: op.route ?? [[op.x, op.y, 0, 0]], routed: op.route !== undefined } : undefined;
      const rides = poses ? ridesChanged(before, this.state) : undefined;
      this.stacks.push(who.memberId, inverse, describeOp(op as ClientOp, before, who, this.state), undefined, poses, undefined, undefined, teleport, walk, rides, r.trapped === true, {
        scope: who.role === "dm" ? scope : "play",
        ...(who.role === "dm" ? { values: dmHistoryValues(inverse, this.state, scope === "play") } : {}),
      });
    }
    return "ok";
  }

  #failed(who: Viewer, from: "undo" | "redo", scope: HistoryScope, step: UndoEntry, code: RefusalCode, reason: string): string {
    if (code === "quota" || code === "forget") return reason;
    const dependencies = [DEPENDED_ON, PARENT_GONE, MOVE_PLAYERS_FIRST_BACK].includes(reason) ? restoreReferenceConflicts(this.state, dmPoseRestore(this.state, step.entries, step.values)) : [];
    const attributable = reason === CHANGED_SINCE || reason === MOVED_SINCE || dependencies.length > 0;
    const blocker = who.role === "dm" && attributable ? this.stacks.retain(who.memberId, from, scope, this.state, dependencies) : null;
    if (blocker) {
      const verb = blocker.direction === "undo" ? "Undo" : "Redo";
      return blocker.buried ? `${verb} the ${blocker.scope} steps through ${blocker.label} first` : `${verb} the ${blocker.scope} step first: ${blocker.label}`;
    }
    this.stacks.consume(who.memberId, from, scope, step.id!);
    return reason;
  }

  /** Peek and validate before consuming, so an own other-scope conflict can retain the expected head. */
  restore(who: Viewer, from: "undo" | "redo", scope: HistoryScope = "play"): string {
    this.last = null;
    if (who.role === "player" && scope === "setup") return "only the DM may use Setup history";
    const step = this.stacks.peek(who.memberId, from, scope);
    if (!step) return `nothing to ${from}`;
    if (who.role === "player" && from === "undo" && step.trapped) {
      this.stacks.consume(who.memberId, from, scope, step.id!);
      return TRAPPED_ON_THE_WAY;
    }
    let entries = who.role === "dm" ? dmPoseRestore(this.state, step.entries, step.values) : step.entries;
    let quiet: string[] | undefined;
    if (step.poses) {
      const moved = poseRestore(this.state, { ...step, poses: step.poses }, this.#shows(who), this.#pathShown(who));
      if (!moved.ok) {
        this.stacks.consume(who.memberId, from, scope, step.id!);
        return moved.message;
      }
      entries = moved.entries;
      quiet = moved.quiet;
    }
    const op: Op = {
      t: "sys.restore",
      entries,
      from,
      scope,
      ...(who.role === "dm" ? { correction: { label: step.label } } : {}),
      deps: true,
      ...(step.teleport ? { teleport: true as const } : {}),
      ...(from === "redo" && step.routed && step.routes ? { routes: step.routes } : {}),
      ...(step.poses && step.rides && step.rides.length > 0 ? { rides: step.rides } : {}),
      ...(quiet ? { quiet } : {}),
    };
    const checked = serverOnlyOpSchema.safeParse(op);
    if (!checked.success) return `server op ${op.t} does not validate: ${checked.error.issues[0]?.message ?? "invalid"}`;
    const allowed = canApply(checked.data, who, this.state, deps);
    if (!allowed.ok) return this.#failed(who, from, scope, step, allowed.code, allowed.message);
    const r = this.#apply(who, checked.data);
    if (!r.ok) return this.#failed(who, from, scope, step, r.code, r.message);
    this.stacks.consume(who.memberId, from, scope, step.id!);
    if (r.inverse) this.stacks.pushRestored(who.memberId, from, r.inverse, step.label, step.poses ? posesAfter(this.state, r.inverse, this.#shows(who), keptFrom(step.poses, this.last!.before)) : undefined, step.origin, step.teleport === true, step, {
      scope,
      ...(who.role === "dm" ? { values: dmHistoryValues(r.inverse, this.state, scope === "play") } : {}),
    });
    return "ok";
  }

  undo(who: Viewer, scope: HistoryScope = "play"): string {
    return this.restore(who, "undo", scope);
  }

  redo(who: Viewer, scope: HistoryScope = "play"): string {
    return this.restore(who, "redo", scope);
  }

  t(id: string): Token {
    return this.state.tokens[id]!;
  }

  mounts(): string[] | undefined {
    return this.state.encounter?.turnStart?.mounts;
  }
}
