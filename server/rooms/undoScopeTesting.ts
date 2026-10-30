import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Member, RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { actor as creature, character, member, token } from "#shared/testutil.ts";
import { historyMessageSchema, type HistoryDirection, type HistoryMessage, type HistoryScope } from "#shared/undoContract.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import type { Pool } from "./persistence.ts";

type Wire = ServerMessage | HistoryMessage;
type Event = Extract<ServerMessage, { t: "ev" }>;

/** The real actor and fanout run against these rows, without a socket or database. */
export class UndoScopeDb {
  readonly state: RoomState;
  readonly stored: Op[] = [];
  assetLookups = 0;
  durableMax = 0;
  beforeCommit?: () => Promise<void>;
  beforeAssets?: () => Promise<void>;
  assetRows: object[] = [];
  #staged: number[] = [];

  constructor(state: RoomState) {
    this.state = state;
  }

  pool(): Pool {
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from room_snapshots")) return { rows: [{ seq: "0", state: this.state, schema_version: SNAPSHOT_VERSION }] };
      if (sql.includes("max(seq)")) return { rows: [{ max: String(this.durableMax) }] };
      if (sql.includes("from grants")) return { rows: Object.values(this.state.members).filter((m) => m.kind === "dm").map((m) => ({ member_id: m.id })) };
      if (sql.includes("from assets")) {
        this.assetLookups++;
        await this.beforeAssets?.();
        return { rows: this.assetRows };
      }
      if (sql.startsWith("insert into room_ops")) {
        this.#staged = params[1] as number[];
        this.stored.push(...(params[5] as string[]).map((op) => JSON.parse(op) as Op));
      }
      if (sql.trim() === "commit") {
        await this.beforeCommit?.();
        this.durableMax = Math.max(this.durableMax, ...this.#staged);
        this.#staged = [];
      }
      return { rows: [], rowCount: 0 };
    };
    return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  }
}

export function scopeFixture() {
  const dm = member(uuidv7(), "dm");
  const otherDm = member(uuidv7(), "dm");
  const player = member(uuidv7());
  const unrelated = member(uuidv7());
  const state = createInitialState({ roomName: "Scoped history", dm });
  for (const m of [otherDm, player, unrelated]) state.members[m.id] = m;
  const sceneId = state.meta.playerSceneId!;
  const goblin = uuidv7();
  const bree = uuidv7();
  const pc = uuidv7();
  state.tokens[goblin] = token(goblin, { sceneId, name: "Goblin 2", actor: { inline: creature({ dmNotes: "" }) } });
  state.characters[bree] = character(bree, { name: "Bree", ownerIds: [player.id], actor: creature({ dmNotes: "" }) });
  state.tokens[pc] = token(pc, { sceneId, kind: "pc", name: "Bree", x: 8, actor: { ref: bree } });
  return { state, dm, otherDm, player, unrelated, goblin, bree, pc, sceneId };
}

export async function until<T>(get: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = get();
    if (value !== undefined) return value;
    await delay(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}

export async function scopeActor(t: TestContext, state: RoomState) {
  const db = new UndoScopeDb(state);
  const info: ActorDeps["info"] = { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false };
  const actor = await RoomActor.load({
    pool: db.pool(), info,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    budget: new SnapshotBudget(), gateway: {} as RoomGateway,
    options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000 },
  });
  assert.ok(actor);
  t.after(async () => {
    db.beforeCommit = undefined;
    db.beforeAssets = undefined;
    await actor.shutdown({ code: 1012, snapshot: false });
  });
  return { actor, db, info, connect: (who: Member, role: "dm" | "player" = who.kind === "dm" ? "dm" : "player") => ScopeClient.open(actor, who, role) };
}

export class ScopeClient {
  readonly actor: RoomActor;
  readonly conn: Connection;
  readonly sent: Wire[] = [];
  readonly clientId = uuidv7();
  n = 0;

  private constructor(actor: RoomActor, who: Member, role: "dm" | "player") {
    this.actor = actor;
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => this.sent.push(JSON.parse(text) as Wire), close() {}, terminate() {} };
    this.conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "UNDOSCOPE", memberId: who.id, role }, "203.0.113.9");
    actor.attach(this.conn);
  }

  static async open(actor: RoomActor, who: Member, role: "dm" | "player"): Promise<ScopeClient> {
    const client = new ScopeClient(actor, who, role);
    await actor.hello(client.conn, { clientId: client.clientId, resumeFrom: 1 });
    await until(() => client.sent.find((m) => m.t === "snapshot"), "snapshot");
    return client;
  }

  history(): HistoryMessage {
    const message = this.sent.findLast((m) => m.t === "history");
    assert.ok(message, "a committed snapshot/event must be followed by private history");
    return historyMessageSchema.parse(message);
  }

  head(scope: HistoryScope = "play", direction: HistoryDirection = "undo") {
    const stack = this.history()[scope]?.[direction];
    assert.ok(stack?.head, `expected ${scope} ${direction} head`);
    return stack.head;
  }

  async send(op: unknown, group?: string): Promise<Event> {
    const n = ++this.n;
    await this.actor.op(this.conn, n, op, group);
    return until(() => this.sent.find((m): m is Event => m.t === "ev" && Boolean(m.acks?.includes(n) || m.rejects?.some((r) => r.n === n))), `terminal event ${n}`);
  }

  async apply(op: unknown, group?: string): Promise<Event> {
    const event = await this.send(op, group);
    assert.equal(event.rejects?.length ?? 0, 0, JSON.stringify(event.rejects));
    assert.ok(event.acks?.includes(this.n), "accepted command has a terminal ack");
    return event;
  }

  async restore(scope: HistoryScope = "play", direction: HistoryDirection = "undo"): Promise<Event> {
    return this.apply({ t: direction, scope, head: this.head(scope, direction).id });
  }
}
