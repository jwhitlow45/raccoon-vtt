import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { Member } from "#shared/model.ts";
import type { JoinMode } from "#shared/protocol.ts";
import { RoomFullError, RoomNotFoundError, type RoomGateway } from "../rooms/gateway.ts";
import { formerDms, putGrant, revokeGrants, type RevokeBounds, type RevokeResult } from "./grants.ts";
import { HttpError } from "./http.ts";
import { CheckoutTimeout, CommitOutcomeUnknown, withTx } from "./tx.ts";

/**
 * Letting a new or returning player in: the one path that writes a player
 * grant for a join, used by `join/complete` and by a DM's let-in
 * (docs/design/design-v1-join-requests.md 5.1 and 5.2).
 *
 * A new player's member is written first, through the room actor, and its
 * grant second, so a crash in between leaves an unused member and never a
 * grant without one. While an attempt runs, its member is in flight: no
 * "continue as" and no carry-on pick can claim it. Only a rollback known to
 * come before the grant could commit takes the member back off. An outcome
 * that stays unknown keeps it, as a member nobody plays, which the DM
 * removes. Every step is bounded, and an answer that cannot wait for a slow
 * room says so while the attempt goes on.
 *
 * A kick is ordered against every admission naming its member that began
 * before it: one that has not reached its grant's check writes no grant,
 * and one past the check holds the room row lock, which the kick's revoke
 * waits for before it deletes. So a kick never answers while a grant from
 * before it can still land.
 */

/** How long a caller waits for a new member to land, the room's load included, before it answers that the join is still settling. */
export const MEMBER_ANSWER_MS = 5_000;
/** The grant transaction's pool checkout. */
export const GRANT_CHECKOUT_MS = 2_000;
/** A kick's revoke: it waits on the room row lock that a grant being written holds. */
export const KICK_BOUNDS: RevokeBounds = { checkoutMs: 2_000, lockMs: 2_000, statementMs: 5_000 };
/**
 * How long a kick is remembered against admissions that began before it.
 * Every admission reaches its grant's check well within this: a carry-on
 * has no member step, and a new member can be kicked only once it landed.
 */
const KICK_MEMORY_MS = 2 * 60_000;

export type LockedRoom = { join_mode: JoinMode; player_epoch: number; dm_epoch: number };

export type AdmitWho = { kind: "new"; member: Member } | { kind: "member"; memberId: string };

export type AdmitOutcome =
  /** The grant committed and its member is there. `member` is null only when the room could not be read back. */
  | { kind: "in"; memberId: string; member: Member | null }
  /** No grant was written, or the one written was given up. Any member the attempt added is taken back off, now or by the sweep. */
  | { kind: "refused"; error: Error }
  /** The commit may or may not have landed, and reading it back could not tell. The member stays. */
  | { kind: "unknown"; memberId: string };

/** `pending`: the outcome is not known within the answer's bound, in whatever phase. The attempt goes on and settles later. */
export type AdmitAnswer = AdmitOutcome | { kind: "pending"; memberId: string };

export type AdmitPlan = {
  roomId: string;
  /** The session the grant goes on: the caller's own for a join, the requester's for a let-in. */
  sessionId: string;
  who: AdmitWho;
  /**
   * From `Admissions.begin()` when the caller's route started, before its
   * own checks of the member, so a kick that lands after that writes no
   * grant. Taken when `admit` is called if missing.
   */
  begun?: number;
  /**
   * The caller's checks and writes under the room row lock, in the grant's
   * transaction, before the grant: the mode, a stale ticket, promoting an
   * ask token, the let-in's accounting. Throw an HttpError to refuse.
   */
  locked(tx: pg.PoolClient, room: LockedRoom): Promise<void>;
  /**
   * Runs again whenever the transaction may have committed and its outcome
   * is read back: the promotion's cache callbacks are idempotent, and must
   * have run before any settlement is published.
   */
  maybeCommitted?(): void;
  /** Called exactly once, synchronously, as soon as the outcome is known, also after a pending answer. */
  settled(outcome: AdmitOutcome): void;
};

export type AdmissionsOptions = {
  /** Each actor call's bound: a member's removal, and reading the member back after its grant. */
  memberMs?: number;
  /** Every pool checkout: the grant's, the read-back's and the undo's revokes. */
  checkoutMs?: number;
  /** The answer's bound, from the attempt's start, in every phase. `memberMs` when unset. */
  answerMs?: number;
};

type Reconciled = "committed" | "not" | "unreachable";

/** What an attempt returns when its outcome waits on the sweep: the caller hears pending at once, and the follow-up settles it. */
const FOLLOWING = Symbol("following");

export class Admissions {
  #pool: pg.Pool;
  #gateway: RoomGateway;
  #log: FastifyBaseLogger | undefined;
  #memberMs: number;
  #checkoutMs: number;
  #answerMs: number;
  /** Members being added for a join, by room. */
  #inFlight = new Map<string, Set<string>>();
  /** Members whose removal after a rolled-back grant did not land, retried by the sweep. */
  #owed = new Map<string, { roomId: string; memberId: string }>();
  /** Undos running now, which the answer never waits for. */
  #undoing = new Set<Promise<void>>();
  /** Grants given up because their member was removed, whose revoke did not land, retried by the sweep. */
  #owedRevokes = new Map<string, { roomId: string; sessionId: string; memberId: string; epoch: number }>();
  /** Attempts whose commit outcome could not be read back yet, each a follow-up that answers true once settled. */
  #unreconciled = new Set<() => Promise<boolean>>();
  #following: Promise<void> | null = null;
  /** Orders admissions and kicks: every `begin` and every kick takes the next number. */
  #sequence = 0;
  /** Each member's latest kick, by `room|member`: its number, and when, for forgetting it. */
  #kicks = new Map<string, { seq: number; at: number }>();

  constructor(deps: { pool: pg.Pool; gateway: RoomGateway; log?: FastifyBaseLogger | undefined; options?: AdmissionsOptions | undefined }) {
    this.#pool = deps.pool;
    this.#gateway = deps.gateway;
    this.#log = deps.log;
    this.#memberMs = deps.options?.memberMs ?? MEMBER_ANSWER_MS;
    this.#checkoutMs = deps.options?.checkoutMs ?? GRANT_CHECKOUT_MS;
    this.#answerMs = deps.options?.answerMs ?? this.#memberMs;
  }

  /** The room's members in flight, for "continue as" and the DM's carry-on list to leave out. */
  inFlight(roomId: string): ReadonlySet<string> {
    return this.#inFlight.get(roomId) ?? EMPTY;
  }

  /** What is still to do after the answers: undos running or owed, revokes owed, and outcomes not read back. */
  get followUps(): number {
    return this.#undoing.size + this.#owed.size + this.#owedRevokes.size + this.#unreconciled.size;
  }

  /** Marks where a join's route starts, before it reads anything about the member it names (`AdmitPlan.begun`). */
  begin(): number {
    return ++this.#sequence;
  }

  /**
   * A DM kicks or removes the member: every admission naming it that began
   * before now is refused at its grant's check. Call it before revoking
   * (`revokeMember`), so the revoke's room lock orders it after any
   * admission already past that check.
   */
  kicked(roomId: string, memberId: string): void {
    const now = Date.now();
    for (const [k, kick] of this.#kicks) if (now - kick.at > KICK_MEMORY_MS) this.#kicks.delete(k);
    this.#kicks.set(`${roomId}|${memberId}`, { seq: ++this.#sequence, at: now });
  }

  #kickedSince(roomId: string, memberId: string, begun: number): boolean {
    const kick = this.#kicks.get(`${roomId}|${memberId}`);
    return kick !== undefined && kick.seq > begun;
  }

  /**
   * Runs one attempt. The answer is its outcome once known, or `pending`
   * once `answerMs` has passed since the start, in whichever phase it is:
   * the member, the grant, the read-back after a lost COMMIT, or giving a
   * grant up. An outcome that waits on the sweep answers `pending` at once.
   * The attempt goes on either way, and `plan.settled` hears its outcome
   * once, before the answer when the answer is that outcome.
   */
  admit(plan: AdmitPlan): Promise<AdmitAnswer> {
    const memberId = memberOf(plan.who);
    const begun = plan.begun ?? this.begin();
    let answer!: (a: AdmitAnswer) => void;
    const answered = new Promise<AdmitAnswer>((resolve) => (answer = resolve));
    let done = false;
    const settle = (outcome: AdmitOutcome) => {
      if (done) return;
      done = true;
      try {
        plan.settled(outcome);
      } catch (err) {
        this.#log?.error({ err, roomId: plan.roomId }, "join settlement failed");
      }
      answer(outcome);
    };
    const timer = setTimeout(() => answer({ kind: "pending", memberId }), this.#answerMs);
    this.#attempt(plan, begun, settle).then(
      (result) => (result === FOLLOWING ? answer({ kind: "pending", memberId }) : settle(result)),
      (err: unknown) => settle({ kind: "refused", error: asError(err) }),
    );
    return answered.finally(() => clearTimeout(timer));
  }

  /** The sweep's part: undos still running, owed removals and revokes, then outcomes still to read back. One run at a time. */
  followUp(): Promise<void> {
    this.#following ??= (async () => {
      try {
        await Promise.all([...this.#undoing]);
        for (const { roomId, memberId } of [...this.#owed.values()]) await this.#undo(roomId, memberId);
        for (const [key, owed] of [...this.#owedRevokes]) if (await this.#giveUp(owed)) this.#owedRevokes.delete(key);
        for (const next of [...this.#unreconciled]) {
          if (await next().catch(() => false)) this.#unreconciled.delete(next);
        }
      } finally {
        this.#following = null;
      }
    })();
    return this.#following;
  }

  /** A revoke inside a join's own steps: bounded like the grant's transaction, so no step waits on a stalled pool. */
  #revokeBounds(): RevokeBounds {
    return { checkoutMs: this.#checkoutMs, lockMs: 2_000, statementMs: 2_000 };
  }

  async #attempt(plan: AdmitPlan, begun: number, settle: (outcome: AdmitOutcome) => void): Promise<AdmitOutcome | typeof FOLLOWING> {
    const { roomId, who } = plan;
    const memberId = memberOf(who);
    if (who.kind === "new") {
      this.#fly(roomId, memberId);
      try {
        // The actor loads the room and retries the op's commit until it
        // lands, so a slow load is waited out here, never taken for a
        // failed member op.
        await this.#gateway.addMember(roomId, who.member);
      } catch (err) {
        // A full, missing, read-only or unloadable room wrote nothing. Any
        // other failure may have left the member behind, so it comes off
        // again, which does nothing when it never arrived.
        if (err instanceof RoomFullError || err instanceof RoomNotFoundError || err instanceof HttpError) this.#land(roomId, memberId);
        else this.#undoLater(roomId, memberId);
        return refused(err, this.#log);
      }
    }

    const attempt = { playerEpoch: 0 };
    try {
      await withTx(
        this.#pool,
        async (tx) => {
          await tx.query("set local lock_timeout = '2s'; set local statement_timeout = '5s'");
          const { rows } = await tx.query<LockedRoom>("select join_mode, player_epoch, dm_epoch from rooms where id = $1 for update", [roomId]);
          const room = rows[0];
          if (!room) throw new HttpError(404, "room_not_found");
          attempt.playerEpoch = room.player_epoch;
          await plan.locked(tx, room);
          await this.#notInAlready(tx, plan.sessionId, roomId, room);
          // Under the room lock, which a DM claim also takes, so a member
          // that became a DM a moment ago cannot slip through.
          if (who.kind === "member" && (await formerDms(tx, roomId)).has(memberId)) throw new HttpError(403, "not_a_player");
          // Last, with nothing awaited before the write: a kick from after
          // this check waits on the room lock held here, and deletes the
          // grant once it commits.
          if (this.#kickedSince(roomId, memberId, begun)) throw new HttpError(409, "member_removed");
          await putGrant(tx, { sessionId: plan.sessionId, roomId, memberId, role: "player", epoch: room.player_epoch });
        },
        { checkoutMs: this.#checkoutMs },
      );
    } catch (err) {
      if (err instanceof CommitOutcomeUnknown) return this.#unknownCommit(plan, memberId, attempt.playerEpoch, settle);
      // Nothing was committed: the failure came before COMMIT was sent. The
      // refusal is known now, so it is answered now, and the member comes
      // off behind it, in flight until it has.
      if (who.kind === "new") this.#undoLater(roomId, memberId);
      return refused(err, this.#log);
    }
    return this.#committed(plan, memberId, attempt.playerEpoch);
  }

  /** A current grant here whose member exists means this device is in already. */
  async #notInAlready(tx: pg.PoolClient, sessionId: string, roomId: string, room: LockedRoom): Promise<void> {
    const { rows } = await tx.query<{ role: string; member_id: string; epoch: number }>(
      "select role, member_id, epoch from grants where session_id = $1 and room_id = $2 and role in ('dm', 'player')",
      [sessionId, roomId],
    );
    const grant = rows[0];
    if (!grant) return;
    const current = grant.role === "dm" ? room.dm_epoch : room.player_epoch;
    if (grant.epoch === current && (await this.#gateway.getMember(roomId, grant.member_id))) throw new HttpError(409, "already_in");
  }

  async #committed(plan: AdmitPlan, memberId: string, playerEpoch: number): Promise<AdmitOutcome> {
    const { roomId, sessionId, who } = plan;
    let member: Member | null;
    try {
      member = await bounded(this.#gateway.getMember(roomId, memberId), this.#memberMs);
    } catch (err) {
      // The grant stands. Without a read, the member this attempt added is the best answer.
      this.#log?.warn({ err, roomId }, "join committed, but its member could not be read back");
      this.#land(roomId, memberId);
      return { kind: "in", memberId, member: who.kind === "new" ? who.member : null };
    }
    if (!member) {
      // The DM removed the member while the grant was being written. A
      // grant must never outlive its member, so this exact one is given up:
      // a newer grant on the session is left alone. A revoke that does not
      // land is owed, as an undo's is.
      const owed = { roomId, sessionId, memberId, epoch: playerEpoch };
      if (!(await this.#giveUp(owed))) this.#owedRevokes.set(`${roomId}|${sessionId}|${memberId}|${playerEpoch}`, owed);
      this.#land(roomId, memberId);
      return { kind: "refused", error: new HttpError(409, "member_removed") };
    }
    this.#land(roomId, memberId);
    return { kind: "in", memberId, member };
  }

  /**
   * The COMMIT's answer was lost. The grant is read back under the room
   * lock, which waits for the first transaction to end. Only the exact grant
   * counts as committed: a player grant naming this member at the attempt's
   * epoch, or a DM grant naming it at the room's DM epoch, since the
   * device's own DM link may have upgraded it since. Anything else stays
   * unknown for good, since a grant that committed may have been kicked.
   */
  async #unknownCommit(plan: AdmitPlan, memberId: string, playerEpoch: number, settle: (outcome: AdmitOutcome) => void): Promise<AdmitOutcome | typeof FOLLOWING> {
    this.#log?.warn({ roomId: plan.roomId }, "join outcome unknown");
    const decide = async (found: Reconciled): Promise<AdmitOutcome | null> => {
      plan.maybeCommitted?.();
      if (found === "committed") return this.#committed(plan, memberId, playerEpoch);
      if (found === "not") {
        this.#land(plan.roomId, memberId);
        return { kind: "unknown", memberId };
      }
      return null;
    };
    const first = await decide(await this.#reconcile(plan.roomId, plan.sessionId, memberId, playerEpoch));
    if (first) return first;
    // Followed up by the sweep until the read goes through, which settles
    // it. The member stays in flight meanwhile, and the caller hears
    // pending now rather than waiting on the sweep.
    this.#unreconciled.add(async () => {
      const later = await decide(await this.#reconcile(plan.roomId, plan.sessionId, memberId, playerEpoch));
      if (!later) return false;
      settle(later);
      return true;
    });
    return FOLLOWING;
  }

  async #reconcile(roomId: string, sessionId: string, memberId: string, playerEpoch: number): Promise<Reconciled> {
    try {
      return await withTx(
        this.#pool,
        async (tx): Promise<Reconciled> => {
          await tx.query("set local lock_timeout = '2s'; set local statement_timeout = '5s'");
          const room = await tx.query<{ dm_epoch: number }>("select dm_epoch from rooms where id = $1 for update", [roomId]);
          const dmEpoch = room.rows[0]?.dm_epoch;
          if (dmEpoch === undefined) return "not";
          const { rows } = await tx.query<{ role: string; member_id: string; epoch: number }>(
            "select role, member_id, epoch from grants where session_id = $1 and room_id = $2",
            [sessionId, roomId],
          );
          const grant = rows[0];
          if (!grant || grant.member_id !== memberId) return "not";
          if (grant.role === "player" && grant.epoch === playerEpoch) return "committed";
          if (grant.role === "dm" && grant.epoch === dmEpoch) return "committed";
          return "not";
        },
        { checkoutMs: this.#checkoutMs },
      );
    } catch (err) {
      this.#log?.warn({ err, roomId }, "join outcome could not be read back yet");
      return "unreachable";
    }
  }

  /**
   * Takes back a member added for a grant that did not commit, as Remove
   * does (server/http/members.ts): revoke every grant naming it, remove it,
   * revoke again. A step that does not land is owed, and the member stays
   * in flight until it does, so nobody claims a member on its way out.
   */
  async #undo(roomId: string, memberId: string): Promise<void> {
    const key = `${roomId}|${memberId}`;
    const deps = { pool: this.#pool, gateway: this.#gateway };
    try {
      // Every step bounded, and one past its bound is owed like a failed one.
      await revokeGrants(deps, roomId, { by: "member", memberId }, undefined, this.#revokeBounds());
      await bounded(this.#gateway.removeMember(roomId, memberId), this.#memberMs);
      await revokeGrants(deps, roomId, { by: "member", memberId }, undefined, this.#revokeBounds());
    } catch (err) {
      if (!(err instanceof RoomNotFoundError)) {
        this.#owed.set(key, { roomId, memberId });
        this.#log?.warn({ err, roomId }, "a join's member could not be taken back yet");
        return;
      }
    }
    this.#owed.delete(key);
    this.#land(roomId, memberId);
  }

  /** An undo behind a refusal already answered. `followUp` waits for it, so the sweep and the tests see it through. */
  #undoLater(roomId: string, memberId: string): void {
    const running: Promise<void> = this.#undo(roomId, memberId).finally(() => this.#undoing.delete(running));
    this.#undoing.add(running);
  }

  /** Gives up exactly one grant. False when the revoke did not land in its bounds. */
  async #giveUp(owed: { roomId: string; sessionId: string; memberId: string; epoch: number }): Promise<boolean> {
    try {
      await revokeGrants({ pool: this.#pool, gateway: this.#gateway }, owed.roomId, { by: "exact", sessionId: owed.sessionId, memberId: owed.memberId, role: "player", epoch: owed.epoch }, undefined, this.#revokeBounds());
      return true;
    } catch (err) {
      this.#log?.warn({ err, roomId: owed.roomId }, "a grant whose member was removed could not be given up yet");
      return false;
    }
  }

  #fly(roomId: string, memberId: string): void {
    let set = this.#inFlight.get(roomId);
    if (!set) this.#inFlight.set(roomId, (set = new Set()));
    set.add(memberId);
  }

  #land(roomId: string, memberId: string): void {
    const set = this.#inFlight.get(roomId);
    if (!set) return;
    set.delete(memberId);
    if (set.size === 0) this.#inFlight.delete(roomId);
  }
}

/**
 * Kick and Remove's revoke (server/http/members.ts): every grant the member
 * holds here, ordered after each admission naming it. The kick is marked
 * first, so an admission that has not reached its grant's check writes
 * none, and the revoke takes the room row lock, which an admission past
 * that check holds until its grant commits, so the delete sees that grant.
 * A revoke that gets no connection or lock in time answers busy: the kick
 * is not done, and the DM tries again.
 */
export async function revokeMember(deps: { pool: pg.Pool; gateway: RoomGateway; admissions: Admissions }, roomId: string, memberId: string): Promise<RevokeResult> {
  deps.admissions.kicked(roomId, memberId);
  try {
    return await revokeGrants(
      deps,
      roomId,
      { by: "member", memberId },
      async (tx) => {
        await tx.query("select 1 from rooms where id = $1 for update", [roomId]);
      },
      KICK_BOUNDS,
    );
  } catch (err) {
    if (err instanceof CheckoutTimeout || timedOutInDb(err)) throw new HttpError(503, "busy", { retryAfter: 2 });
    throw err;
  }
}

/** Postgres's lock timeout (55P03) or statement timeout (57014). */
function timedOutInDb(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "55P03" || code === "57014";
}

const EMPTY: ReadonlySet<string> = new Set();

function memberOf(who: AdmitWho): string {
  return who.kind === "new" ? who.member.id : who.memberId;
}

class TimedOut extends Error {
  constructor() {
    super("timed out");
    this.name = "TimedOut";
  }
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TimedOut()), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The refusals a caller answers as they are, and every other failure, a
 * timeout, a checkout that never came or a statement error, as busy: it
 * wrote no grant, so trying again is safe.
 */
function refused(err: unknown, log: FastifyBaseLogger | undefined): AdmitOutcome {
  if (err instanceof HttpError || err instanceof RoomFullError || err instanceof RoomNotFoundError) return { kind: "refused", error: err };
  log?.warn({ err }, "a join attempt failed before its grant committed");
  return { kind: "refused", error: new HttpError(503, "busy", { retryAfter: 2 }) };
}
