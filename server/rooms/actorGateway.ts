import type pg from "pg";
import type { Member, MemberId, RoomState } from "#shared/model.ts";
import { HttpError } from "../auth/http.ts";
import type { Queryable } from "../auth/tx.ts";
import { RoomReplayFailed, SysOpRefused } from "./actor.ts";
import { RoomFullError, RoomNotFoundError, rosterOf, SNAPSHOT_SCHEMA_VERSION, type RoomGateway, type RosterEntry, type SocketFilter } from "./gateway.ts";
import { TooBusyError } from "./errors.ts";
import type { RoomManager } from "./manager.ts";

/**
 * The RoomGateway the HTTP routes use once the room engine exists: every
 * roster change becomes a server op through the room's actor queue, so the
 * actor stays the single writer of a loaded room, and socket closes reach
 * real sockets.
 */
export class ActorGateway implements RoomGateway {
  #manager: RoomManager;
  #pool: pg.Pool;

  constructor(manager: RoomManager, pool: pg.Pool) {
    this.#manager = manager;
    this.#pool = pool;
  }

  async createRoom(roomId: string, state: RoomState, tx?: Queryable): Promise<void> {
    await (tx ?? this.#pool).query(
      "insert into room_snapshots (room_id, seq, state, schema_version) values ($1, 0, $2::jsonb, $3)",
      [roomId, JSON.stringify(state), SNAPSHOT_SCHEMA_VERSION],
    );
  }

  async addMember(roomId: string, member: Member): Promise<void> {
    const { rev: _rev, ...plain } = member;
    try {
      await this.#manager.withRoom(roomId, (actor) => actor.sys({ t: "sys.memberJoin", member: plain }));
    } catch (err) {
      if (err instanceof RoomReplayFailed) throw new HttpError(409, "read_only");
      if (err instanceof SysOpRefused && err.code === "quota") throw new RoomFullError();
      throw busyAsHttp(err);
    }
  }

  async setMemberKind(roomId: string, memberId: MemberId, kind: Member["kind"]): Promise<void> {
    try {
      await this.#manager.withRoom(roomId, (actor) => actor.sys({ t: "sys.memberSetKind", memberId, kind }));
    } catch (err) {
      // The room may be gone, or the member: nothing is left to relabel either way.
      if (err instanceof RoomNotFoundError || err instanceof SysOpRefused) return;
      throw busyAsHttp(err);
    }
  }

  async removeMember(roomId: string, memberId: MemberId): Promise<void> {
    try {
      await this.#manager.withRoom(roomId, (actor) => actor.sys({ t: "sys.memberRemove", memberId }));
    } catch (err) {
      if (err instanceof RoomReplayFailed) throw new HttpError(409, "read_only");
      throw busyAsHttp(err);
    }
  }

  closeSockets(roomId: string, filter: SocketFilter, code: number): void {
    this.#manager.get(roomId)?.closeSockets(filter, code);
  }

  accessChanged(roomId: string): void {
    this.#manager.get(roomId)?.notifyAccess();
  }

  openSessions(roomId: string): ReadonlySet<string> {
    return this.#manager.get(roomId)?.openSessionIds() ?? new Set();
  }

  async deleteRoom(roomId: string): Promise<boolean> {
    await this.#manager.unloadForDelete(roomId);
    const result = await this.#pool.query("delete from rooms where id = $1", [roomId]);
    return result.rowCount === 1;
  }

  async playerRoster(roomId: string): Promise<RosterEntry[] | null> {
    const members = await this.#members(roomId);
    return members ? rosterOf(members, "player") : null;
  }

  async dmRoster(roomId: string): Promise<RosterEntry[] | null> {
    const members = await this.#members(roomId);
    return members ? rosterOf(members, "dm") : null;
  }

  async getMember(roomId: string, memberId: MemberId): Promise<Member | null> {
    const members = await this.#members(roomId);
    return members?.[memberId] ?? null;
  }

  async #members(roomId: string): Promise<RoomState["members"] | null> {
    try {
      return await this.#manager.withRoom(roomId, (actor) => actor.committed.state.members);
    } catch (err) {
      if (err instanceof RoomNotFoundError) return null;
      throw busyAsHttp(err);
    }
  }
}

/** A room that cannot load right now answers 503 with Retry-After, like every other transient refusal. */
function busyAsHttp(err: unknown): unknown {
  return err instanceof TooBusyError ? new HttpError(503, "busy", { retryAfter: 30 }) : err;
}
