import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import { lift } from "#shared/discoveryTestutil.ts";
import { keys } from "#shared/keys.ts";
import type { Member, PlayerChunk, RoomState } from "#shared/model.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op } from "#shared/protocol.ts";
import { TWIN_H, TWIN_W, twins, withoutRevs } from "#shared/secretDoorTestutil.ts";
import { FrameReader, T0 } from "#shared/seqTestutil.ts";
import type { RoomActor } from "./actor.ts";
import type { Connection } from "./connection.ts";
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
 * So it goes as the automatic walls rule changes, the bounds cut the door's
 * chunk off and come back, and the players move to another scene and back,
 * and after each of those P1's copy and the display's, as their frames
 * built them, equal what a device opening then gets.
 */

const DISPLAY = "display:abcdefghijkl";
const DOOR = "16,5,w";
const DOOR_CHUNK = keys.chunk("s1", 1, 0);
/** The door's edge and every word of a door's own. */
const DOOR_WORDS = [DOOR, "secret", '"cover"', "discovered", '"door"'];

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
  display!: { conn: Connection; sent: unknown[] };
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
    this.display = await scopeObserver(this.actor, { memberId: DISPLAY, role: "player", display: true });
    this.watched.push({ label: `display#${this.#pages}`, sent: this.display.sent });
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

  /** What a P1 device and a table display opening now get, as their frames build it, each socket closed after. */
  async opened(): Promise<{ p1: ProjectedState | null; display: ProjectedState | null }> {
    const p1 = await ScopeClient.open(this.actor, this.member("p1"), "player");
    const display = await scopeObserver(this.actor, { memberId: DISPLAY, role: "player", display: true });
    for (const conn of [p1.conn, display.conn]) this.actor.detach(conn);
    await this.settle();
    return { p1: built(p1.sent), display: built(display.sent) };
  }

  /** P1's copy and the display's, as their frames built them, each equal to what a device opening now gets. */
  async fresh(where: string): Promise<void> {
    const now = await this.opened();
    assert.equal(stableStringify(built(this.p1.sent)), stableStringify(now.p1), `${where}: P1's copy is a fresh snapshot`);
    assert.equal(stableStringify(built(this.display.sent)), stableStringify(now.display), `${where}: the display's copy is a fresh snapshot`);
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

/** A device's copy as its frames built it: each snapshot taken whole, each event's changes applied in turn. */
function built(sent: readonly unknown[]): ProjectedState | null {
  let view: ProjectedState | null = null;
  for (const frame of sent) {
    const f = frame as { t: string; state?: ProjectedState; changes?: Change[] };
    if (f.t === "snapshot") view = f.state!;
    else if (f.t === "ev" && view) view = applyChanges(view, f.changes!);
  }
  return view;
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
  return atDoorChunk(frame, (chunk) => {
    assert.ok(chunk.auto !== undefined, "the door's chunk carries automatic walls already");
    const bits = Buffer.from(chunk.auto, "base64");
    const bit = bitOf(DOOR);
    bits[bit >> 3] = bits[bit >> 3]! | (1 << (bit & 7));
    return { ...chunk, auto: bits.toString("base64") };
  });
}

/** A frame with a drawn wall on the door's edge in every copy of its chunk it carries, as the stored build shows a covered door under the rule "off". */
function withDoorWall(frame: unknown): unknown {
  return atDoorChunk(frame, (chunk) => ({ ...chunk, edges: { ...chunk.edges, [DOOR]: { kind: "wall" } } }));
}

/** A frame with `set` applied to every copy of the door's chunk it carries. */
function atDoorChunk(frame: unknown, set: (chunk: PlayerChunk) => PlayerChunk): unknown {
  const f = frame as { t: string; state?: { buildChunks: Record<string, PlayerChunk> }; changes?: { key: string; value?: unknown }[] };
  if (f.t === "snapshot" && f.state!.buildChunks["s1:1,0"]) return { ...f, state: { ...f.state!, buildChunks: { ...f.state!.buildChunks, "s1:1,0": set(f.state!.buildChunks["s1:1,0"]) } } };
  if (f.t === "ev") return { ...f, changes: f.changes!.map((c) => (c.key === DOOR_CHUNK && c.value ? { ...c, value: set(c.value as PlayerChunk) } : c)) };
  return frame;
}

/**
 * The frames two rooms gave P1 and the display since their marks, compared
 * whole, every number and rev included, the second room's read through
 * `read`. With `named`, the first room's are scanned raw first for those
 * words, and each is checked to be of the length the second room's gives
 * as read.
 */
function compare(where: string, a: Room, aMark: Mark, b: Room, bMark: Mark, opts: { read?: (frame: unknown) => unknown; named?: readonly string[] } = {}): number {
  const got = a.since(aMark);
  const want = b.since(bMark);
  if (opts.named) {
    for (const { label, frame } of got) {
      const raw = JSON.stringify(frame);
      for (const word of opts.named) assert.ok(!raw.includes(word), `${where}: ${label} got ${word}`);
    }
  }
  assert.equal(got.length, want.length, `${where}: as many frames`);
  const readA = new FrameReader();
  const readB = new FrameReader();
  for (const [i, { label, frame }] of got.entries()) {
    const other = want[i]!;
    const expected = opts.read ? opts.read(other.frame) : other.frame;
    assert.equal(label, other.label, `${where}: frame ${i} on the same socket`);
    if (opts.named) assert.equal(JSON.stringify(frame).length, JSON.stringify(expected).length, `${where}: ${label}'s frame ${i} of one length`);
    assert.equal(readA.text(frame), readB.text(expected), `${where}: ${label}'s frame ${i}`);
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
    assert.ok(compare("fog on", door, start.get(door)!, rock, start.get(rock)!, { named: DOOR_WORDS }) > 0);
    assert.ok(autoAt(door.doorChunk(), DOOR), "fog on: the door is an automatic wall bit beside the corridor");

    const off = new Map([door, doorway].map((room) => [room, room.mark()]));
    for (const room of [door, rock, doorway]) await room.apply({ t: "scene.update", sceneId: "s1", patch: { fogEnabled: false } });
    let compared = compare("fog off", door, off.get(door)!, doorway, off.get(doorway)!, { read: withDoorBit, named: DOOR_WORDS });
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
    compared += compare("edits, a reload and a restart", door, off.get(door)!, doorway, off.get(doorway)!, { read: withDoorBit, named: DOOR_WORDS });
    assert.ok(compared >= 12, `${compared} frames compared with fog off`);

    const found = new Map([door, doorway].map((room) => [room, room.mark()]));
    await door.apply({ t: "door.set", sceneId: "s1", door: { edge: DOOR }, state: "closed", found: true });
    await doorway.apply({ t: "build.edge", sceneId: "s1", edges: [{ key: DOOR, feature: { kind: "door", state: "closed", secret: true, discovered: true } }] });
    assert.ok(compare("found", door, found.get(door)!, doorway, found.get(doorway)!) > 0);
    const shown = door.doorChunk();
    assert.deepEqual(shown?.edges[DOOR], { kind: "door", state: "closed", secret: true, discovered: true }, "found: the door as the door it is");
    assert.ok(!autoAt(shown, DOOR), "found: no wall bit under it");
  });

  test("with fog off, the door twin gives P1 and the display the open doorway's frames with the wall bit, and their copies equal a fresh snapshot, as the rule changes, the bounds cut the door's chunk and come back, and the players move away and back", async (t) => {
    const states = rooms();
    for (const s of [states.door, states.rock, states.doorway]) s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
    const door = new Room(states.door);
    const rock = new Room(states.rock);
    const doorway = new Room(states.doorway);
    for (const room of [door, rock, doorway]) {
      await room.open(t);
      await room.settle();
    }
    await door.fresh("fog off");
    // Under the rule "off" the copies are the stored build, where the covered door shows as a drawn wall would, edge key and all.
    const held = { read: withDoorBit, named: DOOR_WORDS };
    const stored = { read: withDoorWall, named: DOOR_WORDS.filter((word) => word !== DOOR) };
    // With the east bound on the door's edge the door's chunk is a stub one past it, which carries the door's wall bit as
    // the twin of rock's carries the wall where its corridor ends, and which the open doorway, with no wall to carry, goes
    // without. So there a device opening gets the twin of rock's copy from the door twin, and each bound after it starts
    // from the whole scene, where the twins' copies differ by the bit alone.
    const steps: { where: string; op: Op; as: typeof held | "rock" }[] = [
      { where: "the rule at floor", op: { t: "scene.update", sceneId: "s1", patch: { autoWalls: "floor" } }, as: held },
      { where: "the rule off", op: { t: "scene.update", sceneId: "s1", patch: { autoWalls: "off" } }, as: stored },
      { where: "the rule back at all", op: { t: "scene.update", sceneId: "s1", patch: { autoWalls: "all" } }, as: held },
      { where: "the bounds cut past the door", op: { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 17, h: TWIN_H } } }, as: held },
      { where: "the bounds on the door's edge", op: { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 16, h: TWIN_H } } }, as: "rock" },
      { where: "the bounds back from the door's edge", op: { t: "scene.update", sceneId: "s1", patch: { bounds: { w: TWIN_W, h: TWIN_H } } }, as: held },
      { where: "the bounds short of the door's chunk", op: { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 14, h: TWIN_H } } }, as: held },
      { where: "the bounds back", op: { t: "scene.update", sceneId: "s1", patch: { bounds: { w: TWIN_W, h: TWIN_H } } }, as: held },
      { where: "the players on another scene", op: { t: "room.setPlayerScene", sceneId: "s2" }, as: held },
      { where: "the players back", op: { t: "room.setPlayerScene", sceneId: "s1" }, as: held },
    ];
    let compared = 0;
    for (const { where, op, as } of steps) {
      const marks = new Map([door, rock, doorway].map((room) => [room, room.mark()]));
      for (const room of [door, rock, doorway]) await room.apply(op);
      if (as === "rock") {
        for (const { label, frame } of door.since(marks.get(door)!)) {
          const raw = JSON.stringify(frame);
          for (const word of DOOR_WORDS) assert.ok(!raw.includes(word), `${where}: ${label} got ${word}`);
        }
        const [a, b] = [await door.opened(), await rock.opened()];
        assert.equal(stableStringify(withoutRevs(a)), stableStringify(withoutRevs(b)), `${where}: a device opening gets the twin of rock's copy`);
      } else {
        // A step that changes nothing players hold, as floor after all does on these squares, sends them no frame.
        compared += compare(where, door, marks.get(door)!, doorway, marks.get(doorway)!, as);
      }
      for (const room of [door, rock, doorway]) await room.fresh(where);
    }
    assert.ok(compared >= 12, `${compared} frames compared`);
  });
});
