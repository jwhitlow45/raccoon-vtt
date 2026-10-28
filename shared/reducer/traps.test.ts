import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { BuildChunk, RoomState, TrapDue, Viewer } from "../model.ts";
import { canApply, CHOOSE_OPENER } from "../permissions.ts";
import { projectEntity, projectState } from "../project.ts";
import { opSchema, type Op, type TrapInput } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, P2, apply, env, refused, reveal, room, token, trap } from "../testutil.ts";
import { DONE_MEANWHILE, GIVE_IT_USES, SETTLED_MEANWHILE, addDue, trapOwnBytes } from "./traps.ts";
import { Tx } from "./tx.ts";

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

/** A trap as `trap.create` sends it. */
function input(id: string, overrides: Partial<TrapInput> = {}): TrapInput {
  const { rev: _rev, state: _state, rig, ...rest } = trap(id);
  return { ...rest, rig: rig!, ...overrides } as TrapInput;
}

function create(state: RoomState, t: TrapInput, seq = 1): RoomState {
  return apply(state, { t: "trap.create", trap: t }, DM, seq);
}

/** An op as the server reads it: through the protocol first. */
function parses(op: unknown): boolean {
  return opSchema.safeParse(op).success;
}

const door = (state: "closed" | "locked" = "closed", secret = false): BuildChunk => ({
  sceneId: "s1",
  cx: 0,
  cy: 0,
  rev: 0,
  cells: {},
  edges: { "5,5,n": { kind: "door", state, secret, discovered: false } },
});

function table(): RoomState {
  const state = room();
  state.buildChunks[chunkKey("s1", 0, 0)] = door();
  state.tokens.thorn = token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], x: 4, y: 4 });
  state.tokens.imp = token("imp", { name: "Imp", visibility: "dm", x: 9, y: 9 });
  state.tokens.ghoul = token("ghoul", { name: "Ghoul", visibility: "dm", x: 12, y: 12 });
  state.lights.brazier = { id: "brazier", rev: 0, sceneId: "s1", x: 2, y: 2, bright: 20, dim: 20, on: true, walls: false, label: "Light-Brazier" };
  state.stamps.rubble = { id: "rubble", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "dm" };
  return state;
}

function withDue(state: RoomState, trapId: string, due: TrapDue[]): RoomState {
  const t = state.traps[trapId]!;
  return { ...state, traps: { ...state.traps, [trapId]: { ...t, rig: { ...t.rig!, due } } } };
}

const occurrence = (id: string, overrides: Partial<TrapDue> = {}): TrapDue => ({ id, at: "2026-10-12T20:00:00.000Z", how: "enter", by: ["thorn"], hits: ["thorn"], ...overrides });

describe("making, changing and deleting traps (docs/design-v1-traps.md 6.2)", () => {
  test("a new trap is armed, unfound unless it says so, with its rig whole", () => {
    const state = create(table(), input("pit"));
    const t = state.traps.pit!;
    assert.equal(t.state, "armed");
    assert.equal(t.found, false);
    assert.equal(t.sceneId, "s1");
    assert.deepEqual(t.rig?.on, ["enter"]);
    assert.equal(create(table(), input("pit", { found: true })).traps.pit!.found, true);
  });

  test("a taken id, a scene that is not there and squares past the scene's edge are refused", () => {
    const state = create(table(), input("pit"));
    assert.match(refused(state, { t: "trap.create", trap: input("pit") }).message, /already/);
    assert.equal(refused(table(), { t: "trap.create", trap: input("pit", { sceneId: "nowhere" }) }).code, "gone");
    assert.match(refused(table(), { t: "trap.create", trap: input("pit", { zone: { cells: [{ x: 39, y: 0, w: 2, h: 1 }] } }) }).message, /inside its scene/);
  });

  test("the rig fits its zone: squares go off one to four ways, a wire and a door none, and only squares open a pit or hit everyone on them", () => {
    const base = input("t");
    const wire = { wire: { a: [2, 2] as [number, number], b: [5, 2] as [number, number] } };
    assert.match(refused(table(), { t: "trap.create", trap: { ...base, rig: { ...base.rig, on: [] } } }).message, /one to four/);
    assert.match(refused(table(), { t: "trap.create", trap: { ...base, zone: wire } }).message, /when crossed/);
    assert.match(refused(table(), { t: "trap.create", trap: { ...base, zone: wire, rig: { ...base.rig, on: [], pit: { floor: -10 } } } }).message, /pit/);
    assert.match(refused(table(), { t: "trap.create", trap: { ...base, zone: wire, rig: { ...base.rig, on: [], hits: "zone" } } }).message, /everyone/);
    const onDoor = create(table(), { ...base, zone: { door: { edge: "5,5,n" } }, rig: { ...base.rig, on: [] } });
    assert.ok(onDoor.traps.t);
    assert.match(refused(table(), { t: "trap.create", trap: { ...base, zone: { door: { edge: "6,6,n" } }, rig: { ...base.rig, on: [] } } }).message, /door/);
  });

  test("its actions name a door, light, stamp or creature of its own scene", () => {
    const state = table();
    state.lights.far = { ...state.lights.brazier!, id: "far", sceneId: "s2" };
    const base = input("t");
    const withActions = (actions: TrapInput["rig"]["actions"]) => ({ t: "trap.create" as const, trap: { ...base, rig: { ...base.rig, actions } } });
    assert.ok(apply(state, withActions([{ door: { edge: "5,5,n" }, state: "locked" }, { light: "brazier", on: false }, { show: { tokenId: "imp" } }, { show: { stampId: "rubble" } }])).traps.t);
    assert.match(refused(state, withActions([{ light: "far", on: false }])).message, /light/);
    assert.match(refused(state, withActions([{ show: { tokenId: "nobody" } }])).message, /shows/);
    assert.match(refused(state, withActions([{ door: { edge: "9,9,w" }, state: "open" }])).message, /door/);
  });

  test("a trap's own id is plain, and its text never holds half a character", () => {
    assert.equal(parses({ t: "trap.create", trap: input("a.b") }), false);
    assert.equal(parses({ t: "trap.create", trap: input("x".repeat(65)) }), false);
    assert.equal(parses({ t: "trap.create", trap: input("ok_id-1") }), true);
    const base = input("t");
    assert.equal(parses({ t: "trap.create", trap: { ...base, name: "Pit \uD83D" } }), false);
    assert.equal(parses({ t: "trap.create", trap: { ...base, name: "Pit 🕳" } }), true);
    assert.equal(parses({ t: "trap.create", trap: { ...base, rig: { ...base.rig, message: "\uDC00 click" } } }), false);
    assert.equal(parses({ t: "trap.create", trap: { ...base, rig: { ...base.rig, note: "a\nb \uD800" } } }), false);
    assert.equal(parses({ t: "trap.create", trap: { ...base, rig: { ...base.rig, find: [{ ability: "wis", skill: "perception", dc: 15, what: "\uD800" }] } } }), false);
  });

  test("a trap's own fields are at most 9 KiB: the largest with plain refs fits, and with refs JSON escapes to 386 bytes it is refused", () => {
    const wide = "€";
    const odd = (i: number) => `${String.fromCharCode(1)}`.repeat(63) + String(i);
    const state = table();
    const plain = Array.from({ length: 8 }, (_, i) => `p${"x".repeat(62)}${i}`);
    for (const id of [...plain, ...plain.map((_, i) => odd(i))]) state.tokens[id] = token(id, { visibility: "dm" });
    const rects = Array.from({ length: 8 }, (_, i) => ({ x: i * 2, y: 0, w: 2, h: 20 }));
    const largest = (ids: readonly string[]): TrapInput => ({
      id: "t".repeat(64),
      sceneId: "s1",
      name: wide.repeat(80),
      zone: { cells: rects },
      rig: {
        on: ["enter", "leave", "turnStart", "turnEnd"],
        who: "party",
        minSize: "small",
        floor: true,
        resets: "nextTurn",
        usesLeft: 99,
        stops: false,
        foundOnSpring: true,
        pit: { floor: -100 },
        hits: { cells: rects },
        save: { ability: "dex", dc: 30, onPass: "half" },
        damage: Array.from({ length: 4 }, () => ({ formula: "10d10+10d10+10d10+10d10", type: "bludgeoning" as const })),
        conditions: ["prone", "restrained", "poisoned"],
        lasts: { mode: "rounds", rounds: 1000 },
        message: wide.repeat(200),
        sound: "rumble",
        actions: ids.map((tokenId) => ({ show: { tokenId } })),
        find: [
          { ability: "wis", skill: "perception", dc: 30, what: wide.repeat(80) },
          { ability: "int", skill: "investigation", dc: 30, what: wide.repeat(80) },
        ],
        notice: true,
        disarm: { text: wide.repeat(200), check: { ability: "dex", skill: "sleight-of-hand", dc: 30, what: wide.repeat(80) } },
        note: wide.repeat(1000),
        preset: "x".repeat(40),
      },
    });
    const fits = largest(plain);
    const check = opSchema.safeParse({ t: "trap.create", trap: fits });
    assert.ok(check.success, check.success ? "" : check.error.message);
    const made = apply(state, { t: "trap.create", trap: fits });
    const bytes = trapOwnBytes(made.traps[fits.id]!);
    assert.ok(bytes <= LIMITS.trapBytes && bytes > 7_000, `the largest plain trap is ${bytes} bytes`);
    const escaped = largest(plain.map((_, i) => odd(i)));
    assert.ok(parses({ t: "trap.create", trap: escaped }), "the protocol takes the ids");
    assert.match(refused(state, { t: "trap.create", trap: escaped }).message, /at most 9 KiB/);
  });

  test("a change replaces only the fields it names, takes away an optional one with null, and forgets who noticed when the find checks change", () => {
    let state = create(table(), input("pit", { rig: { ...input("pit").rig, message: "Click.", usesLeft: 2, find: [{ ability: "wis", skill: "perception", dc: 15 }] } }));
    state = { ...state, traps: { ...state.traps, pit: { ...state.traps.pit!, rig: { ...state.traps.pit!.rig!, noticedBy: "thorn", due: [occurrence("5:0")] } } } };
    state = apply(state, { t: "trap.update", trapId: "pit", patch: { rig: { message: "Snap!" } } }, DM, 2);
    let rig = state.traps.pit!.rig!;
    assert.equal(rig.message, "Snap!");
    assert.equal(rig.usesLeft, 2);
    assert.equal(rig.noticedBy, "thorn", "the reducer's fields stay");
    assert.equal(rig.due?.length, 1);
    state = apply(state, { t: "trap.update", trapId: "pit", patch: { rig: { usesLeft: null } } }, DM, 3);
    assert.equal(state.traps.pit!.rig!.usesLeft, undefined);
    state = apply(state, { t: "trap.update", trapId: "pit", patch: { rig: { find: [] } } }, DM, 4);
    rig = state.traps.pit!.rig!;
    assert.equal(rig.noticedBy, undefined);
    assert.deepEqual(rig.find, []);
    state = apply(state, { t: "trap.update", trapId: "pit", patch: { name: "Covered Pit", found: true, state: "disarmed" } }, DM, 5);
    assert.equal(state.traps.pit!.name, "Covered Pit");
    assert.equal(state.traps.pit!.state, "disarmed");
    assert.equal(state.traps.pit!.found, true);
    assert.equal(refused(state, { t: "trap.update", trapId: "gone", patch: { found: false } }).code, "gone");
  });

  test("arming a trap with no uses left asks for its uses first", () => {
    let state = create(table(), input("pit"));
    state = { ...state, traps: { ...state.traps, pit: { ...state.traps.pit!, state: "sprung", rig: { ...state.traps.pit!.rig!, usesLeft: 0 } } } };
    assert.equal(refused(state, { t: "trap.update", trapId: "pit", patch: { state: "armed" } }).message, GIVE_IT_USES);
    assert.equal(apply(state, { t: "trap.update", trapId: "pit", patch: { state: "armed", rig: { usesLeft: 1 } } }).traps.pit!.state, "armed");
    assert.equal(apply(state, { t: "trap.update", trapId: "pit", patch: { state: "armed", rig: { usesLeft: null } } }).traps.pit!.state, "armed");
  });

  test("an edit checks only the refs it changes, so a light deleted since leaves the trap editable", () => {
    let state = create(table(), input("t", { rig: { ...input("t").rig, actions: [{ light: "brazier", on: false }] } }));
    const { brazier: _gone, ...lights } = state.lights;
    state = { ...state, lights };
    assert.equal(apply(state, { t: "trap.update", trapId: "t", patch: { name: "Still here" } }).traps.t!.name, "Still here");
    assert.match(refused(state, { t: "trap.update", trapId: "t", patch: { rig: { actions: [{ light: "brazier", on: true }] } } }).message, /light/);
    // An actions edit reads only the actions it adds or changes: the one with the gone light stays, for the card to name.
    const more = apply(state, { t: "trap.update", trapId: "t", patch: { rig: { actions: [{ light: "brazier", on: false }, { door: { edge: "5,5,n" }, state: "locked" }] } } });
    assert.equal(more.traps.t!.rig!.actions.length, 2);
  });

  test("a refused action names what is wrong with its target", () => {
    const state = table();
    state.lights.far = { ...state.lights.brazier!, id: "far", sceneId: "s2" };
    state.tokens.away = token("away", { name: "Imp", sceneId: "s2" });
    const base = input("t");
    const withActions = (actions: TrapInput["rig"]["actions"]) => ({ t: "trap.create" as const, trap: { ...base, rig: { ...base.rig, actions } } });
    assert.equal(refused(state, withActions([{ light: "far", on: false }])).message, 'the light "Light-Brazier" is on another scene');
    assert.equal(refused(state, withActions([{ light: "gone", on: false }])).message, "a light it sets was deleted");
    assert.equal(refused(state, withActions([{ show: { tokenId: "away" } }])).message, "Imp is on another scene");
    assert.equal(refused(state, withActions([{ show: { tokenId: "nobody" } }])).message, "a creature it shows was deleted");
    assert.equal(refused(state, withActions([{ show: { stampId: "nothing" } }])).message, "a stamp it shows was deleted");
  });

  test("delete takes the trap away, and a gone one says so", () => {
    const state = apply(create(table(), input("pit")), { t: "trap.delete", trapId: "pit" }, DM, 2);
    assert.equal(state.traps.pit, undefined);
    assert.equal(refused(state, { t: "trap.delete", trapId: "pit" }).code, "gone");
  });

  test("every trap op is the DM's", () => {
    const state = create(table(), input("pit"));
    const ops: Op[] = [
      { t: "trap.create", trap: input("other") },
      { t: "trap.update", trapId: "pit", patch: { found: true } },
      { t: "trap.delete", trapId: "pit" },
      { t: "trap.act", trapId: "pit", due: "1:0" },
      { t: "trap.settle", trapId: "pit", due: "1:0" },
    ];
    for (const op of ops) {
      assert.equal(canApply(op, P1, state, { canUseAsset: () => true }).ok, false, op.t);
      assert.equal(canApply(op, DM, state, { canUseAsset: () => true }).ok, true, op.t);
    }
  });

  test("a player's open names their own token as the opener, and a DM's need not", () => {
    const state = table();
    state.tokens.thorn = { ...state.tokens.thorn!, x: 5, y: 5 };
    const open = (by?: string): Op => ({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "open", ...(by ? { by } : {}) });
    const deps = { canUseAsset: () => true };
    assert.equal(canApply(open("thorn"), P1, state, deps).ok, true);
    const without = canApply(open(), P1, state, deps);
    assert.deepEqual(without.ok ? null : [without.code, without.message], ["invalid", CHOOSE_OPENER]);
    const others = canApply(open("imp"), P1, state, deps);
    assert.deepEqual(others.ok ? null : [others.code, others.message], ["invalid", CHOOSE_OPENER], "a token they do not own, hidden or not");
    assert.equal(canApply(open(), DM, state, deps).ok, true);
    assert.equal(canApply({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "closed" }, P1, state, deps).ok, true, "closing needs no opener");
    assert.equal(canApply(open("thorn"), P2, state, deps).ok, false);
  });
});

describe("doing a waiting springing's effects, and settling it (6.2)", () => {
  function waiting(): RoomState {
    const base = input("plate", { rig: { ...input("plate").rig, message: "A grinding of stone.", sound: "rumble", actions: [{ door: { edge: "5,5,n" }, state: "locked" }, { light: "brazier", on: false }, { show: { tokenId: "ghoul" } }, { show: { stampId: "rubble" } }, { show: { tokenId: "gone" } }] } });
    const state = table();
    state.tokens.gone = token("gone", { visibility: "dm" });
    let made = create(state, base);
    const { gone: _gone, ...tokens } = made.tokens;
    made = { ...made, tokens };
    return withDue(made, "plate", [occurrence("5:0", { by: ["imp", "thorn"], hidden: true }), occurrence("6:0")]);
  }

  test("Do its effects runs every action that still has its target, writes the players' line naming only creatures every player sees, and marks it done and found", () => {
    const state = apply(waiting(), { t: "trap.act", trapId: "plate", due: "5:0" }, DM, 9);
    assert.deepEqual(state.buildChunks[chunkKey("s1", 0, 0)]!.edges["5,5,n"], { kind: "door", state: "locked", secret: false, discovered: false });
    assert.equal(state.lights.brazier!.on, false);
    assert.equal(state.tokens.ghoul!.visibility, "all");
    assert.equal(state.stamps.rubble!.visibility, "all");
    assert.equal(state.trapSeen.length, 1);
    const line = state.trapSeen[0]!;
    assert.deepEqual(line.data, { type: "trapSeen", by: ["thorn"], message: "A grinding of stone.", sound: "rumble" });
    assert.equal(line.id, "9:0");
    const due = state.traps.plate!.rig!.due!;
    assert.equal(due.find((d) => d.id === "5:0")!.acted, true);
    assert.equal(due.find((d) => d.id === "6:0")!.acted, undefined);
    assert.equal(state.traps.plate!.found, true);
    assert.equal(state.log.length, 0, "nothing in the shared log");
  });

  test("Do its effects runs once: a second, or one for an occurrence settled since, is refused", () => {
    const once = apply(waiting(), { t: "trap.act", trapId: "plate", due: "5:0" }, DM, 9);
    assert.equal(refused(once, { t: "trap.act", trapId: "plate", due: "5:0" }, DM, 10).message, DONE_MEANWHILE);
    assert.equal(refused(waiting(), { t: "trap.act", trapId: "plate", due: "7:0" }).message, DONE_MEANWHILE);
    assert.equal(refused(waiting(), { t: "trap.act", trapId: "nothing", due: "5:0" }).message, DONE_MEANWHILE);
    const acted = withDue(waiting(), "plate", [occurrence("5:0", { acted: true })]);
    assert.equal(refused(acted, { t: "trap.act", trapId: "plate", due: "5:0" }).message, DONE_MEANWHILE, "a springing that ran its actions and left damage waiting");
  });

  test("Dismiss takes the occurrence away, Mark sprung springs the trap too, and a second is refused", () => {
    const dismissed = apply(waiting(), { t: "trap.settle", trapId: "plate", due: "5:0" });
    assert.deepEqual(dismissed.traps.plate!.rig!.due!.map((d) => d.id), ["6:0"]);
    assert.equal(dismissed.traps.plate!.state, "armed");
    assert.equal(refused(dismissed, { t: "trap.settle", trapId: "plate", due: "5:0" }).message, SETTLED_MEANWHILE);
    const sprung = apply(dismissed, { t: "trap.settle", trapId: "plate", due: "6:0", sprung: true }, DM, 2);
    assert.equal(sprung.traps.plate!.rig!.due, undefined);
    assert.equal(sprung.traps.plate!.state, "sprung");
  });

  test("a trap's fourth occurrence drops its own oldest, and a room's eleventh the room's oldest", () => {
    let state = table();
    for (const id of ["a", "b", "c", "d"]) state = create(state, input(id));
    // B holds the room's oldest while A takes a fourth: A gives up its own.
    state = withDue(state, "b", [occurrence("1:0")]);
    state = withDue(state, "a", [occurrence("2:0"), occurrence("3:0"), occurrence("4:0")]);
    const tx = new Tx(state, DM, env(10));
    addDue(tx, "a", occurrence("10:0"));
    assert.deepEqual(tx.state.traps.a!.rig!.due!.map((d) => d.id), ["3:0", "4:0", "10:0"]);
    assert.deepEqual(tx.state.traps.b!.rig!.due!.map((d) => d.id), ["1:0"]);
    // Ten across the room, then an eleventh: the room's oldest goes, whichever trap holds it.
    tx.write(keys.trap("c"), { ...tx.state.traps.c!, rig: { ...tx.state.traps.c!.rig!, due: [occurrence("11:0"), occurrence("12:0"), occurrence("13:0")] } });
    tx.write(keys.trap("d"), { ...tx.state.traps.d!, rig: { ...tx.state.traps.d!.rig!, due: [occurrence("14:0"), occurrence("15:0"), occurrence("17:0")] } });
    addDue(tx, "b", occurrence("16:0"));
    const ids = (id: string) => (tx.state.traps[id]!.rig!.due ?? []).map((d) => d.id);
    assert.deepEqual(ids("b"), ["16:0"]);
    assert.equal(Object.values(tx.state.traps).reduce((n, t) => n + (t.rig?.due?.length ?? 0), 0), LIMITS.trapDuePerRoom);
  });
});

describe("a duplicated scene and a deleted one (6.8)", () => {
  function rigged(): RoomState {
    let state = table();
    const base = input("plate");
    state = create(state, { ...base, rig: { ...base.rig, actions: [{ door: { edge: "5,5,n" }, state: "locked" }, { light: "brazier", on: false }, { show: { tokenId: "imp" } }, { show: { stampId: "rubble" } }] } });
    const t = state.traps.plate!;
    return { ...state, traps: { plate: { ...t, state: "sprung", rig: { ...t.rig!, noticedBy: "thorn", usesLeft: 0, due: [occurrence("3:0")] } } } };
  }

  test("a copy's trap takes a derived id, its actions name the copies, a creature left behind is dropped, and what the reducer wrote stays behind", () => {
    const state = apply(rigged(), { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: false, drawings: false } });
    const copies = Object.values(state.traps).filter((t) => t.sceneId === "s3");
    assert.equal(copies.length, 1);
    const copy = copies[0]!;
    assert.match(copy.id, /^[0-9a-f-]{36}$/);
    const light = Object.values(state.lights).find((l) => l.sceneId === "s3")!;
    const stamp = Object.values(state.stamps).find((st) => st.sceneId === "s3")!;
    assert.deepEqual(copy.rig!.actions, [{ door: { edge: "5,5,n" }, state: "locked" }, { light: light.id, on: false }, { show: { stampId: stamp.id } }]);
    assert.equal(copy.rig!.noticedBy, undefined);
    assert.equal(copy.rig!.due, undefined);
    assert.equal(copy.state, "sprung", "its state is the DM's own");
    assert.equal(copy.rig!.usesLeft, 0);
    const withCreatures = apply(rigged(), { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } });
    const imp = Object.values(withCreatures.tokens).find((t) => t.sceneId === "s3" && t.name === "Imp")!;
    const kept = Object.values(withCreatures.traps).find((t) => t.sceneId === "s3")!;
    assert.ok(kept.rig!.actions.some((a) => "show" in a && "tokenId" in a.show && a.show.tokenId === imp.id));
  });

  test("deleting a scene deletes its traps, and undoing it brings them back", () => {
    const state = rigged();
    const result = applyOp(state, { t: "scene.delete", sceneId: "s1" }, DM, env(5));
    assert.ok(result.ok);
    assert.equal(result.state.traps.plate, undefined);
    const restored = applyOp(result.state, { t: "sys.restore", entries: result.inverse ?? [], from: "undo" }, DM, env(6));
    assert.ok(restored.ok, restored.ok ? "" : restored.message);
    assert.deepEqual(restored.state.traps.plate, state.traps.plate);
  });

  test("a restore never puts back a trap log line", () => {
    const state = rigged();
    const line = { id: "3:0", at: "2026-10-12T20:00:00.000Z", kind: "event" as const, data: { type: "trapSeen" as const, by: [], message: "Click." } };
    assert.equal(refused(state, { t: "sys.restore", entries: [{ key: keys.trapSeen("3:0"), value: line }], from: "undo" }).code, "invalid");
  });
});

describe("what players get of a trap (6.4)", () => {
  const playerView = (state: RoomState, viewer: Viewer = P1) => projectState(state, viewer, { sceneId: "s1" });

  test("an unfound trap is the DM's alone, and a found one reaches players cut to its id, scene, name and zone at rev 0", () => {
    let state = create(table(), input("pit", { rig: { ...input("pit").rig, message: "Click." } }));
    assert.ok(projectState(state, DM, { sceneId: "s1" }).traps.pit?.rig, "the DM gets the rig");
    assert.equal(playerView(state).traps.pit, undefined);
    assert.equal(playerView(state, DISPLAY).traps.pit, undefined);
    state = apply(state, { t: "trap.update", trapId: "pit", patch: { found: true } }, DM, 2);
    const seen = playerView(state).traps.pit!;
    assert.deepEqual(seen, { id: "pit", rev: 0, sceneId: "s1", name: "Hidden Pit", zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }] } });
    assert.deepEqual(playerView(state, DISPLAY).traps.pit, seen);
    // Springing, re-arming, uses and rig edits send players nothing.
    const sprung = apply(state, { t: "trap.update", trapId: "pit", patch: { state: "sprung", rig: { message: "Snap!" } } }, DM, 3);
    assert.deepEqual(playerView(sprung).traps.pit, seen);
    const disarmed = apply(state, { t: "trap.update", trapId: "pit", patch: { state: "disarmed" } }, DM, 4);
    assert.deepEqual(playerView(disarmed).traps.pit, { ...seen, disarmed: true });
  });

  test("players get only the player scene's traps, and none behind a blackout", () => {
    let state = create(table(), input("pit", { found: true }));
    state = create(state, input("far", { found: true, sceneId: "s2" }), 2);
    assert.deepEqual(Object.keys(playerView(state).traps), ["pit"]);
    state.meta.view.blackout = true;
    assert.deepEqual(Object.keys(playerView(state).traps), []);
  });

  test("a found trap under full fog is withheld by the labels' rule, and shows once any of its cells is revealed", () => {
    const state = create(table(), input("pit", { found: true, zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }, { x: 20, y: 20, w: 1, h: 1 }] } }));
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    assert.equal(playerView(state).traps.pit, undefined);
    reveal(state, "s1", { x: 20, y: 20, w: 1, h: 1 });
    assert.ok(playerView(state).traps.pit);
    assert.ok(projectState(state, DM, { sceneId: "s1" }).traps.pit);
  });

  test("a wire's cells and a door's two cells decide the fog rule too", () => {
    const wire = create(table(), input("wire", { found: true, zone: { wire: { a: [10, 10], b: [12, 10] } }, rig: { ...input("wire").rig, on: [] } }));
    wire.scenes.s1 = { ...wire.scenes.s1!, fogEnabled: true };
    assert.equal(playerView(wire).traps.wire, undefined);
    reveal(wire, "s1", { x: 11, y: 9, w: 1, h: 1 });
    assert.ok(playerView(wire).traps.wire, "a cell the wire runs along");
    const onDoor = create(table(), input("d", { found: true, zone: { door: { edge: "5,5,n" } }, rig: { ...input("d").rig, on: [] } }));
    onDoor.scenes.s1 = { ...onDoor.scenes.s1!, fogEnabled: true };
    assert.equal(playerView(onDoor).traps.d, undefined);
    reveal(onDoor, "s1", { x: 5, y: 4, w: 1, h: 1 });
    assert.ok(playerView(onDoor).traps.d, "the cell north of the door");
  });

  test("a door trap is withheld while its door is a secret one not found", () => {
    const state = table();
    state.buildChunks[chunkKey("s1", 0, 0)] = door("closed", true);
    let made = create(state, input("d", { found: true, zone: { door: { edge: "5,5,n" } }, rig: { ...input("d").rig, on: [] } }));
    assert.equal(playerView(made).traps.d, undefined);
    assert.ok(projectState(made, DM, { sceneId: "s1" }).traps.d);
    made = apply(made, { t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "closed", found: true }, DM, 2);
    assert.ok(playerView(made).traps.d);
  });

  test("the DM's trap log is the DMs' alone, and the players' lines reach every player and table display, naming only the creatures each sees", () => {
    const state = table();
    state.trapLog = [{ id: "4:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "trap", trapId: "pit", sceneId: "s1", name: "Hidden Pit", how: "enter", by: ["imp"], hits: 1, did: [] } }];
    state.trapSeen = [{ id: "5:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "trapSeen", by: ["thorn", "imp"], message: "Click." } }];
    assert.equal(projectEntity(keys.trapLog("4:0"), state, P1, { sceneId: "s1" }), null);
    assert.deepEqual(projectEntity(keys.trapLog("4:0"), state, DM, { sceneId: "s1" }), state.trapLog[0]);
    assert.deepEqual(playerView(state).trapLog, []);
    const seen = { ...state.trapSeen[0]!, data: { type: "trapSeen", by: ["thorn"], message: "Click." } };
    assert.deepEqual(playerView(state).trapSeen, [seen]);
    assert.deepEqual(playerView(state, P2).trapSeen, [seen]);
    assert.deepEqual(playerView(state, DISPLAY).trapSeen, [seen]);
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).trapSeen, state.trapSeen);
    assert.deepEqual(playerView(state).log, [], "no trap line in the shared log");
    const paused = { ...state, meta: { ...state.meta, view: { ...state.meta.view, blackout: true } } };
    assert.deepEqual([playerView(paused).trapSeen, playerView(paused, DISPLAY).trapSeen], [[], []], "none behind a blackout");
    assert.equal(projectEntity(keys.trapSeen("5:0"), paused, P1, { sceneId: "s1" }), null);
    assert.deepEqual(projectState(paused, DM, { sceneId: "s1" }).trapSeen, state.trapSeen);
  });
});

describe("a trap's text in the protocol", () => {
  test("a trap's squares are at most 400 cells, cells two rectangles share counting once", () => {
    const rects = (n: number) => Array.from({ length: n }, (_, i) => ({ x: 0, y: i * 20, w: 20, h: 20 }));
    const base = input("t");
    assert.equal(parses({ t: "trap.create", trap: { ...base, zone: { cells: rects(1) } } }), true);
    assert.equal(parses({ t: "trap.create", trap: { ...base, zone: { cells: rects(2) } } }), false);
    assert.equal(parses({ t: "trap.create", trap: { ...base, zone: { cells: [...rects(1), ...rects(1)] } } }), true);
  });

  test("a wire is 0.5 to 20 cells, its ends on the 1/64 lattice, and a square scene keeps them on corners and edge midpoints", () => {
    const base = input("t");
    const wire = (a: [number, number], b: [number, number]) => parses({ t: "trap.create", trap: { ...base, zone: { wire: { a, b } }, rig: { ...base.rig, on: [] } } });
    assert.equal(wire([1, 1], [1.5, 1]), true);
    assert.equal(wire([1, 1], [1, 1]), false);
    assert.equal(wire([1, 1], [21.5, 1]), false);
    assert.equal(wire([1.3, 1], [3, 1]), false);
    // On the 1/64 lattice since hex grids' H2, where hex corners lie: the reducer keeps a square scene's ends on halves.
    const quarter = { ...base, zone: { wire: { a: [1.25, 1] as [number, number], b: [3, 1] as [number, number] } }, rig: { ...base.rig, on: [] } };
    assert.equal(wire([1.25, 1], [3, 1]), true);
    assert.match(refused(table(), { t: "trap.create", trap: quarter }).message, /corners and edge midpoints/);
  });

  test("uses an op sets are 1 to 99, and no op sets noticedBy or due", () => {
    const base = input("t");
    assert.equal(parses({ t: "trap.create", trap: { ...base, rig: { ...base.rig, usesLeft: 0 } } }), false);
    assert.equal(parses({ t: "trap.create", trap: { ...base, rig: { ...base.rig, noticedBy: "thorn" } } }), false);
    assert.equal(parses({ t: "trap.create", trap: { ...base, rig: { ...base.rig, due: [] } } }), false);
    assert.equal(parses({ t: "trap.update", trapId: "t", patch: { rig: { noticedBy: "thorn" } } }), false);
    assert.equal(parses({ t: "trap.update", trapId: "t", patch: {} }), false);
  });
});
