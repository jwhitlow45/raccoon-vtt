import type pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import type { Member } from "#shared/model.ts";
import { RoomNotFoundError, type RoomGateway } from "../rooms/gateway.ts";
import { newRoomId } from "./roomId.ts";
import { randomToken, sha256 } from "./tokens.ts";
import { withTx } from "./tx.ts";

/**
 * Creating a room and replacing its DM key: the parts shared by the HTTP
 * routes and scripts/admin.ts, so the admin command can never drift from
 * what the site does.
 */
export type NewRoom = { roomId: string; dmKey: string; dmMember: Member };

export function newMember(name: string, color: string, kind: Member["kind"]): Member {
  return { id: uuidv7(), rev: 1, name, color, kind, createdAt: new Date().toISOString() };
}

/**
 * Inserts the room row and its first snapshot in one transaction. `within`
 * runs in that transaction after both inserts, for the creation limits and
 * the creator's session and grant, so any refusal there leaves no trace.
 */
export async function createRoomRecord(
  deps: { pool: pg.Pool; gateway: RoomGateway },
  input: { name: string; playerPwHash: string; dmName: string; dmColor: string; createdIp: string | null },
  within?: (tx: pg.PoolClient, room: NewRoom) => Promise<void>,
): Promise<NewRoom> {
  const dmKey = randomToken();
  const dmMember = newMember(input.dmName, input.dmColor, "dm");
  return withTx(deps.pool, async (tx) => {
    let roomId = "";
    // 40 random bits make a collision unlikely, not impossible. `on conflict
    // do nothing` retries without aborting the transaction.
    for (let attempt = 0; attempt < 5 && !roomId; attempt++) {
      const candidate = newRoomId();
      const { rowCount } = await tx.query(
        `insert into rooms (id, name, player_pw_hash, dm_key_hash, created_ip) values ($1, $2, $3, $4, $5)
         on conflict (id) do nothing`,
        [candidate, input.name, input.playerPwHash, sha256(dmKey), input.createdIp],
      );
      if (rowCount === 1) roomId = candidate;
    }
    if (!roomId) throw new Error("could not find a free room id");
    const state = createInitialState({ roomName: input.name, dm: dmMember });
    await deps.gateway.createRoom(roomId, state, tx);
    const room = { roomId, dmKey, dmMember };
    if (within) await within(tx, room);
    return room;
  });
}

/**
 * A new DM key and the next `dm_epoch`. Every outstanding invite was minted
 * at the old epoch and is void from here, so those rows go too.
 *
 * Call it inside revokeGrants' `before`, so the epoch bump and the removal of
 * the old DM grants commit together.
 */
export async function replaceDmKey(tx: pg.PoolClient, roomId: string): Promise<{ key: string; epoch: number }> {
  const key = randomToken();
  const { rows } = await tx.query<{ dm_epoch: number }>(
    "update rooms set dm_key_hash = $2, dm_epoch = dm_epoch + 1 where id = $1 returning dm_epoch",
    [roomId, sha256(key)],
  );
  const row = rows[0];
  if (!row) throw new RoomNotFoundError(roomId);
  await tx.query("delete from dm_invites where room_id = $1 and used_at is null", [roomId]);
  return { key, epoch: row.dm_epoch };
}
