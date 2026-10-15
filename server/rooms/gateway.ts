import type pg from "pg";
import type { Member, MemberId, RoomState } from "#shared/model.ts";
import { withTx, type Queryable } from "../auth/tx.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { applyOp } from "#shared/reducer.ts";

/**
 * Everything the HTTP routes do to a room's state or its open sockets goes
 * through this interface.
 *
 * The room actor (design section 7.2) is the single writer of a loaded room.
 * If a route wrote the snapshot row behind its back, the actor's next
 * snapshot would silently undo it, and a kicked member's socket would stay
 * open. So the access routes never touch room state directly: when the actor
 * exists it implements this interface and applies each change through its
 * queue. Until then, DirectGateway below reads and writes the snapshot row,
 * which is correct while nothing else holds the room in memory.
 */
export type RosterEntry = { id: MemberId; name: string; color: string };

/** Which of a room's sockets to close. Sockets are bound to a session's grant. */
export type SocketFilter = { sessionIds: readonly string[] } | { all: true };

/** Close codes from design section 7.1. */
export const CLOSE_GRANT_REVOKED = 4001;
export const CLOSE_ROOM_DELETED = 4009;

/** Members per room (design section 10.5). */
export const MAX_MEMBERS = 50;

/** The snapshot format this server writes, owned by the migrations in shared/migrate.ts. */
export const SNAPSHOT_SCHEMA_VERSION = SNAPSHOT_VERSION;

export class RoomNotFoundError extends Error {
  constructor(roomId: string) {
    super(`room ${roomId} not found`);
    this.name = "RoomNotFoundError";
  }
}

export class RoomFullError extends Error {
  constructor() {
    super(`a room holds at most ${MAX_MEMBERS} members`);
    this.name = "RoomFullError";
  }
}

export interface RoomGateway {
  /**
   * Writes a new room's first snapshot. Runs in the caller's transaction
   * when given one, so a room row never exists without its state.
   */
  createRoom(roomId: string, state: RoomState, tx?: Queryable): Promise<void>;
  /** Throws RoomFullError at the member limit, RoomNotFoundError for a missing room. */
  addMember(roomId: string, member: Member): Promise<void>;
  /** A no-op when the member is missing or already has that kind. */
  setMemberKind(roomId: string, memberId: MemberId, kind: Member["kind"]): Promise<void>;
  /** Takes a member off the roster with everything it owned let go (S-15). A no-op when it is already gone. */
  removeMember(roomId: string, memberId: MemberId): Promise<void>;
  closeSockets(roomId: string, filter: SocketFilter, code: number): void;
  /**
   * Tells the room's DM sockets that its access changed outside the room
   * state (the player password, a DM device added or signed out), so their
   * DM views ask again. A no-op when the room is not loaded, since nobody
   * is there.
   */
  accessChanged(roomId: string): void;
  /** Sessions with a socket open in the room now. Empty when the room is not loaded. */
  openSessions(roomId: string): ReadonlySet<string>;
  /** Closes the room's sockets with 4009 and deletes it. False when it did not exist. */
  deleteRoom(roomId: string): Promise<boolean>;
  /** Player members only, never DM members, in join order. Null for a missing room. */
  playerRoster(roomId: string): Promise<RosterEntry[] | null>;
  /** DM members only, in join order, for a DM claim's "This is me" (design 10.2). Null for a missing room. */
  dmRoster(roomId: string): Promise<RosterEntry[] | null>;
  getMember(roomId: string, memberId: MemberId): Promise<Member | null>;
}

export type CloseRecord = { roomId: string; filter: SocketFilter; code: number };

/** One kind of member, in join order, with only what a roster shows. */
export function rosterOf(members: RoomState["members"], kind: Member["kind"]): RosterEntry[] {
  return Object.values(members)
    .filter((m) => m.kind === kind)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ id, name, color }) => ({ id, name, color }));
}

export class DirectGateway implements RoomGateway {
  /**
   * Recent closeSockets calls. With no actor there are no sockets to close,
   * so they are only recorded, for tests and for the log.
   */
  readonly closed: CloseRecord[] = [];
  #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async createRoom(roomId: string, state: RoomState, tx?: Queryable): Promise<void> {
    await (tx ?? this.#pool).query(
      "insert into room_snapshots (room_id, seq, state, schema_version) values ($1, 0, $2::jsonb, $3)",
      [roomId, JSON.stringify(state), SNAPSHOT_SCHEMA_VERSION],
    );
  }

  addMember(roomId: string, member: Member): Promise<void> {
    return this.#update(roomId, (state) => {
      if (state.members[member.id]) return false;
      if (Object.keys(state.members).length >= MAX_MEMBERS) throw new RoomFullError();
      state.members[member.id] = member;
      return true;
    });
  }

  setMemberKind(roomId: string, memberId: MemberId, kind: Member["kind"]): Promise<void> {
    return this.#update(roomId, (state) => {
      const member = state.members[memberId];
      if (!member || member.kind === kind) return false;
      state.members[memberId] = { ...member, kind, rev: member.rev + 1 };
      return true;
    }).catch((err: unknown) => {
      // The room may have been deleted between revoking a grant and
      // relabelling its member. Nothing is left to relabel.
      if (!(err instanceof RoomNotFoundError)) throw err;
    });
  }

  removeMember(roomId: string, memberId: MemberId): Promise<void> {
    return this.#update(roomId, (state) => {
      // The same reducer the actor runs, so a room edited here matches one edited live.
      const result = applyOp(state, { t: "sys.memberRemove", memberId }, { memberId: "server", role: "dm" }, { seq: 0, at: new Date().toISOString() });
      if (!result.ok) return false;
      Object.assign(state, result.state);
      return true;
    });
  }

  closeSockets(roomId: string, filter: SocketFilter, code: number): void {
    this.closed.push({ roomId, filter, code });
    if (this.closed.length > 100) this.closed.splice(0, this.closed.length - 100);
  }

  accessChanged(_roomId: string): void {
    // With no actor there are no sockets to tell.
  }

  openSessions(_roomId: string): ReadonlySet<string> {
    // With no actor there are no sockets.
    return new Set();
  }

  async deleteRoom(roomId: string): Promise<boolean> {
    this.closeSockets(roomId, { all: true }, CLOSE_ROOM_DELETED);
    const result = await this.#pool.query("delete from rooms where id = $1", [roomId]);
    return result.rowCount === 1;
  }

  async playerRoster(roomId: string): Promise<RosterEntry[] | null> {
    const state = await this.#read(roomId);
    return state ? rosterOf(state.members, "player") : null;
  }

  async dmRoster(roomId: string): Promise<RosterEntry[] | null> {
    const state = await this.#read(roomId);
    return state ? rosterOf(state.members, "dm") : null;
  }

  async getMember(roomId: string, memberId: MemberId): Promise<Member | null> {
    const state = await this.#read(roomId);
    return state?.members[memberId] ?? null;
  }

  async #read(roomId: string): Promise<RoomState | null> {
    const { rows } = await this.#pool.query<{ state: RoomState }>(
      "select state from room_snapshots where room_id = $1",
      [roomId],
    );
    return rows[0]?.state ?? null;
  }

  /** Read, change and write the snapshot under a row lock, so concurrent joins cannot lose a member. */
  #update(roomId: string, change: (state: RoomState) => boolean): Promise<void> {
    return withTx(this.#pool, async (tx) => {
      const { rows } = await tx.query<{ state: RoomState }>(
        "select state from room_snapshots where room_id = $1 for update",
        [roomId],
      );
      const state = rows[0]?.state;
      if (!state) throw new RoomNotFoundError(roomId);
      if (change(state)) {
        await tx.query("update room_snapshots set state = $2::jsonb, written_at = now() where room_id = $1", [
          roomId,
          JSON.stringify(state),
        ]);
      }
    });
  }
}

declare module "fastify" {
  interface FastifyInstance {
    gateway: RoomGateway;
  }
}
