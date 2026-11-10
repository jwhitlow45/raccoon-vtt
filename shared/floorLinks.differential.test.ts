import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Connection } from "#server/rooms/connection.ts";
import { buildSnapshot, publishBatch, type CommittedBatch } from "#server/rooms/fanout.ts";
import { checkOps, dragged, serverApply, type Apart, type Drag, type OpPair } from "./differential.ts";
import { ANA, ATTIC, BREE, GROUND, UPPER, putOp, thornToken, tower } from "./floorLinksTestutil.ts";
import type { RoomState, Scene, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import { opSchema, type Op } from "./protocol.ts";
import { canApply } from "./permissions.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { ownWalk } from "./rules/movement.ts";
import { pathThisTurn } from "./rules/path.ts";
import { groupWalkWorld } from "./rules/walkWorld.ts";
import { DM, env, reveal, template, token } from "./testutil.ts";

/*
 * Stairs and ladders' privacy twins (docs/design/design-v1-floors.md phase
 * 2, 4, lane FL2-B): pairs of rooms that differ only in what a player may
 * not learn, the same steps made in both, and each player's answers and
 * copy compared (shared/differential.ts). Then the fan-out's frames, sent
 * to sockets opened in both orders, which must name no floor a socket
 * does not hold. The undo and redo twins need the actor's history and are
 * in server/rooms/floors.wire.itest.ts.
 *
 * The tower (floorLinksTestutil.ts): Ground floor (the players' start),
 * Upper floor and Attic. Ana owns Thorn. Bree owns nothing.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

const opened = (state: RoomState, ...ids: string[]): RoomState => ({ ...state, openFloors: { ...state.openFloors, ...Object.fromEntries(ids.map((id) => [id, { sceneId: id, rev: 1 }])) } });
const climb = (linkId = "l1", tokenId = "thorn"): Op => ({ t: "token.climb", tokenId, linkId });
const withFog = (state: RoomState, sceneId: string): RoomState => ({ ...state, scenes: { ...state.scenes, [sceneId]: { ...state.scenes[sceneId]!, fogEnabled: true } } });
const fight = (...ids: string[]): Op[] => [{ t: "encounter.start", entries: ids.map((tokenId, i) => ({ id: `e${i}`, tokenId, value: 20 - i })) }, { t: "encounter.next" }];
const LADDER = { x: 8, y: 8, w: 1, h: 1 };

/**
 * A room made by the DM's ops from seq 10 on, so two rooms made by the same
 * ops share every id and stamp the seq makes, a log line's or a turn's,
 * and differ only where their ops do.
 */
function built(state: RoomState, ops: readonly Op[]): RoomState {
  let s = state;
  for (const [i, op] of ops.entries()) {
    const r = applyOp(s, opSchema.parse(op), DM, env(10 + i));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    s = r.state;
  }
  return s;
}

/** The tower with its top floor under another id and name, so a copy that names it is caught by either. */
function retitled(state: RoomState, id: string, name: string): RoomState {
  const { [ATTIC]: attic, ...rest } = state.scenes;
  const scene: Scene = { ...attic!, id, floor: { ...attic!.floor!, name } };
  return { ...state, scenes: { ...rest, [id]: scene } };
}

/** A walk as the player's device makes it, its route searched on their copy. */
function walkStep(drag: Drag, note: string): OpPair["steps"][number] {
  return { who: drag.who, op: (_view, state) => dragged(state, drag)?.op ?? null, note };
}

/** Every step applied in both rooms, so a pair never passes by refusing alike. */
function allApplied(pair: OpPair): void {
  let a = pair.a;
  let b = pair.b;
  for (const [i, step] of pair.steps.entries()) {
    const sceneId = a.meta.playerSceneId ?? GROUND;
    const view = (s: RoomState) => projectState(s, step.who, { sceneId }) as unknown as RoomState;
    const made = (s: RoomState) => (typeof step.op === "function" ? step.op(view(s), s) : step.op);
    const oa = made(a);
    const ob = made(b);
    assert.ok(oa && ob, `step ${i + 1} makes an op in both rooms`);
    const ra = serverApply(a, oa, step.who, 3 + i);
    const rb = serverApply(b, ob, step.who, 3 + i);
    assert.ok(ra.ok && rb.ok, `step ${i + 1} (${step.note ?? oa.t}) applies in both rooms: ${ra.ok ? "" : ra.message} ${rb.ok ? "" : rb.message}`);
    a = ra.state;
    b = rb.state;
  }
}

function checked(pair: OpPair): { a: RoomState; b: RoomState } {
  allApplied(pair);
  return checkOps(pair, serverApply, 3);
}

describe("an end's far floor, way and rev (4)", () => {
  /**
   * Ana holds Attic through her owl, which the DM hid there. Bree and the
   * display do not. In one room Attic is "at", a goblin waits there, and
   * its ladder was placed after other stairs came and went, then locked
   * and unlocked: another seq and rev. In the other it is "loft", named
   * Loft, its ladder new.
   */
  function rooms(): { a: RoomState; b: RoomState } {
    const owl = (sceneId: string) => token("owl", { sceneId, kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm", x: 12, y: 12 });
    const ladder = (top: string) => putOp({ id: "l3", pairId: "l4", sceneId: UPPER, to: top, rect: LADDER, kind: "ladder" });
    const lurker = token("lurker", { sceneId: ATTIC, name: "Lurker", x: 5, y: 5 });
    const a = built(opened(tower({ tokens: { thorn: thornToken(), owl: owl(ATTIC), lurker } }), UPPER), [
      putOp({ id: "x1", pairId: "x2", rect: { x: 10, y: 10, w: 1, h: 1 } }),
      { t: "floorLink.delete", linkId: "x1" },
      putOp(),
      ladder(ATTIC),
      { t: "floorLink.update", linkId: "l3", patch: { locked: true } },
      { t: "floorLink.update", linkId: "l3", patch: { locked: false } },
    ]);
    const b = built(opened(retitled(tower({ tokens: { thorn: thornToken(), owl: owl("loft") } }), "loft", "Loft"), UPPER), [putOp(), ladder("loft")]);
    assert.notEqual(a.floorLinks!.l3!.rev, b.floorLinks!.l3!.rev);
    assert.notEqual(a.floorLinks!.l3!.made, b.floorLinks!.l3!.made);
    return { a, b };
  }

  const top = (state: RoomState) => Object.values(state.scenes).find((s) => s.floor?.level === 2)!.id;

  /** Ana's copy without the top floor she holds: its record, what stands there and its ends, and the ladder's far floor read as one name. */
  const withoutTop = (copy: Record<string, unknown>): object => {
    const scenes = copy.scenes as Record<string, Scene>;
    const gone = new Set(Object.keys(scenes).filter((id) => id !== GROUND && id !== UPPER));
    const kept = <T extends { sceneId: string }>(map: unknown) => Object.fromEntries(Object.entries((map ?? {}) as Record<string, T>).filter(([, v]) => !gone.has(v.sceneId)));
    const links = kept<{ sceneId: string; to?: string }>(copy.floorLinks);
    for (const [id, link] of Object.entries(links)) if (link.to !== undefined && gone.has(link.to)) links[id] = { ...link, to: "top" };
    return { ...copy, scenes: Object.fromEntries(Object.entries(scenes).filter(([id]) => !gone.has(id))), tokens: kept(copy.tokens), floorLinks: links };
  };

  test("every player observes the same of the ladder's lock, kind, removal and the tower turned over, Ana apart from Attic itself", () => {
    const { a, b } = rooms();
    checked({
      name: "Attic held by Ana alone",
      a,
      b,
      equal: [BREE, DISPLAY],
      apart: [{ who: ANA, strip: withoutTop }],
      steps: [
        { who: DM, op: { t: "floorLink.update", linkId: "l3", patch: { locked: true } }, note: "locked from Upper's end" },
        { who: DM, op: { t: "floorLink.update", linkId: "l4", patch: { kind: "stairs" } }, note: "made stairs from Attic's end" },
        walkStep({ who: ANA, tokenId: "thorn", to: { x: 6, y: 6 } }, "Thorn walks"),
        { who: DM, op: { t: "token.move", tokenId: "owl", x: 10, y: 10 }, note: "the owl moves on Attic" },
        { who: BREE, op: { t: "log.chat", text: "Up there?" } },
        { who: DM, op: { t: "floorLink.update", linkId: "l3", patch: { locked: false } }, note: "unlocked" },
        // Turned upside down, which keeps every pair's floors next to each other.
        { who: DM, op: (_view, state) => ({ t: "floor.order", sceneId: GROUND, floors: [top(state), UPPER, GROUND] }), note: "the tower turned over" },
        { who: DM, op: (_view, state) => ({ t: "floor.order", sceneId: GROUND, floors: [GROUND, UPPER, Object.values(state.scenes).find((s) => s.floor?.level === 0)!.id] }), note: "and back" },
        { who: DM, op: { t: "floorLink.delete", linkId: "l4" }, note: "removed from Attic's end" },
      ],
    });
  });

  test("Ana's copy names Attic on the ladder up, so the pair compares something", () => {
    const { a } = rooms();
    assert.equal((projectState(a, ANA, { sceneId: null }) as unknown as RoomState).floorLinks?.l3?.to, ATTIC);
    assert.equal((projectState(a, BREE, { sceneId: null }) as unknown as RoomState).floorLinks?.l3?.to, undefined);
  });
});

describe("the far end's record (4)", () => {
  /**
   * Players hold Ground floor alone, Thorn on the stairs on its turn. In
   * one room Upper floor is bare and the top floor. In the other, Attic
   * stands above it, and Upper floor is fogged, walled round the stairs
   * and beside them, with a goblin, hidden or not, on the landing and a
   * DM-only area over it. `far` also names it Loft, 20 ft high, raised
   * under its end: what the climb itself reads.
   */
  function rooms(far: boolean): { a: RoomState; b: RoomState } {
    const bare = tower();
    delete bare.scenes[ATTIC];
    const a = built(bare, [...fight("thorn"), putOp()]);
    const ground = far ? 5 : 0;
    let b = tower();
    b = { ...b, scenes: { ...b.scenes, [UPPER]: { ...b.scenes[UPPER]!, fogEnabled: true, ...(far ? { floor: { ...b.scenes[UPPER]!.floor!, name: "Loft", height: 20 } } : {}) } } };
    b = {
      ...b,
      tokens: { ...b.tokens, guard: token("guard", { sceneId: UPPER, name: "Guard", x: 3, y: 3, elevation: ground }), lurker: token("lurker", { sceneId: UPPER, name: "Lurker", x: 4, y: 3, elevation: ground, visibility: "dm" }) },
      templates: { ...b.templates, ward: template("ward", { sceneId: UPPER, ownerId: "dm1", visibility: "dm", origin: { x: 4, y: 3.5, z: ground } }) },
    };
    const walls = ["3,3,n", "3,3,w", "5,3,w", "3,4,n", "4,4,n", "4,3,n", "7,3,w", "6,4,n"];
    b = built(b, [
      ...fight("thorn"),
      ...(far ? [{ t: "build.height", sceneId: UPPER, cells: ["3,3", "4,3"], height: ground } as Op] : []),
      { t: "build.edge", sceneId: UPPER, edges: walls.map((key) => ({ key, feature: { kind: "wall" as const } })) },
      putOp(),
    ]);
    return { a, b };
  }

  test("every player and the display observe the same of locks, kinds and walks on Ground floor", () => {
    const { a, b } = rooms(true);
    checked({
      name: "Upper floor not held",
      a,
      b,
      equal: [ANA, BREE, DISPLAY],
      steps: [
        { who: DM, op: { t: "floorLink.update", linkId: "l2", patch: { locked: true } }, note: "locked from Upper's end" },
        walkStep({ who: ANA, tokenId: "thorn", to: { x: 6, y: 3 } }, "Thorn walks off"),
        walkStep({ who: ANA, tokenId: "thorn", to: { x: 3, y: 3 } }, "and back onto the stairs"),
        { who: DM, op: { t: "floorLink.update", linkId: "l2", patch: { kind: "ladder" } }, note: "a ladder now" },
        { who: DM, op: { t: "fog.live", sceneId: UPPER, ops: [{ id: "r1", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 8, h: 8 } }] }, note: "fog lifted upstairs" },
        { who: DM, op: { t: "floorLink.update", linkId: "l1", patch: { locked: false } }, note: "unlocked" },
      ],
    });
  });

  /**
   * The climb reads nothing of the far floor but the far end's fixed
   * ground (4, Equal answers): the same answer and landing in both rooms.
   * Once Thorn stands upstairs every player holds Upper floor and sees it
   * as it is, so after the climb each copy is compared on Ground floor and
   * Thorn alone, and Thorn's landing on the stored path.
   */
  test("Ana's Go up answers and lands alike whatever stands, hides or walls it upstairs, short of the far end's ground", () => {
    const { a, b } = rooms(false);
    const thornAndGround = (copy: Record<string, unknown>): object => {
      const tokens = copy.tokens as Record<string, { sceneId: string }>;
      const links = (copy.floorLinks ?? {}) as Record<string, { sceneId: string }>;
      return {
        tokens: Object.fromEntries(Object.entries(tokens).filter(([id, t]) => id === "thorn" || t.sceneId === GROUND)),
        floorLinks: Object.fromEntries(Object.entries(links).filter(([, l]) => l.sceneId === GROUND)),
        ground: (copy.scenes as Record<string, unknown>)[GROUND],
        log: copy.log,
        encounter: copy.encounter,
      };
    };
    const apart: Apart[] = [ANA, BREE, DISPLAY].map((who) => ({ who, strip: thornAndGround }));
    const end = checked({ name: "the far floor differs", a, b, equal: [], apart, steps: [{ who: ANA, op: climb(), note: "Go up" }] });
    const pose = (s: RoomState) => {
      const t = s.tokens.thorn!;
      return { sceneId: t.sceneId, x: t.x, y: t.y, elevation: t.elevation, squeeze: t.squeeze, path: t.path };
    };
    assert.deepEqual(pose(end.a), pose(end.b), "the stored landing and path, the marks of who saw each stop included");
    assert.equal(end.a.tokens.thorn!.sceneId, UPPER);
  });

  test("the far floor's height is what the owners learn (D-261109-100), and no other player", () => {
    const { a } = rooms(false);
    const tall = { ...a, scenes: { ...a.scenes, [UPPER]: { ...a.scenes[UPPER]!, floor: { ...a.scenes[UPPER]!.floor!, height: 20 } } } };
    const after = (s: RoomState) => {
      const r = serverApply(s, climb(), ANA, 50);
      assert.ok(r.ok);
      return r.state;
    };
    const path = (s: RoomState, who: Viewer) => projectState(after(s), who, { sceneId: null }).tokens.thorn!.path;
    assert.notDeepEqual(path(a, ANA), path(tall, ANA), "Ana reads the climb's feet");
    assert.deepEqual(path(a, BREE), path(tall, BREE), "Bree reads two stops on one spot, 0 ft by geometry");
  });
});

describe("a holder or a passenger the requester does not receive (4, D-261109-018)", () => {
  test("Thorn riding a mount Ana does not receive climbs as with no mount: the same Go up, cost and copies", () => {
    const mounted = built(tower({ tokens: { thorn: thornToken({ attached: { to: "mount", kind: "ride" } }), mount: token("mount", { name: "Hidden mount", x: 3, y: 3, visibility: "dm" }) } }), [...fight("thorn"), putOp()]);
    const alone = built(tower({ tokens: { thorn: thornToken(), mount: token("mount", { name: "Hidden mount", x: 9, y: 9, visibility: "dm" }) } }), [...fight("thorn"), putOp()]);
    const end = checked({
      name: "a hidden holder",
      a: mounted,
      b: alone,
      equal: [ANA, BREE, DISPLAY],
      steps: [{ who: ANA, op: climb(), note: "Go up" }, walkStep({ who: ANA, tokenId: "thorn", to: { x: 6, y: 3 } }, "a walk upstairs")],
    });
    assert.deepEqual([end.a.tokens.thorn!.sceneId, end.a.tokens.thorn!.attached, end.a.tokens.mount!.sceneId], [UPPER, undefined, GROUND], "Thorn went alone, let go");
  });

  test("a hidden owl on Thorn's shoulder, with its own DM-only area or without, or a DM-only area on Thorn, changes no answer or copy", () => {
    const owl = token("owl", { name: "Owl", size: "tiny", x: 3, y: 3, visibility: "dm", attached: { to: "thorn", kind: "perch" } });
    const aura = template("aura", { sceneId: GROUND, ownerId: "dm1", visibility: "dm", attachedTo: "owl", origin: { x: 3.5, y: 3.5, z: 0 } });
    const ward = template("ward", { sceneId: GROUND, ownerId: "dm1", visibility: "dm", attachedTo: "thorn", origin: { x: 3.5, y: 3.5, z: 0 } });
    const setUp = (over: Partial<RoomState>) => built(tower(over), [...fight("thorn"), putOp()]);
    const bare = setUp({});
    for (const [name, a, carried] of [
      ["an owl", setUp({ tokens: { thorn: thornToken(), owl } }), ["owl"]],
      ["an owl with its own area", setUp({ tokens: { thorn: thornToken(), owl }, templates: { aura } }), ["owl", "aura"]],
      ["a DM-only area on Thorn", setUp({ templates: { ward } }), ["ward"]],
    ] as const) {
      const end = checked({ name, a, b: bare, equal: [ANA, BREE, DISPLAY], steps: [{ who: ANA, op: climb(), note: "Go up" }, { who: ANA, op: climb("l2"), note: "Go down" }, { who: ANA, op: climb(), note: "Go up again" }] });
      assert.equal(end.a.tokens.thorn!.sceneId, UPPER, name);
      for (const id of carried) assert.equal(end.a.tokens[id]?.sceneId ?? end.a.templates[id]?.sceneId, UPPER, `${name}: ${id} went up with Thorn`);
    }
  });
});

describe("a climb's undo and redo read the end on the climber's floor alone (4, 8)", () => {
  /** An op as the server takes it, permissions first, with its inverse for the next step. */
  function served(state: RoomState, op: Op, who: Viewer, seq: number): Applied | string {
    const decision = canApply(op, who, state, { canUseAsset: () => true });
    if (!decision.ok) return `${decision.code}: ${decision.message}`;
    const r = applyOp(state, op, who, env(seq));
    return r.ok ? r : `${r.code}: ${r.message}`;
  }

  test("creatures hidden on both landings and a DM-only area, put there after the climb, change no answer or copy", () => {
    const start = built(tower(), [...fight("thorn"), putOp()]);
    const link = start.floorLinks!.l1!;
    const record = { tokenId: "thorn", linkId: "l1", rev: link.rev, made: link.made, from: GROUND, to: UPPER };
    const up = served(start, climb(), ANA, 30);
    assert.ok(typeof up !== "string", `the climb: ${String(up)}`);
    const a = up.state;
    const b: RoomState = {
      ...a,
      tokens: {
        ...a.tokens,
        lurker: token("lurker", { sceneId: GROUND, name: "Lurker", x: 3, y: 3, visibility: "dm" }),
        watcher: token("watcher", { sceneId: UPPER, name: "Watcher", x: 4, y: 3, visibility: "dm" }),
      },
      templates: { ...a.templates, ward: template("ward", { sceneId: GROUND, ownerId: "dm1", visibility: "dm", origin: { x: 3.5, y: 3.5, z: 0 } }) },
    };
    const copies = (state: RoomState) => [ANA, BREE, DISPLAY].map((who) => projectState(state, who, { sceneId: null }));
    assert.deepEqual(copies(a), copies(b), "the rooms start equal for every player");
    const restore = (from: "undo" | "redo", r: Applied): Op => ({ t: "sys.restore", entries: [...(r.inverse ?? [])], from, deps: true, climb: record });
    let ra: Applied | string = up;
    let rb: Applied | string = up;
    let sa = a;
    let sb = b;
    for (const [i, from] of (["undo", "redo", "undo", "redo"] as const).entries()) {
      assert.ok(typeof ra !== "string" && typeof rb !== "string");
      const na: Applied | string = served(sa, restore(from, ra), ANA, 31 + i);
      const nb: Applied | string = served(sb, restore(from, rb), ANA, 31 + i);
      assert.equal(typeof na === "string" ? na : "ok", typeof nb === "string" ? nb : "ok", `${from} ${i + 1}: the answer`);
      assert.ok(typeof na !== "string" && typeof nb !== "string", `${from} ${i + 1} applies: ${String(na)}`);
      assert.deepEqual(copies(na.state), copies(nb.state), `${from} ${i + 1}: every player's copy`);
      assert.equal(na.state.tokens.thorn!.sceneId, from === "undo" ? GROUND : UPPER);
      [ra, rb, sa, sb] = [na, nb, na.state, nb.state];
    }
  });
});

describe("`prior` to a player who does not own the creature (4, D-261109-015)", () => {
  /**
   * The goblin's turn. Players hold both floors and see neither the
   * stairs on Ground floor nor the landing on Upper floor. In one room the
   * goblin started its turn downstairs and the DM took it up the stairs
   * unseen. In the other it started on the landing. Then it walks into
   * sight. With `diagonal`, its first step downstairs is a diagonal every
   * player saw.
   */
  function rooms(diagonal: boolean): { a: RoomState; b: RoomState } {
    const base = (goblinOn: string, x: number, open: boolean) => {
      const s = withFog(withFog(opened(tower({ tokens: { thorn: thornToken({ x: 15, y: 15 }), goblin: token("goblin", { sceneId: goblinOn, x, y: x }) } }), UPPER), GROUND), UPPER);
      s.meta = { ...s.meta, settings: { ...s.meta.settings, diagonal: "fiveTen" } };
      for (const id of [GROUND, UPPER]) reveal(s, id, { x: 12, y: 0, w: 8, h: 20 });
      const fog = structuredClone(s.fogTiles);
      if (open) reveal(s, GROUND, { x: 2, y: 2, w: 3, h: 3 });
      return { room: built(s, [putOp({ rect: { x: 4, y: 4, w: 1, h: 1 } }), ...fight("goblin", "thorn")]), fog };
    };
    const start = base(GROUND, 3, diagonal);
    let a = built(start.room, [{ t: "token.move", tokenId: "goblin", x: 4, y: 4 }]);
    // Back under the fog before the stairs.
    a = built({ ...a, fogTiles: start.fog }, [climb("l1", "goblin")]);
    return { a, b: base(UPPER, 4, false).room };
  }

  const walk: OpPair["steps"] = [{ who: DM, op: { t: "token.move", tokenId: "goblin", x: 13, y: 4 }, note: "the goblin walks into sight" }];

  test("an unseen climb with no diagonal players could count: no `prior` either way, every copy the same", () => {
    const { a, b } = rooms(false);
    assert.equal(a.tokens.goblin!.path!.prior!.seenDiag.join(), "0,0");
    const end = checked({ name: "an unseen climb", a, b, equal: [ANA, BREE, DISPLAY], steps: walk });
    for (const who of [ANA, BREE, DISPLAY]) {
      const path = projectState(end.a, who, { sceneId: null }).tokens.goblin?.path;
      assert.ok(path && path.stops.length > 0 && path.prior === undefined, `${who.memberId} sees the walk with no prior`);
    }
  });

  test("with one, `seenDiag` alone reaches them (the accepted channel), and their route starts from the server's count", () => {
    const { a } = rooms(true);
    const prior = a.tokens.goblin!.path!.prior!;
    assert.ok(prior.seenDiag[0] + prior.seenDiag[1] > 0, "players saw the diagonal");
    const r = applyOp(a, walk[0]!.op as Op, DM, env(50));
    assert.ok(r.ok);
    const goblin = r.state.tokens.goblin!;
    const stored = pathThisTurn(r.state.encounter, goblin)!;
    const server = groupWalkWorld(r.state, ownWalk(goblin), { role: "dm" }, stored).input.counter;
    for (const who of [ANA, BREE, DISPLAY]) {
      const view = projectState(r.state, who, { sceneId: null }) as unknown as RoomState;
      const mine = view.tokens.goblin!;
      assert.deepEqual(mine.path!.prior, { seenDiag: prior.seenDiag }, who.memberId);
      assert.deepEqual(groupWalkWorld(view, ownWalk(mine), { role: "player" }, mine.path!).input.counter, server, `${who.memberId}'s device counts as the server`);
    }
  });
});

/*
 * The fan-out's frames (server/rooms/fanout.ts): sockets opened in both
 * orders, so a value one viewer's projection made can never be handed to
 * the next. Every frame and snapshot a socket gets is searched for the
 * floors and ends it does not hold.
 */
type Socket = { conn: Connection; sent: string[] };

function socket(state: RoomState, viewer: Viewer, n: number): Socket {
  const sent: string[] = [];
  const raw = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(text), close: () => undefined, terminate: () => undefined };
  const grant = { sessionId: `s-${viewer.memberId}-${n}`, roomId: "STAIRS01", memberId: viewer.memberId, role: viewer.role, display: viewer.memberId.startsWith("display:") };
  const conn = new Connection(raw as never, grant, "203.0.113.9");
  conn.sceneId = viewer.role === "dm" ? GROUND : null;
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  sent.push(JSON.stringify(snapshot.message));
  return { conn, sent };
}

/** Runs the ops, publishing each batch to the sockets in the order given. */
function play(state: RoomState, steps: readonly { who: Viewer; op: Op }[], viewers: readonly Viewer[]): Map<string, string[]> {
  const sockets = viewers.map((v, i) => [v.memberId, socket(state, v, i)] as const);
  let s = state;
  for (const [i, step] of steps.entries()) {
    const r = applyOp(s, step.op, step.who, env(200 + i));
    assert.ok(r.ok, `${step.op.t}: ${r.ok ? "" : r.message}`);
    const batch: CommittedBatch = { pub: 200 + i, before: s, after: r.state, touched: r.touched, global: r.global, acks: new Map(), rejects: new Map(), restored: new Map() };
    publishBatch(
      batch,
      sockets.map(([, sk]) => sk.conn),
      () => undefined,
    );
    s = r.state;
  }
  return new Map(sockets.map(([id, sk]) => [id, sk.sent]));
}

describe("the frames each socket is sent (4)", () => {
  const steps: { who: Viewer; op: Op }[] = [
    { who: DM, op: { t: "floorLink.update", linkId: "l3", patch: { locked: true } } },
    { who: DM, op: { t: "floorLink.update", linkId: "l1", patch: { kind: "ladder" } } },
    { who: DM, op: { t: "floor.order", sceneId: GROUND, floors: [ATTIC, UPPER, GROUND] } },
    { who: DM, op: { t: "floor.order", sceneId: GROUND, floors: [GROUND, UPPER, ATTIC] } },
    { who: DM, op: { t: "floorLink.update", linkId: "l3", patch: { locked: false } } },
    { who: DM, op: { t: "floorLink.delete", linkId: "l3" } },
  ];
  const ladder = putOp({ id: "l3", pairId: "l4", sceneId: UPPER, to: ATTIC, rect: LADDER, kind: "ladder" });

  test("Attic held by Ana and not by Bree, in both orders: Bree's frames never name Attic or its end, Ana's do", () => {
    const owl = token("owl", { sceneId: ATTIC, kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm", x: 12, y: 12 });
    const s = built(opened(tower({ tokens: { thorn: thornToken(), owl } }), UPPER), [putOp(), ladder]);
    for (const order of [
      [ANA, BREE, DISPLAY, DM],
      [DM, DISPLAY, BREE, ANA],
    ]) {
      const sent = play(s, steps, order);
      for (const id of [BREE.memberId, DISPLAY.memberId]) {
        const text = sent.get(id)!.join("\n");
        assert.doesNotMatch(text, /"at"(?!:)|Attic|floorLink:l4|"l4"/, `${id} is sent Attic or its end (${order.map((v) => v.memberId).join(", ")})`);
        assert.match(text, /floorLink:l3/, `${id} is sent the ladder's changes`);
      }
      assert.match(sent.get(ANA.memberId)!.join("\n"), /"to":"at"/, "Ana is sent the ladder's far floor");
    }
  });

  test("Ground floor held alone: no frame names Upper floor or its end", () => {
    const s = built(tower(), [putOp(), ladder]);
    for (const order of [
      [ANA, BREE, DISPLAY, DM],
      [DM, DISPLAY, BREE, ANA],
    ]) {
      const sent = play(s, steps, order);
      for (const who of [ANA, BREE, DISPLAY]) {
        const text = sent.get(who.memberId)!.join("\n");
        assert.doesNotMatch(text, /floorLink:l[234]|"l[234]"|"(?:id|sceneId|to|of)":"(?:up|at)"|"(?:up|at)":\{|scene:(?:up|at)\b|Upper floor|Attic/, `${who.memberId}: a frame names an end or a floor not held`);
        assert.match(text, /floorLink:l1/, `${who.memberId} is sent the Ground end's changes`);
      }
    }
  });

  test("under the fog no end, and the fog lifted over one square of it sends the end", () => {
    const s = built(withFog(tower(), GROUND), [putOp()]);
    const sent = play(s, [{ who: DM, op: { t: "fog.live", sceneId: GROUND, ops: [{ id: "r1", mode: "reveal", shape: { kind: "rect", x: 4, y: 3, w: 1, h: 1 } }] } }], [BREE, DM]);
    const [snapshot, ...frames] = sent.get(BREE.memberId)!;
    assert.doesNotMatch(snapshot!, /floorLink/, "the snapshot holds no fogged end");
    assert.match(frames.join("\n"), /"key":"floorLink:l1","value":\{/, "the reveal sends it");
  });
});
