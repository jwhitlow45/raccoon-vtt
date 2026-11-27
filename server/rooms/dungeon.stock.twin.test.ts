import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { applyChanges } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { FrameReader, T0 } from "#shared/seqTestutil.ts";
import { room } from "#shared/testutil.ts";
import { scopeActor, scopeObserver, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * A stocked dungeon's creatures, as players get them (docs/design/design-v1-dungeon-stock.md
 * 3, D-261127-058 and 074): every creature lands hidden, so P1's device and
 * the table display get exactly the frames they would get with no creature
 * at all. Twin A lands the stocked fixture dungeon (client/features/dungeon
 * ops.fixture.test.ts "stocked") through the room actor in one Setup group,
 * and twin B the same ops without the creatures, the key page kept, so the
 * twins differ in the hidden creatures alone. In B each creature's
 * `token.create` is a hidden token on the DM's other scene instead: the room
 * count every device reads counts each op, hidden or not, a residual every
 * DM-only op shares (a hidden trap, a DM pin), so B takes as many ops to
 * keep the counts alike, and its stand-ins stand where no player looks.
 * Both take the
 * same steps at the same clock times, and after each the frames P1 and the
 * display got are compared whole and scanned raw for a creature's id, SRD id
 * or name.
 *
 * Cases: the players on another scene while it lands (1), moved there on
 * Explore with the party in the entrance (2), a PC walking into a stocked
 * room (3), that room revealed by hand (4), a reload while it shows (5), and
 * Undo setup then Redo setup with the players on another scene (6). The
 * control: the DM shows one creature in A, and P1 gets it. The flip
 * (`DSTOCK_TWIN_FLIP=1`, or the flip test below) writes A's creatures for
 * everyone before they land: cases 3 to 5 must then tell the twins apart,
 * and case 2 stays equal, since fog withholds a token outside sight.
 */

type Rect = { x: number; y: number; w: number; h: number };
type Stocked = { name: string; sceneId: string; ops: Op[]; rooms: Rect[]; entrance: Rect; monsters: { srdId: string; x: number; y: number; room: number }[] };
const FIXTURE = JSON.parse(readFileSync(new URL("./dungeon.fixture.json", import.meta.url), "utf8")) as { dungeons: Stocked[] };
const STOCKED = FIXTURE.dungeons.find((d) => d.name === "stocked")!;
const SCENE = STOCKED.sceneId;
const DISPLAY = "display:abcdefghijkl";
const PC = "dstock-pc";
/** The scene no player is moved to in these runs, where twin B's stand-ins stand. */
const OTHER = "s2";

const isCreature = (op: Op): boolean => op.t === "token.create" && op.token.kind === "monster";
const CREATURES = STOCKED.ops.filter(isCreature) as Extract<Op, { t: "token.create" }>[];
/** What no frame to P1 or the display may name: each creature's id, SRD id and name, each quoted as JSON writes it. */
const NEEDLES = [...new Set(CREATURES.flatMap((op) => [op.token.id, op.token.name, "inline" in op.token.actor ? (op.token.actor.inline.srdId ?? "") : ""]))].filter((s) => s !== "").map((s) => JSON.stringify(s));

/** The room with the most creatures, the one the PC walks into, and a square of it no creature stands on. */
const STOCKED_ROOM = (() => {
  const counts = new Map<number, number>();
  for (const m of STOCKED.monsters) counts.set(m.room, (counts.get(m.room) ?? 0) + 1);
  const at = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const r = STOCKED.rooms[at]!;
  const taken = new Set(STOCKED.monsters.filter((m) => m.room === at).map((m) => `${Math.floor(m.x)},${Math.floor(m.y)}`));
  let spot: { x: number; y: number } | null = null;
  for (let y = r.y; y < r.y + r.h && !spot; y++) for (let x = r.x; x < r.x + r.w && !spot; x++) if (!taken.has(`${x},${y}`)) spot = { x, y };
  return { at, rect: r, spot: spot!, ids: CREATURES.filter((op) => STOCKED.monsters[CREATURES.indexOf(op)]?.room === at).map((op) => op.token.id) };
})();

type Mode = "explore" | "reveal";

/** The fixture's ops on Explore with party vision on, or Reveal by hand, and with the flip A's creatures for everyone. */
function opsFor(mode: Mode, twin: "a" | "b", flip: boolean): Op[] {
  return STOCKED.ops.flatMap((op): Op[] => {
    if (op.t === "scene.create") {
      const { vision: _v, ...scene } = op.scene;
      return [{ t: "scene.create", scene: { ...scene, fogEnabled: true, ...(mode === "explore" ? { vision: { on: true, light: "bright" as const } } : {}) } }];
    }
    if (isCreature(op) && op.t === "token.create") {
      if (twin === "b") return [{ t: "token.create", token: { id: `${op.token.id}-standin`, sceneId: OTHER, kind: "object", name: "Stand-in", size: "medium", x: 1, y: 1, visibility: "dm", actor: op.token.actor } } as Op];
      return [flip ? { ...op, token: { ...op.token, visibility: "all" as const } } : op];
    }
    return [op];
  });
}

type Watched = { label: string; sent: unknown[] };

class Twin {
  readonly name: "a" | "b";
  readonly clock = { now: T0 };
  readonly watched: Watched[] = [];
  h!: Awaited<ReturnType<typeof scopeActor>>;
  dm!: ScopeClient;
  p1!: ScopeClient;
  #pages = 0;

  constructor(name: "a" | "b") {
    this.name = name;
  }

  async open(t: TestContext): Promise<void> {
    const state: RoomState = room();
    this.h = await scopeActor(t, state, { now: () => this.clock.now, idGate: false });
    const members = this.h.actor.committed.state.members;
    this.dm = await this.h.connect(members.dm1!);
    this.p1 = await this.h.connect(members.p1!);
    this.watched.push({ label: `p1#${++this.#pages}`, sent: this.p1.sent });
    const display = await scopeObserver(this.h.actor, { memberId: DISPLAY, role: "player", display: true });
    this.watched.push({ label: "display", sent: display.sent });
  }

  async settle(): Promise<void> {
    let quiet = 0;
    while (quiet < 3) {
      quiet = this.h.actor.queueLength === 0 ? quiet + 1 : 0;
      await delay(3);
    }
  }

  async dmOp(op: Op, group?: string): Promise<void> {
    this.clock.now += 1_000;
    const ev = await this.dm.send(op, group, group ? "setup" : undefined);
    assert.equal(ev.rejects?.find((r) => r.n === this.dm.n), undefined, `${this.name}: the DM's ${op.t} taken`);
    await this.settle();
  }

  async restore(scope: "setup" | "play", direction: "undo" | "redo"): Promise<void> {
    this.clock.now += 1_000;
    await this.dm.restore(scope, direction);
    await this.settle();
  }

  async reloadP1(): Promise<void> {
    this.clock.now += 1_000;
    this.h.actor.detach(this.p1.conn);
    this.p1 = await this.h.connect(this.h.actor.committed.state.members.p1!);
    this.watched.push({ label: `p1#${++this.#pages}`, sent: this.p1.sent });
    await this.settle();
  }

  raw(): unknown[] {
    return this.watched.flatMap((w) => w.sent);
  }

  /** Every frame P1 and the display got, each a line, read by one reader over the sockets in order. */
  frames(): string[] {
    const reader = new FrameReader();
    return this.watched.flatMap((w) => w.sent.map((f) => `${w.label} ${reader.text(f)}`));
  }

  /** P1's view as its newest page built it from its frames. */
  view(): ProjectedState | null {
    let view: ProjectedState | null = null;
    for (const msg of this.p1.sent as ServerMessage[]) {
      if (msg.t === "snapshot") view = msg.state as ProjectedState;
      else if (msg.t === "ev" && view) view = applyChanges(view, msg.changes as Change[]);
    }
    return view;
  }
}

type Pair = [Twin, Twin];

async function both(pair: Pair, step: (twin: Twin) => Promise<void>): Promise<void> {
  for (const twin of pair) await step(twin);
}

/** Whether a scene's cell is in P1's view: on a chunk P1 holds, the room's floor P1 has seen. */
function seesCell(view: ProjectedState | null, x: number, y: number): boolean {
  return Object.values(view?.buildChunks ?? {}).some((c) => c.sceneId === SCENE && Object.hasOwn(c.cells, `${x},${y}`));
}

/** Each case's outcome: whether the twins' frames matched, and why not. */
type Outcome = { same: boolean; why: string };

function compare(pair: Pair): Outcome {
  const leaks = pair[0].raw().flatMap((f) => {
    const text = JSON.stringify(f);
    return NEEDLES.filter((n) => text.includes(n));
  });
  if (leaks.length > 0) return { same: false, why: `A's frames name ${[...new Set(leaks)].join(", ")}` };
  const [a, b] = pair.map((t) => t.frames()) as [string[], string[]];
  if (a.length !== b.length) return { same: false, why: `${a.length} frames in A, ${b.length} in B` };
  const at = a.findIndex((line, i) => line !== b[i]);
  return at < 0 ? { same: true, why: "" } : { same: false, why: `frame ${at} differs: ${a[at]!.slice(0, 200)}` };
}

const pcToken = (at: { x: number; y: number }) =>
  ({
    t: "token.create",
    token: {
      id: PC,
      sceneId: SCENE,
      kind: "pc",
      name: "Ayla",
      disposition: "ally",
      size: "medium",
      ownerIds: ["p1"],
      ...at,
      actor: { inline: { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } },
    },
  }) as Op;

/**
 * One run of the cases in order, each case's outcome recorded. Explore runs
 * cases 1, 2, 3, 5 and 6, and Reveal by hand 1, 4, 5 and 6, case 5 the
 * reload while the stocked room shows. Each case also checks it compared
 * what it claims: the frames grew, and the stocked room is in P1's view
 * where the case shows it.
 */
async function run(t: TestContext, mode: Mode, flip: boolean, control = false): Promise<Map<number, Outcome>> {
  clearVisionCache();
  const pair: Pair = [new Twin("a"), new Twin("b")];
  for (const twin of pair) await twin.open(t);
  const out = new Map<number, Outcome>();
  const counted = pair[0].frames().length;
  const record = (n: number, grew: number) => {
    const now = pair[0].frames().length;
    assert.ok(now > grew, `${mode}, case ${n}: frames were compared (${now} after ${grew})`);
    out.set(n, compare(pair));
    return now;
  };
  // 1. The players on another scene while the dungeon lands in one Setup group.
  const group = "dstock-group";
  await both(pair, async (twin) => {
    for (const op of opsFor(mode, twin.name, flip && twin.name === "a")) await twin.dmOp(op, group);
  });
  await both(pair, (twin) => twin.dmOp({ t: "log.chat", text: "landed" }));
  let seen = record(1, counted);
  const e = STOCKED.entrance;
  if (mode === "explore") {
    // 2. Moved there on Explore, the party in the entrance, which sees no other room.
    await both(pair, async (twin) => {
      await twin.dmOp(pcToken({ x: e.x + Math.floor(e.w / 2), y: e.y + Math.floor(e.h / 2) }));
      await twin.dmOp({ t: "room.setPlayerScene", sceneId: SCENE });
      await twin.dmOp({ t: "token.move", tokenId: PC, x: e.x, y: e.y });
    });
    assert.ok(seesCell(pair[0].view(), e.x, e.y), "case 2: P1 sees the entrance");
    assert.ok(!seesCell(pair[0].view(), STOCKED_ROOM.spot.x, STOCKED_ROOM.spot.y), "case 2: the stocked room is out of sight");
    seen = record(2, seen);
    // 3. The PC walks into the stocked room, its creatures in sight.
    await both(pair, (twin) => twin.dmOp({ t: "token.move", tokenId: PC, ...STOCKED_ROOM.spot }));
    assert.ok(seesCell(pair[0].view(), STOCKED_ROOM.spot.x, STOCKED_ROOM.spot.y), "case 3: P1 sees the stocked room");
    for (const id of STOCKED_ROOM.ids) {
      const m = STOCKED.monsters[CREATURES.findIndex((op) => op.token.id === id)]!;
      assert.ok(seesCell(pair[0].view(), Math.floor(m.x), Math.floor(m.y)), `case 3: the square under ${id} is in sight`);
    }
    seen = record(3, seen);
  } else {
    // 4. The stocked room revealed by hand, the players moved there.
    const r = STOCKED_ROOM.rect;
    await both(pair, async (twin) => {
      await twin.dmOp({ t: "room.setPlayerScene", sceneId: SCENE });
      await twin.dmOp({ t: "fog.live", sceneId: SCENE, ops: [{ id: "dstock-reveal", mode: "reveal", shape: { kind: "rect", x: r.x, y: r.y, w: r.w, h: r.h } }] });
    });
    assert.ok(seesCell(pair[0].view(), STOCKED_ROOM.spot.x, STOCKED_ROOM.spot.y), "case 4: P1 sees the revealed room");
    seen = record(4, seen);
  }
  // 5. A reload while the stocked room shows.
  await both(pair, (twin) => twin.reloadP1());
  assert.ok(seesCell(pair[0].view(), STOCKED_ROOM.spot.x, STOCKED_ROOM.spot.y), "case 5: the reloaded page holds the stocked room");
  seen = record(5, seen);
  if (control) {
    // The control: shown, a creature reaches P1, so the comparison sees what hiding withholds.
    const id = STOCKED_ROOM.ids[0]!;
    await pair[0].dmOp({ t: "token.update", tokenId: id, patch: { visibility: "all" } } as Op);
    assert.ok(pair[0].view()?.tokens[id], "control: P1 gets the creature the DM showed");
    return out;
  }
  // 6. Undo setup and Redo setup, the players moved back to another scene first.
  await both(pair, async (twin) => {
    // Undo setup waits on the fog steps taken on the scene since, so the reveal is undone first, as a DM would.
    if (mode === "reveal") await twin.restore("play", "undo");
    await twin.dmOp({ t: "room.setPlayerScene", sceneId: "s1" });
    if (mode === "explore") await twin.dmOp({ t: "token.delete", tokenId: PC } as Op);
    await twin.restore("setup", "undo");
    assert.equal(twin.h.actor.committed.state.scenes[SCENE], undefined, `${twin.name}: Undo setup took the dungeon back`);
    assert.ok(!Object.values(twin.h.actor.committed.state.tokens).some((x) => x.sceneId === SCENE), `${twin.name}: and every creature with it`);
    await twin.restore("setup", "redo");
    assert.equal(Object.values(twin.h.actor.committed.state.tokens).filter((x) => x.kind === "monster" && x.sceneId === SCENE).length, twin.name === "a" ? CREATURES.length : 0, `${twin.name}: Redo setup brought the creatures back`);
  });
  record(6, seen);
  return out;
}

describe("a stocked dungeon's creatures, as players get them (DSTOCK section 3)", () => {
  test("the fixture is stocked, its creatures hidden, and the stocked room has a free square", () => {
    assert.ok(CREATURES.length > 0 && CREATURES.every((op) => op.token.visibility === "dm"));
    assert.ok(STOCKED_ROOM.ids.length > 0 && STOCKED_ROOM.spot);
    assert.notEqual(STOCKED_ROOM.at, STOCKED.rooms.findIndex((r) => r.x === STOCKED.entrance.x && r.y === STOCKED.entrance.y), "the entrance is never in the share");
  });

  for (const mode of ["explore", "reveal"] as const) {
    test(`DSTOCK-T ${mode}: P1 and the display get the same frames with the hidden creatures as with none, in every case`, async (t) => {
      const flip = process.env.DSTOCK_TWIN_FLIP === "1";
      const out = await run(t, mode, flip);
      assert.deepEqual([...out].flatMap(([n, o]) => (o.same ? [] : [`case ${n}: ${o.why.slice(0, 160)}`])), [], "every case equal");
    });
  }

  test("DSTOCK-T control: a creature the DM shows reaches P1", async (t) => {
    await run(t, "explore", false, true);
  });

  test("DSTOCK-T flip: written for everyone, the creatures tell the twins apart in cases 3 to 5, and case 2 stays equal", async (t) => {
    const explore = await run(t, "explore", true);
    const reveal = await run(t, "reveal", true);
    assert.ok(explore.get(1)!.same, `case 1: players elsewhere get nothing either way (${explore.get(1)!.why})`);
    assert.ok(explore.get(2)!.same, `case 2: fog withholds a creature outside sight (${explore.get(2)!.why})`);
    assert.ok(!explore.get(3)!.same, "case 3: in sight, a creature for everyone reaches P1");
    assert.ok(!reveal.get(4)!.same, "case 4: revealed by hand, it reaches P1");
    assert.ok(!explore.get(5)!.same && !reveal.get(5)!.same, "case 5: and after a reload");
  });
});
