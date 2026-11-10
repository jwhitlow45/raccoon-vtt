import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import { lift } from "#shared/discoveryTestutil.ts";
import { keys } from "#shared/keys.ts";
import type { Member, PlayerChunk, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { FrameReader, T0 } from "#shared/seqTestutil.ts";
import type { RoomActor } from "./actor.ts";
import { restartStored, scopeObserver, ScopeClient, storedActor, StoredRoomDb } from "./undoScopeTesting.ts";

/**
 * A covered door on a scene with fog off (D-261110-530, docs/design/design-v1-maps-vision.md
 * 2.1), through the room actor: what P1's sockets and the table display get
 * as the DM turns fog off, edits beside the door, P1 reloads, the room
 * restarts from its snapshot, and the DM marks the door found.
 *
 * Three rooms from the secret door twins (shared/secretDoorTestutil.ts):
 * the door twin, a hidden door with an automatic cover between the corridor
 * and the passage; the twin of rock, the passage left unpainted; and the
 * doorway twin, the passage painted and open with no door. The DM has
 * revealed room R and the corridor by hand. While fog is on, the door twin
 * gives P1 and the display the twin of rock's frames. Once it is off they
 * hold the passage, and the door twin gives them the doorway twin's frames
 * with the automatic wall bit set on the door's edge, in a tile the door's
 * chunk carries anyway, so of the same length, with nothing that names the
 * door. Found, the door reaches them as the door the doorway twin's DM drew.
 */

const DISPLAY = "display:abcdefghijkl";
const DOOR = "16,5,w";
const DOOR_CHUNK = keys.chunk("s1", 1, 0);

/** Every room's clock stands at T0, so the frames that carry the time compare too. */
const CLOCK = { now: () => T0 };

type Watched = { label: string; sent: unknown[] };
type Mark = Map<unknown[], number>;

class Room {
  readonly db: StoredRoomDb;
  readonly watched: Watched[] = [];
  h!: Awaited<ReturnType<typeof storedActor>>;
  dm!: ScopeClient;
  p1!: ScopeClient;
  #pages = 0;

  constructor(state: RoomState) {
    this.db = new StoredRoomDb(state);
  }

  get actor(): RoomActor {
    return this.h.actor;
  }

  member(id: string): Member {
    return this.actor.committed.state.members[id]!;
  }

  async open(t: TestContext): Promise<void> {
    this.h = await storedActor(t, this.db, CLOCK);
    await this.connect();
  }

  async connect(): Promise<void> {
    this.dm = await ScopeClient.open(this.actor, this.member("dm1"), "dm");
    await this.openP1();
    const display = await scopeObserver(this.actor, { memberId: DISPLAY, role: "player", display: true });
    this.watched.push({ label: `display#${this.#pages}`, sent: display.sent });
  }

  async openP1(): Promise<void> {
    this.p1 = await ScopeClient.open(this.actor, this.member("p1"), "player");
    this.watched.push({ label: `p1#${++this.#pages}`, sent: this.p1.sent });
  }

  async reloadP1(): Promise<void> {
    this.actor.detach(this.p1.conn);
    await this.openP1();
    await this.settle();
  }

  async restart(t: TestContext): Promise<void> {
    this.h = await restartStored(t, this.h, { snapshot: true }, CLOCK);
    await this.connect();
    await this.settle();
  }

  async apply(op: Op): Promise<void> {
    await this.dm.apply(op);
    await this.settle();
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

  mark(): Mark {
    return new Map(this.watched.map((w) => [w.sent, w.sent.length]));
  }

  /** The frames P1's sockets and the display got since the mark, each socket opened since read whole. */
  since(mark: Mark): { label: string; frame: unknown }[] {
    return this.watched.flatMap((w) => w.sent.slice(mark.get(w.sent) ?? 0).map((frame) => ({ label: w.label, frame })));
  }

  /** P1's newest chunk at the door's position, as their device holds it. */
  doorChunk(): PlayerChunk | null {
    let chunk: PlayerChunk | null = null;
    for (const frame of this.p1.sent) {
      const f = frame as { t: string; state?: { buildChunks: Record<string, PlayerChunk> }; changes?: { key: string; value?: PlayerChunk | null }[] };
      if (f.t === "snapshot") chunk = f.state!.buildChunks["s1:1,0"] ?? null;
      for (const change of f.t === "ev" ? f.changes! : []) if (change.key === DOOR_CHUNK) chunk = change.value ?? null;
    }
    return chunk;
  }
}

/** The automatic wall bit of an edge in a player's chunk, bit 2k + 1 for cell k's west edge. */
function bitOf(edge: string): number {
  const [x, y] = edge.split(",").map(Number) as [number, number];
  return 2 * ((y % 16) * 16 + (x % 16)) + 1;
}

function autoAt(chunk: PlayerChunk | null, edge: string): boolean {
  if (!chunk?.auto) return false;
  const bit = bitOf(edge);
  return ((Buffer.from(chunk.auto, "base64")[bit >> 3]! >> (bit & 7)) & 1) === 1;
}

/** A frame with the door's automatic wall bit set in every copy of its chunk it carries, every key left where it stood. */
function withDoorBit(frame: unknown): unknown {
  const set = (chunk: PlayerChunk): PlayerChunk => {
    assert.ok(chunk.auto !== undefined, "the door's chunk carries automatic walls already");
    const bits = Buffer.from(chunk.auto, "base64");
    const bit = bitOf(DOOR);
    bits[bit >> 3] = bits[bit >> 3]! | (1 << (bit & 7));
    return { ...chunk, auto: bits.toString("base64") };
  };
  const f = frame as { t: string; state?: { buildChunks: Record<string, PlayerChunk> }; changes?: { key: string; value?: unknown }[] };
  if (f.t === "snapshot" && f.state!.buildChunks["s1:1,0"]) return { ...f, state: { ...f.state!, buildChunks: { ...f.state!.buildChunks, "s1:1,0": set(f.state!.buildChunks["s1:1,0"]) } } };
  if (f.t === "ev") return { ...f, changes: f.changes!.map((c) => (c.key === DOOR_CHUNK && c.value ? { ...c, value: set(c.value as PlayerChunk) } : c)) };
  return frame;
}

/**
 * The frames two rooms gave P1 and the display since their marks, compared
 * whole, every number and rev included, the second room's read through
 * `read`. With `named`, the first room's are scanned raw first for the
 * door's edge and every word of a door's own, and each pair of frames is
 * checked to be of one length.
 */
function compare(where: string, a: Room, aMark: Mark, b: Room, bMark: Mark, opts: { read?: (frame: unknown) => unknown; named?: boolean } = {}): number {
  const got = a.since(aMark);
  const want = b.since(bMark);
  if (opts.named) {
    for (const { label, frame } of got) {
      const raw = JSON.stringify(frame);
      for (const word of [DOOR, "secret", '"cover"', "discovered", '"door"']) assert.ok(!raw.includes(word), `${where}: ${label} got ${word}`);
    }
  }
  assert.equal(got.length, want.length, `${where}: as many frames`);
  const readA = new FrameReader();
  const readB = new FrameReader();
  for (const [i, { label, frame }] of got.entries()) {
    const other = want[i]!;
    assert.equal(label, other.label, `${where}: frame ${i} on the same socket`);
    if (opts.named) assert.equal(JSON.stringify(frame).length, JSON.stringify(other.frame).length, `${where}: ${label}'s frame ${i} of one length`);
    assert.equal(readA.text(frame), readB.text(opts.read ? opts.read(other.frame) : other.frame), `${where}: ${label}'s frame ${i}`);
  }
  return got.length;
}

function rooms(): { door: RoomState; rock: RoomState; doorway: RoomState } {
  const w = twins({ cover: "auto", explore: false });
  const doorway = structuredClone(w.door);
  const chunk = doorway.buildChunks["s1:1,0"]!;
  const { [DOOR]: _door, ...edges } = chunk.edges;
  doorway.buildChunks["s1:1,0"] = { ...chunk, edges };
  // Room R and the corridor revealed by hand, the doorway's near square among them.
  for (const s of [w.door, w.rock, doorway]) lift(s, "dm", { x: 0, y: 0, w: 16, h: 14 });
  return { door: w.door, rock: w.rock, doorway };
}

describe("a covered door with fog off, through the room actor (D-261110-530)", () => {
  test("P1 and the display get the twin of rock's frames with fog on, then the open doorway's with the wall bit on the door's edge, through edits, a reload and a restart, and the door once found", async (t) => {
    const states = rooms();
    const door = new Room(states.door);
    const rock = new Room(states.rock);
    const doorway = new Room(states.doorway);
    const start = new Map<Room, Mark>();
    for (const room of [door, rock, doorway]) {
      start.set(room, new Map());
      await room.open(t);
      await room.settle();
    }
    assert.ok(compare("fog on", door, start.get(door)!, rock, start.get(rock)!, { named: true }) > 0);
    assert.ok(autoAt(door.doorChunk(), DOOR), "fog on: the door is an automatic wall bit beside the corridor");

    const off = new Map([door, doorway].map((room) => [room, room.mark()]));
    for (const room of [door, rock, doorway]) await room.apply({ t: "scene.update", sceneId: "s1", patch: { fogEnabled: false } });
    let compared = compare("fog off", door, off.get(door)!, doorway, off.get(doorway)!, { read: withDoorBit, named: true });
    const held = door.doorChunk();
    assert.ok(held?.cells["16,5"] && autoAt(held, DOOR) && held.edges[DOOR] === undefined, "fog off: the passage held, the door an automatic wall bit between its squares");

    // Beside the door: a square painted in the door's chunk and a wall drawn on its edge, then the edits taken back.
    for (const room of [door, doorway]) {
      await room.apply({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["17,4"] });
      await room.apply({ t: "build.edge", sceneId: "s1", edges: [{ key: "17,4,n", feature: { kind: "wall" } }] });
      await room.apply({ t: "build.erase", sceneId: "s1", cells: ["17,4"] });
      await room.reloadP1();
      await room.restart(t);
    }
    compared += compare("edits, a reload and a restart", door, off.get(door)!, doorway, off.get(doorway)!, { read: withDoorBit, named: true });
    assert.ok(compared >= 12, `${compared} frames compared with fog off`);

    const found = new Map([door, doorway].map((room) => [room, room.mark()]));
    await door.apply({ t: "door.set", sceneId: "s1", door: { edge: DOOR }, state: "closed", found: true });
    await doorway.apply({ t: "build.edge", sceneId: "s1", edges: [{ key: DOOR, feature: { kind: "door", state: "closed", secret: true, discovered: true } }] });
    assert.ok(compare("found", door, found.get(door)!, doorway, found.get(doorway)!) > 0);
    const shown = door.doorChunk();
    assert.deepEqual(shown?.edges[DOOR], { kind: "door", state: "closed", secret: true, discovered: true }, "found: the door as the door it is");
    assert.ok(!autoAt(shown, DOOR), "found: no wall bit under it");
  });
});
