// The server's request and reply types, which its cookie plugin adds, for the room's own files this test loads.
import type {} from "@fastify/cookie";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test, type TestContext } from "node:test";
import { idKeyFromText, sealedTime, uuidv7, type IdKey } from "#shared/ids.ts";
import type { ClientMessage, ServerMessage } from "#shared/protocol.ts";
import { rng } from "#shared/testutil.ts";
import { DEVELOPMENT_ROOM_SECRET_KEY } from "../../server/config.ts";
import type { ActorOptions } from "../../server/rooms/actor.ts";
import { Connection } from "../../server/rooms/connection.ts";
import { IdTable } from "../../server/rooms/limitsTwinTesting.ts";
import { inF, make, move, numberingRoom, Room, T0 } from "../../server/rooms/numberingTesting.ts";
import { STANDING_CLOCK } from "../../server/rooms/undoScopeTesting.ts";
import { createRoomStore, IDS_AGAIN_MS, type RoomStore } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";

/**
 * C17 through a page's own store and a room's actor: a DM's create made
 * before a change of ROOM_SECRET_KEY lands once after it, whether it was
 * still queued, written to a socket the room never read, or committed with
 * its answer lost (docs/design/design-v1-player-limits.md 3.4). The page
 * keeps its store across the room's restart, as a page does across a
 * deploy, and asks the room what it took as it reconnects.
 */

const MINUTE = 60_000;
type Case = "queued" | "written" | "unanswered";

/** A DM's page: its store, its clock, the frames it writes, and the room's frames it takes. */
class Page {
  readonly clock = new FakeClock();
  readonly outbox = new FakeOutbox();
  readonly store: RoomStore;
  conn: Connection | null = null;
  /** Frames from the room are dropped, as when the socket breaks before they arrive. */
  deaf = false;
  /** The refusals the page heard. */
  readonly refused: string[] = [];
  #snapshots = 0;
  readonly room: Room;

  constructor(room: Room) {
    this.room = room;
    this.store = createRoomStore({ roomId: "UNDOSCOPE", you: { memberId: "dm1", role: "dm" }, clock: this.clock, random: () => 0.5, clientId: "page-1" });
    this.store.setOutbox(this.outbox);
    this.outbox.open = false;
  }

  #keyText: string | undefined;

  /** The key the newest snapshot brought. */
  key(): IdKey {
    const key = this.#keyText === undefined ? null : idKeyFromText(this.#keyText);
    assert.ok(key, "the page holds a key");
    return key;
  }

  /** Opens a socket to the room's actor as a page of this build does, takes its snapshot, and sends what the page has queued. */
  async open(): Promise<void> {
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => this.#hear(JSON.parse(text) as ServerMessage), close() {}, terminate() {} };
    this.conn = new Connection(socket as never, { sessionId: "session-1", roomId: "UNDOSCOPE", memberId: "dm1", role: "dm" }, "203.0.113.20", { now: () => this.room.clock.now });
    this.room.actor.attach(this.conn);
    this.deaf = false;
    this.outbox.open = true;
    const seen = this.#snapshots;
    await this.room.actor.hello(this.conn, { ...this.store.prepareHello(), ackDetails: true, sealIds: true });
    await this.room.settle();
    assert.ok(this.#snapshots > seen, "a snapshot");
    await this.pump();
  }

  /** The socket breaks. */
  drop(): void {
    if (this.conn) this.room.actor.detach(this.conn);
    this.conn = null;
    this.outbox.open = false;
    this.store.setConnection("reconnecting");
  }

  /** Writes the page's frames to the room, as many rounds as its answers bring, a pending ids question asked again on its timer. */
  async pump(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      const frames = this.outbox.sent.splice(0);
      if (frames.length === 0) {
        if (this.store.store.getState().idsSettling === 0 || !this.conn) return;
        this.tick(IDS_AGAIN_MS);
        continue;
      }
      for (const frame of frames) await this.#write(frame);
      await this.room.settle();
    }
    assert.fail("the page and the room never settled");
  }

  /** Both clocks move on together. */
  tick(ms: number): void {
    this.room.clock.now += ms;
    this.clock.advance(ms);
  }

  async #write(frame: ClientMessage): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    if (frame.t === "op") await this.room.actor.op(conn, frame.n, frame.op, frame.g, frame.groupScope);
    else if (frame.t === "ids") this.room.actor.ids(conn, frame);
    else if (frame.t === "time") this.#hear({ t: "time", k: frame.k, at: this.room.actor.serverTime() } as ServerMessage);
  }

  #hear(msg: ServerMessage): void {
    if (this.deaf) return;
    const s = this.store;
    switch (msg.t) {
      case "clock":
        s.receiveClock(msg.at);
        return;
      case "snapshot":
        this.#snapshots++;
        this.#keyText = msg.you.idKey;
        s.setConnection("open");
        s.applySnapshot(msg);
        return;
      case "ev":
        for (const r of msg.rejects ?? []) this.refused.push(`${r.code}: ${r.message ?? ""}`);
        s.applyEv(msg);
        return;
      case "refusals":
        s.keepRefusals(msg.rejects);
        return;
      case "ids":
        s.receiveIds(msg);
        return;
      case "retry":
        if (msg.n !== undefined) s.retryOps(msg.n);
        return;
      default:
        if ((msg as { t: string }).t === "history") s.applyHistory(msg as never);
        else if ((msg as { t: string }).t === "time") s.receiveTime((msg as unknown as { at: number }).at);
    }
  }
}

async function openRoom(t: TestContext): Promise<{ room: Room; opts: Partial<ActorOptions>; page: Page }> {
  // One options object, so a key change reaches the room's next load.
  const opts: Partial<ActorOptions> = { idGate: true, numberClock: STANDING_CLOCK, idSecret: DEVELOPMENT_ROOM_SECRET_KEY };
  const room = new Room(t, "A", numberingRoom(), opts);
  const table = new IdTable().attach(room);
  table.since = T0 - 120 * MINUTE;
  await room.load();
  const page = new Page(room);
  page.clock.t = T0;
  await page.open();
  return { room, opts, page };
}

/** The room restarts with a new ROOM_SECRET_KEY, as a deploy that changed it does, and the page reconnects. */
async function newSecret(room: Room, opts: Partial<ActorOptions>, page: Page): Promise<void> {
  page.drop();
  opts.idSecret = randomBytes(32);
  await room.restart(false);
  page.tick(5_000);
  await page.open();
}

/** The DM's create of `label`, made by the page as it is, then left `as` the case says before the key changes. */
async function createAcross(room: Room, opts: Partial<ActorOptions>, page: Page, label: string, as: Case, at = inF(1, 1)): Promise<{ made: string; told: Map<string, string>[] }> {
  const told: Map<string, string>[] = [];
  if (as === "queued") page.drop();
  const made = page.store.newId();
  page.store.dispatch(make(made, at, { name: label }) as never, { onRemint: (ids) => told.push(new Map(ids)) });
  if (as === "written") page.outbox.sent.splice(0);
  if (as === "unanswered") {
    page.deaf = true;
    await page.pump();
  }
  await newSecret(room, opts, page);
  return { made, told };
}

function named(room: Room, label: string): string[] {
  return Object.values(room.state.tokens).filter((tok) => tok.name === label).map((tok) => tok.id);
}

describe("C17 through a page's store and the room's actor", () => {
  for (const as of ["queued", "written", "unanswered"] as const) {
    test(`a create ${as} before a change of ROOM_SECRET_KEY lands once after it`, async (t) => {
      const { room, opts, page } = await openRoom(t);
      const before = page.key();
      const { made, told } = await createAcross(room, opts, page, "Goblin 1", as);
      const ids = named(room, "Goblin 1");
      assert.equal(ids.length, 1, "one Goblin");
      assert.deepEqual(page.store.store.getState().pending, [], "nothing left to send");
      if (as === "unanswered") {
        assert.deepEqual(ids, [made], "the room took it before the change, under the id it was made under");
        assert.deepEqual(told, []);
      } else {
        assert.notEqual(ids[0], made);
        assert.equal(sealedTime(before, ids[0]!), null, "not under the old key");
        assert.notEqual(sealedTime(page.key(), ids[0]!), null, "made again under the new key");
        assert.deepEqual(told, [new Map([[made, ids[0]!]])], "its sender is told");
      }
      assert.ok(page.store.store.getState().view?.tokens[ids[0]!], "the page holds it");
      assert.deepEqual(page.refused, [], "made again before it went, so never refused");
    });
  }

  test("seeded runs: creates and their moves, queued, written or unanswered across key changes and restarts, each land once", async (t) => {
    let landed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = rng(seed);
      const { room, opts, page } = await openRoom(t);
      const labels: string[] = [];
      for (let step = 0; step < 10; step++) {
        const roll = r();
        const label = `Goblin ${seed}.${step}`;
        if (roll < 0.45) {
          const as = (["queued", "written", "unanswered"] as const)[Math.floor(r() * 3)]!;
          await createAcross(room, opts, page, label, as, inF(Math.floor(r() * 4), Math.floor(r() * 3)));
          labels.push(label);
        } else if (roll < 0.7) {
          // A create and a move of it in one batch, the create's id a version 7 one made before the page held a key, as
          // a page's first ids are, after a restart that changed the key or kept it.
          page.drop();
          const made = uuidv7(room.clock.now);
          if (r() < 0.5) opts.idSecret = randomBytes(32);
          await room.restart(r() < 0.5);
          page.tick(5_000);
          await page.open();
          page.store.dispatchMany([{ op: make(made, inF(0, 0), { name: label }) as never }, { op: move(made, inF(2, 2)) as never }]);
          await page.pump();
          labels.push(label);
          const [id] = named(room, label);
          assert.deepEqual(room.state.tokens[id!] && { x: room.state.tokens[id!]!.x, y: room.state.tokens[id!]!.y }, inF(2, 2), `seed ${seed} step ${step}: the move found its create`);
        } else if (roll < 0.85) {
          page.store.dispatch(make(page.store.newId(), inF(3, 2), { name: label }) as never);
          await page.pump();
          labels.push(label);
        } else {
          page.drop();
          await room.restart(r() < 0.5);
          page.tick(MINUTE);
          await page.open();
        }
        page.tick(Math.floor(r() * 3) * MINUTE);
      }
      for (const label of labels) assert.equal(named(room, label).length, 1, `seed ${seed}: ${label} landed once`);
      assert.deepEqual(page.store.store.getState().pending, [], `seed ${seed}: nothing left to send`);
      assert.deepEqual(page.refused, [], `seed ${seed}: nothing refused`);
      landed += labels.length;
    }
    assert.ok(landed > 30, `${landed} creates`);
  });
});

