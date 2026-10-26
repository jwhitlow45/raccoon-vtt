import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Member, RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import type { Pool } from "./persistence.ts";

/**
 * A DM's view as a player in the room actor (docs/design-v1-per-player-vision.md
 * 7.4, review R2-SEC-6): its key is its own, so its hello never cancels
 * the delayed snapshot of its DM's device with the same client id, it never
 * becomes that device's socket, and it ends when its player leaves.
 */

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function member(name: string, kind: Member["kind"]): Member {
  return { id: uuidv7(), rev: 0, name, color: "#336699", kind, createdAt: new Date().toISOString() };
}

/** A database that answers every statement at once: the snapshot to load, no op rows, the DM's grant, and success for every write. */
function memoryPool(state: RoomState, dmId: string): Pool {
  const run = (sql: string): Promise<{ rows: unknown[]; rowCount?: number }> =>
    Promise.resolve().then(() => {
      if (sql.includes("from room_snapshots")) return { rows: [{ seq: "0", state, schema_version: SNAPSHOT_VERSION }] };
      if (sql.includes("from grants")) return { rows: [{ member_id: dmId }] };
      return { rows: [], rowCount: 0 };
    });
  return { query: run, connect: () => Promise.resolve({ query: run, release: () => undefined }) } as unknown as Pool;
}

function socket(actor: RoomActor, grant: { sessionId: string; memberId: string; role: "dm" | "player"; previewOf?: string }): { conn: Connection; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const raw = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(raw as never, { roomId: "PREVIEW1", ...grant }, "203.0.113.5");
  actor.attach(conn);
  return { conn, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function table(budget: SnapshotBudget) {
  const dm = member("DM", "dm");
  const pip = member("Pip", "player");
  const state = createInitialState({ roomName: "Preview", dm });
  state.members[pip.id] = pip;
  const deps: ActorDeps = {
    pool: memoryPool(state, dm.id),
    info: { roomId: "PREVIEW1", pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget,
    gateway: {} as RoomGateway,
    options: { batchMs: 1, snapshotIdleMs: 60_000, grantRecheckMs: 60_000 },
  };
  const actor = await RoomActor.load(deps);
  assert.ok(actor);
  return { actor, dm, pip, session: uuidv7() };
}

describe("a preview in the room actor", () => {
  test("its hello leaves its DM device's delayed snapshot alone, and neither takes the other's place", async () => {
    // One snapshot a session for a moment, so the second and third wait.
    const { actor, dm, pip, session } = await table(new SnapshotBudget({ windowMs: 250, sessionCount: 1 }));
    const first = socket(actor, { sessionId: session, memberId: dm.id, role: "dm" });
    await actor.hello(first.conn, { clientId: "dev", resumeFrom: 1 });
    await settle();
    assert.ok(first.sent.some((m) => m.t === "snapshot"));
    // The DM's device reconnects with the same client id, and waits for the budget.
    const device = socket(actor, { sessionId: session, memberId: dm.id, role: "dm" });
    await actor.hello(device.conn, { clientId: "dev", resumeFrom: 1 });
    await settle();
    assert.ok(device.sent.some((m) => m.t === "wait") && !device.sent.some((m) => m.t === "snapshot"));
    // Then the DM views as Pip from that session, with that client id too.
    const view = socket(actor, { sessionId: session, memberId: dm.id, role: "dm", previewOf: pip.id });
    await actor.hello(view.conn, { clientId: "dev", resumeFrom: 1 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const deviceSnap = device.sent.find((m): m is Extract<ServerMessage, { t: "snapshot" }> => m.t === "snapshot");
    const viewSnap = view.sent.find((m): m is Extract<ServerMessage, { t: "snapshot" }> => m.t === "snapshot");
    assert.ok(deviceSnap, "the device's delayed snapshot still came");
    assert.equal(deviceSnap.you.role, "dm");
    assert.ok(viewSnap, "the preview's came too");
    assert.deepEqual([viewSnap.you.memberId, viewSnap.you.role], [pip.id, "player"]);
    // The device is its client's socket: its op is answered there, and the preview takes nothing.
    device.sent.length = 0;
    view.sent.length = 0;
    await actor.op(device.conn, 1, { t: "log.chat", text: "hello" });
    await settle();
    assert.ok(device.sent.some((m) => m.t === "ev" && m.acks?.includes(1)), "answered on the device");
    assert.ok(view.sent.some((m) => m.t === "ev") && !view.sent.some((m) => m.t === "ev" && (m.acks !== undefined || m.rejects !== undefined)), "the preview sees the line and takes no answer");
    await actor.shutdown({ code: 1012, snapshot: false });
  });

  test("a preview ends when its player leaves the roster, and every other socket stays", async () => {
    const { actor, dm, pip, session } = await table(new SnapshotBudget());
    const device = socket(actor, { sessionId: session, memberId: dm.id, role: "dm" });
    await actor.hello(device.conn, { clientId: "dev", resumeFrom: 1 });
    const view = socket(actor, { sessionId: session, memberId: dm.id, role: "dm", previewOf: pip.id });
    await actor.hello(view.conn, { clientId: "view", resumeFrom: 1 });
    await settle();
    assert.equal(view.conn.closed, false);
    await actor.sys({ t: "sys.memberRemove", memberId: pip.id });
    await settle();
    assert.equal(view.conn.closedWith, 4003);
    assert.equal(device.conn.closed, false);
    // A hello for a player no longer on the roster closes at once.
    const late = socket(actor, { sessionId: session, memberId: dm.id, role: "dm", previewOf: pip.id });
    await actor.hello(late.conn, { clientId: "late", resumeFrom: 1 });
    await settle();
    assert.equal(late.conn.closedWith, 4003);
    assert.ok(!late.sent.some((m) => m.t === "snapshot"));
    await actor.shutdown({ code: 1012, snapshot: false });
  });
});
