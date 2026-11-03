import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { Member } from "#shared/model.ts";
import { RoomFullError, RoomNotFoundError, type RoomGateway } from "../rooms/gateway.ts";
import { formerDms, putGrant, revokeGrants } from "./grants.ts";
import { HttpError } from "./http.ts";
import { CommitOutcomeUnknown, withTx } from "./tx.ts";

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
 */

/** How long a caller waits for a new member to land, the room's load included, before it answers that the join is still settling. */
export const MEMBER_ANSWER_MS = 5_000;
/** The grant transaction's pool checkout. */
export const GRANT_CHECKOUT_MS = 2_000;

export type LockedRoom = { player_epoch: number; dm_epoch: number };

export type AdmitWho = { kind: "new"; member: Member } | { kind: "member"; memberId: string };

export type AdmitOutcome =
  /** The grant committed and its member is there. `member` is null only when the room could not be read back. */
  | { kind: "in"; memberId: string; member: Member | null }
  /** No grant was written, or the one written was given up. Any member the attempt added is taken back off, now or by the sweep. */
  | { kind: "refused"; error: Error }
  /** The commit may or may not have landed, and reading it back could not tell. The member stays. */
  | { kind: "unknown"; memberId: string };

/** `pending`: the member has not landed within the bound. The attempt goes on and settles later. */
export type AdmitAnswer = AdmitOutcome | { kind: "pending"; memberId: string };

export type AdmitPlan = {
  roomId: string;
  /** The session the grant goes on: the caller's own for a join, the requester's for a let-in. */
  sessionId: string;
  who: AdmitWho;
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
  memberMs?: number;
  checkoutMs?: number;
};

type Reconciled = "committed" | "not" | "unreachable";

export class Admissions {
  #pool: pg.Pool;
  #gateway: RoomGateway;
  #log: FastifyBaseLogger | undefined;
  #memberMs: number;
  #checkoutMs: number;
  /** Members being added for a join, by room. */
  #inFlight = new Map<string, Set<string>>();
  /** Members whose removal after a rolled-back grant did not land, retried by the sweep. */
  #owed = new Map<string, { roomId: string; memberId: string }>();
  /** Attempts whose commit outcome could not be read back yet, each a follow-up that answers true once settled. */
  #unreconciled = new Set<() => Promise<boolean>>();
  #following: Promise<void> | null = null;

  constructor(deps: { pool: pg.Pool; gateway: RoomGateway; log?: FastifyBaseLogger | undefined; options?: AdmissionsOptions | undefined }) {
    this.#pool = deps.pool;
    this.#gateway = deps.gateway;
    this.#log = deps.log;
    this.#memberMs = deps.options?.memberMs ?? MEMBER_ANSWER_MS;
    this.#checkoutMs = deps.options?.checkoutMs ?? GRANT_CHECKOUT_MS;
  }

  /** The room's members in flight, for "continue as" and the DM's carry-on list to leave out. */
  inFlight(roomId: string): ReadonlySet<string> {
    return this.#inFlight.get(roomId) ?? EMPTY;
  }

  /** What the sweep still has to do: removals owed and outcomes not read back. */
  get followUps(): number {
    return this.#owed.size + this.#unreconciled.size;
  }

  /**
   * Runs one attempt. The answer comes once the outcome is known, or as
   * `pending` once a new member has taken `memberMs` without landing.
   * `plan.settled` hears the outcome either way, before the answer.
   */
  admit(plan: AdmitPlan): Promise<AdmitAnswer> {
    let landed = plan.who.kind !== "new";
    const outcome = this.#attempt(plan, () => (landed = true))
      .catch((err: unknown): AdmitOutcome => ({ kind: "refused", error: asError(err) }))
      .then((o) => {
        try {
          plan.settled(o);
        } catch (err) {
          this.#log?.error({ err, roomId: plan.roomId }, "join settlement failed");
        }
        return o;
      });
    if (landed) return outcome;
    const memberId = memberOf(plan.who);
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<AdmitAnswer>((resolve) => {
      // A member that landed in time is followed to the end: the grant's own steps are bounded.
      timer = setTimeout(() => resolve(landed ? outcome : { kind: "pending", memberId }), this.#memberMs);
    });
    return Promise.race([outcome, bound]).finally(() => clearTimeout(timer));
  }

  /** The sweep's part: owed removals, then outcomes still to read back. One run at a time. */
  followUp(): Promise<void> {
    this.#following ??= (async () => {
      try {
        for (const { roomId, memberId } of [...this.#owed.values()]) await this.#undo(roomId, memberId);
        for (const next of [...this.#unreconciled]) {
          if (await next().catch(() => false)) this.#unreconciled.delete(next);
        }
      } finally {
        this.#following = null;
      }
    })();
    return this.#following;
  }

  async #attempt(plan: AdmitPlan, onLanded: () => void): Promise<AdmitOutcome> {
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
        onLanded();
        // A full, missing, read-only or unloadable room wrote nothing. Any
        // other failure may have left the member behind, so it comes off
        // again, which does nothing when it never arrived.
        if (err instanceof RoomFullError || err instanceof RoomNotFoundError || err instanceof HttpError) this.#land(roomId, memberId);
        else await this.#undo(roomId, memberId);
        return refused(err, this.#log);
      }
      onLanded();
    }

    const attempt = { playerEpoch: 0 };
    try {
      await withTx(
        this.#pool,
        async (tx) => {
          await tx.query("set local lock_timeout = '2s'; set local statement_timeout = '5s'");
          const { rows } = await tx.query<LockedRoom>("select player_epoch, dm_epoch from rooms where id = $1 for update", [roomId]);
          const room = rows[0];
          if (!room) throw new HttpError(404, "room_not_found");
          attempt.playerEpoch = room.player_epoch;
          await plan.locked(tx, room);
          await this.#notInAlready(tx, plan.sessionId, roomId, room);
          // Under the room lock, which a DM claim also takes, so a member
          // that became a DM a moment ago cannot slip through.
          if (who.kind === "member" && (await formerDms(tx, roomId)).has(memberId)) throw new HttpError(403, "not_a_player");
          await putGrant(tx, { sessionId: plan.sessionId, roomId, memberId, role: "player", epoch: room.player_epoch });
        },
        { checkoutMs: this.#checkoutMs },
      );
    } catch (err) {
      if (err instanceof CommitOutcomeUnknown) return this.#unknownCommit(plan, memberId, attempt.playerEpoch);
      // Nothing was committed: the failure came before COMMIT was sent.
      if (who.kind === "new") await this.#undo(roomId, memberId);
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
      member = await this.#gateway.getMember(roomId, memberId);
    } catch (err) {
      // The grant stands. Without a read, the member this attempt added is the best answer.
      this.#log?.warn({ err, roomId }, "join committed, but its member could not be read back");
      this.#land(roomId, memberId);
      return { kind: "in", memberId, member: who.kind === "new" ? who.member : null };
    }
    if (!member) {
      // The DM removed the member while the grant was being written. A
      // grant must never outlive its member, so this exact one is given up:
      // a newer grant on the session is left alone.
      try {
        await revokeGrants({ pool: this.#pool, gateway: this.#gateway }, roomId, { by: "exact", sessionId, memberId, role: "player", epoch: playerEpoch });
      } catch (err) {
        this.#log?.warn({ err, roomId }, "a grant whose member was removed could not be given up");
      }
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
  async #unknownCommit(plan: AdmitPlan, memberId: string, playerEpoch: number): Promise<AdmitOutcome> {
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
    // Followed up by the sweep until the read goes through. The member
    // stays in flight meanwhile, and nothing settles.
    return new Promise<AdmitOutcome>((resolve) => {
      this.#unreconciled.add(async () => {
        const later = await decide(await this.#reconcile(plan.roomId, plan.sessionId, memberId, playerEpoch));
        if (!later) return false;
        resolve(later);
        return true;
      });
    });
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
      await revokeGrants(deps, roomId, { by: "member", memberId });
      await bounded(this.#gateway.removeMember(roomId, memberId), this.#memberMs);
      await revokeGrants(deps, roomId, { by: "member", memberId });
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
