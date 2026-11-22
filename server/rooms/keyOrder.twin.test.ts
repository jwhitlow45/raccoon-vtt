import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { asJsonb } from "#shared/keyOrderTestutil.ts";
import { actor as testActor, drawing, effect, room, template, token } from "#shared/testutil.ts";
import { RoomActor, type ActorDeps } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { ScopeClient, StoredRoomDb, until } from "./undoScopeTesting.ts";

/**
 * Two rooms alike in everything P1, P2 and a table display get, apart in
 * the order the DM made creatures in, in a delete the DM took back with
 * Undo, which puts the creature's key last in the room's map, and in how
 * the room was read back from storage: one as written, one with every
 * object's keys shorter first, as Postgres's jsonb keeps them. Every frame
 * those sockets get is compared as the exact text sent: the snapshot at a
 * socket's first hello, a join after the creatures are shown, a resync, a
 * reconnect and one after a restart, the batch that shows them, and P1's
 * own move. Only the ids a history frame is made with, which each room
 * makes at random, are read through a mapping.
 */

const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const DISPLAY = "display:abcdefghijkl";
const ID = (n: number) => `0199f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
/** Seen from the start. */
const WOLF = ID(1);
/** Made for the DM alone in both rooms first. The later room deletes it and takes the delete back. */
const ORC = ID(2);
/** Made for the DM alone, before the wolf in one room and after it in the other. */
const BAT = ID(3);
/** P1's own creature. */
const OWL = ID(4);

type Socket = { label: string; conn: Connection; texts: string[] };

type Kind = "earlier" | "later";

const create = (id: string, name: string, dmOnly: boolean, x: number): Op =>
  ({ t: "token.create", token: { id, sceneId: "s1", kind: "npc", name, size: "medium", x, y: 2, visibility: dmOnly ? "dm" : "all", actor: { inline: testActor() } } }) as Op;

class Twin {
  readonly kind: Kind;
  readonly clock = { now: T0 };
  readonly db: StoredRoomDb;
  readonly sockets: Socket[] = [];
  actor!: RoomActor;
  dm!: ScopeClient;
  readonly #t: TestContext;

  constructor(t: TestContext, kind: Kind, state: RoomState) {
    this.#t = t;
    this.kind = kind;
    this.db = new StoredRoomDb(state);
  }

  async load(): Promise<void> {
    const actor = await RoomActor.load({
      pool: this.db.pool(),
      info: { roomId: "KEYORDER", pinned: false, createdIp: null, readOnly: false },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      budget: new SnapshotBudget({}, () => this.clock.now),
      gateway: {} as RoomGateway,
      // The id gate is off: the fixture's ids are not dated by the test clock (createIds.ts).
      options: { batchMs: 1, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, snapshotOps: 1_000_000, now: () => this.clock.now, idGate: false },
    } satisfies ActorDeps);
    assert.ok(actor);
    this.actor = actor;
    this.#t.after(() => actor.shutdown({ code: 1012, snapshot: false }));
    this.dm = await ScopeClient.open(actor, actor.committed.state.members.dm1!, "dm");
  }

  to(ms: number): void {
    this.clock.now = T0 + ms;
  }

  /** A socket whose every frame is kept as the text sent, after its first hello's snapshot. */
  async open(label: string, grant: { memberId: string; display?: true }): Promise<Socket> {
    const texts: string[] = [];
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => texts.push(text), close() {}, terminate() {} };
    const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: "KEYORDER", role: "player", ...grant }, "203.0.113.30");
    this.actor.attach(conn);
    await this.actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
    await until(() => texts.find((m) => m.startsWith('{"t":"snapshot"')), `${label}'s snapshot`);
    const opened = { label, conn, texts };
    this.sockets.push(opened);
    await this.settle();
    return opened;
  }

  /** The room stops, writing its snapshot, and loads it again, read back as written or as jsonb gives it. */
  async restart(jsonb: boolean): Promise<void> {
    await this.actor.shutdown({ code: 1012, snapshot: true });
    if (jsonb) this.db.snapshot = { ...this.db.snapshot, state: asJsonb(this.db.snapshot.state) };
    await this.load();
  }

  async dmApply(op: Op): Promise<void> {
    await this.dm.apply(op);
    await this.settle();
  }

  /** The DM takes back their newest step. */
  async dmUndo(): Promise<void> {
    const history = this.dm.history();
    const scope = history.setup?.undo.head ? "setup" : "play";
    await this.dmApply({ t: "undo", scope, head: this.dm.head(scope, "undo").id } as Op);
  }

  async settle(): Promise<void> {
    let stored = -1;
    let quiet = 0;
    while (quiet < 2) {
      const now = this.db.stored.length;
      quiet = now === stored && this.actor.queueLength === 0 ? quiet + 1 : 0;
      stored = now;
      await delay(3);
    }
  }

  /** Every socket's frames, each as sent, with a history frame's ids numbered in the order they first appear. */
  frames(): string[] {
    const ids = new Map<string, string>();
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    return this.sockets.flatMap((s) =>
      s.texts.map((text) => {
        const line = text.startsWith('{"t":"history"') ? text.replace(uuid, (id) => ids.get(id) ?? (ids.set(id, `id-${ids.size + 1}`), `id-${ids.size}`)) : text;
        return `${s.label} ${line}`;
      }),
    );
  }
}

/** The room both twins start from: P1's owl with a condition on it, P1's area and drawing. */
function base(): RoomState {
  const state = room();
  const owl = token(OWL, { kind: "npc", name: "Owl", ownerIds: ["p1"], x: 1, y: 1 });
  if ("inline" in owl.actor) owl.actor.inline.effects = [effect(ID(10), { key: "prone" })];
  state.tokens[OWL] = owl;
  state.templates[ID(11)] = template(ID(11), { label: "Bless" });
  state.drawings[ID(12)] = drawing(ID(12));
  return state;
}

/** The DM's steps of one twin up to the show, at clock times both twins share for every step a player gets. */
async function setUp(twin: Twin): Promise<void> {
  twin.to(1_500);
  await twin.dmApply(create(ORC, "Orc", true, 6));
  if (twin.kind === "earlier") {
    twin.to(2_000);
    await twin.dmApply(create(BAT, "Bat", true, 7));
  }
  twin.to(3_000);
  await twin.dmApply(create(WOLF, "Wolf", false, 5));
  if (twin.kind === "later") {
    twin.to(4_000);
    await twin.dmApply(create(BAT, "Bat", true, 7));
    twin.to(4_600);
    await twin.dmApply({ t: "token.delete", tokenId: ORC } as Op);
    twin.to(4_700);
    await twin.dmUndo();
  }
}

async function twins(t: TestContext): Promise<[Twin, Twin]> {
  const pair: [Twin, Twin] = [new Twin(t, "earlier", base()), new Twin(t, "later", asJsonb(base()))];
  for (const twin of pair) {
    await twin.load();
    twin.to(1_000);
    await twin.open("p1#1", { memberId: "p1" });
    await twin.open("display", { memberId: DISPLAY, display: true });
    await setUp(twin);
  }
  return pair;
}

const same = (pair: [Twin, Twin], what: string) => assert.deepEqual(pair[1].frames(), pair[0].frames(), `${what}: P1, P2 and the display are sent the same text in both rooms`);

describe("rooms apart in making order and a delete taken back send players the same text", () => {
  test("the rooms hold their creatures and fields in different orders", async (t) => {
    const pair = await twins(t);
    const order = pair.map((twin) => Object.keys(twin.actor.committed.state.tokens).join(" "));
    assert.equal(order[0], [OWL, ORC, BAT, WOLF].join(" "));
    assert.equal(order[1], [OWL, WOLF, BAT, ORC].join(" "));
    const fields = pair.map((twin) => Object.keys(twin.actor.committed.state.tokens[OWL]!).join(" "));
    assert.notEqual(fields[0], fields[1]);
  });

  test("a batch that shows two creatures, a join, a resync, a reconnect, a move and a restart", async (t) => {
    const pair = await twins(t);
    same(pair, "before the show");
    for (const twin of pair) {
      twin.to(6_000);
      await twin.dmApply({ t: "token.updateMany", tokenIds: [BAT, ORC], patch: { visibility: "all" } } as Op);
    }
    same(pair, "the show");
    for (const twin of pair) {
      twin.to(7_000);
      await twin.open("p2#1", { memberId: "p2" });
    }
    same(pair, "P2's first snapshot");
    for (const twin of pair) {
      twin.to(8_000);
      const p1 = twin.sockets.find((s) => s.label === "p1#1")!;
      const before = p1.texts.length;
      twin.actor.scene(p1.conn);
      await until(() => p1.texts.slice(before).find((m) => m.startsWith('{"t":"resync"')), "the resync");
      await twin.actor.hello(p1.conn, { clientId: uuidv7(), resumeFrom: 1 });
      await until(() => p1.texts.slice(before).find((m) => m.startsWith('{"t":"snapshot"')), "the snapshot after the resync");
      await twin.settle();
    }
    same(pair, "P1's resync");
    for (const twin of pair) {
      twin.to(9_000);
      await twin.open("p1#2", { memberId: "p1" });
    }
    same(pair, "P1's reconnect");
    for (const twin of pair) {
      twin.to(10_000);
      const p1 = twin.sockets.find((s) => s.label === "p1#2")!;
      const before = p1.texts.length;
      await twin.actor.op(p1.conn, 1, { t: "token.move", tokenId: OWL, x: 2, y: 1 });
      await until(() => p1.texts.slice(before).find((m) => m.startsWith('{"t":"history"')), "P1's history after the move");
      await twin.settle();
    }
    same(pair, "P1's move");
    for (const twin of pair) {
      twin.to(11_000);
      await twin.restart(twin.kind === "earlier");
      twin.to(12_000);
      await twin.open("p1#3", { memberId: "p1" });
      await twin.open("display#2", { memberId: DISPLAY, display: true });
    }
    same(pair, "a restart");
    const shown = JSON.parse(pair[0].sockets.find((s) => s.label === "p2#1")!.texts.find((m) => m.startsWith('{"t":"snapshot"'))!) as { state: RoomState };
    assert.deepEqual(Object.keys(shown.state.tokens), [WOLF, ORC, BAT, OWL], "P2's snapshot lists the creatures by id");
  });
});
