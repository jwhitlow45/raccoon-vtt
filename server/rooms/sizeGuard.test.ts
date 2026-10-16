import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { exploredReserve, NO_ROOM_TO_EXPLORE, serializedBytes } from "#shared/limits.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { sightEntryMaxBytes } from "#shared/rules/vision.ts";
import { actor, character, companionBlock, room, scene, template, token } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";
import { checkWholeScenes, growthBound, SizeGuard } from "./sizeGuard.ts";

const DM: Viewer = { memberId: "dm", role: "dm" };

function applied(state: RoomState, op: Op, seq = 1): { state: RoomState; growth: number } {
  const result = applyOp(state, op, DM, { seq, at: "2026-10-12T00:00:00.000Z" });
  assert.ok(result.ok, result.ok ? "" : result.message);
  return { state: result.state, growth: growthBound(state, result.state, result.touched) };
}

describe("SizeGuard", () => {
  test("refuses a state over the limit and keeps the last exact size", () => {
    const state = room();
    const bytes = serializedBytes(state);
    const guard = new SizeGuard({ stateLimit: bytes + 100, sceneLimit: 1024 * 1024 });
    guard.stateMeasured(bytes);
    // Two ops that may each have added 50 bytes could reach the limit, so the second measures exactly.
    assert.equal(guard.check(state, [], 50).ok, true);
    assert.equal(guard.check(state, [], 50).ok, true);
    const bigger = { ...state, tokens: { t1: token("t1", { name: "x".repeat(200) }) } };
    const refused = guard.check(bigger, ["s1"], growthBound(state, bigger, ["token:t1"]));
    assert.equal(refused.ok, false);
    // The refused state was discarded: the same small state still passes.
    assert.equal(guard.check(state, [], 0).ok, true);
  });

  test("measures UTF-8 bytes, so text past ASCII cannot pass at a third of its size", () => {
    const state = room();
    state.tokens.t1 = token("t1", { name: "梟".repeat(2_000), sceneId: "s1" });
    const units = JSON.stringify(state).length;
    const guard = new SizeGuard({ stateLimit: units + 1_000, sceneLimit: 8 * 1024 * 1024 });
    const refused = guard.check(state, [], 0);
    assert.equal(refused.ok, false);
  });

  test("a projected scene over its limit is refused, other scenes are unaffected", () => {
    const state = room();
    state.tokens.t1 = token("t1", { name: "y".repeat(300), sceneId: "s1" });
    const sceneLimit = serializedBytes(projectState(state, DM, { sceneId: "s2" })) + 100;
    const guard = new SizeGuard({ stateLimit: 8 * 1024 * 1024, sceneLimit });
    const s2 = guard.check(state, ["s2"], 0);
    assert.equal(s2.ok, true);
    const s1 = guard.check(state, ["s1"], 0);
    assert.equal(s1.ok, false);
    if (!s1.ok) assert.match(s1.message, /scene/);
  });

  test("an op that writes far more than its frame carries is measured exactly, for the room and the scene", () => {
    const before = room();
    before.scenes.s1 = { ...before.scenes.s1!, bounds: { w: 200, h: 200 }, fogEnabled: true };
    const reset = applied(before, { t: "fog.reset", sceneId: "s1", to: "revealed" });
    // A one-line op that writes a whole scene of fog tiles, more than one 64 KiB frame could ever carry.
    assert.ok(reset.growth > 64 * 1024, `the reset wrote ${reset.growth} bytes`);
    assert.ok(reset.growth >= serializedBytes(reset.state) - serializedBytes(before));

    const roomBytes = serializedBytes(before);
    const roomGuard = new SizeGuard({ stateLimit: roomBytes + 70_000 });
    roomGuard.stateMeasured(roomBytes);
    assert.equal(roomGuard.check(reset.state, ["s1"], reset.growth).ok, false);

    const sceneBytes = serializedBytes(projectState(before, DM, { sceneId: "s1" }));
    const sceneGuard = new SizeGuard({ sceneLimit: sceneBytes + 70_000 });
    assert.equal(sceneGuard.check(before, ["s1"], 0).ok, true);
    const scene = sceneGuard.check(reset.state, ["s1"], reset.growth);
    assert.equal(scene.ok, false);
    if (!scene.ok) assert.match(scene.message, /scene/);
  });

  test("a token moved into another scene counts in full toward it, with the areas attached to it", () => {
    const before = room();
    before.tokens.t1 = token("t1", { name: "Owlbear".repeat(40), sceneId: "s1" });
    before.templates.a1 = template("a1", { sceneId: "s1", attachedTo: "t1", label: "Moonbeam".repeat(40) });
    const moved = applied(before, { t: "token.update", tokenId: "t1", patch: { sceneId: "s2" } });
    assert.equal(moved.state.templates.a1?.sceneId, "s2");
    const s2Before = serializedBytes(projectState(before, DM, { sceneId: "s2" }));
    const s2After = serializedBytes(projectState(moved.state, DM, { sceneId: "s2" }));
    assert.ok(moved.growth >= s2After - s2Before, `bound ${moved.growth}, scene grew ${s2After - s2Before}`);

    // The destination was measured exactly with room to spare for anything but the move.
    const guard = new SizeGuard({ sceneLimit: s2After - 1 });
    assert.equal(guard.check(before, ["s2"], 0).ok, true);
    const refused = guard.check(moved.state, ["s1", "s2"], moved.growth);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.message, /scene/);
  });

  test("the bound covers what an undo restores", () => {
    const start = room();
    start.tokens.t1 = token("t1", { name: "Goblin", sceneId: "s1" });
    start.tokens.t2 = token("t2", { name: "Hobgoblin".repeat(50), sceneId: "s1" });
    const deleted = applyOp(start, { t: "scene.delete", sceneId: "s1" }, DM, { seq: 1, at: "2026-10-12T00:00:00.000Z" });
    assert.ok(deleted.ok && deleted.inverse);
    const restored = applied(deleted.state, { t: "sys.restore", entries: deleted.inverse, from: "undo" }, 2);
    assert.ok(restored.growth >= serializedBytes(restored.state) - serializedBytes(deleted.state));
    assert.ok(restored.growth > 500);
  });
});

describe("SizeGuard's wave 4 reserves (docs/design-v1-maps-vision.md 2.4)", () => {
  const P1: Viewer = { memberId: "p1", role: "player" };

  /** A 200 x 200 vision scene in bright light with a party member, so its sight covers it all. */
  function bright(sceneId: string): RoomState {
    const state = room();
    state.meta.playerSceneId = sceneId;
    state.scenes = { [sceneId]: scene(sceneId, { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "bright" } }) };
    state.characters.c1 = character("c1");
    state.tokens.pc = token("pc", { sceneId, kind: "pc", actor: { ref: "c1" }, x: 100, y: 100 });
    return state;
  }

  test("a vision scene's check adds the most its sight tiles can take, from its own key, and never computes them", () => {
    for (const sceneId of ["0f8fad5b-d9cb-469f-a165-70867728950e", "梟".repeat(64), `"q\\u0001${"\u0007".repeat(40)}`]) {
      const state = bright(sceneId);
      const probe = { ...state, sight: {} } as unknown as RoomState;
      const measured = serializedBytes(projectState(probe, DM, { sceneId }));
      const reserve = 13 * 13 * sightEntryMaxBytes(sceneId);
      const explored = exploredReserve(state);
      const real = { ...visionRules };
      Object.assign(visionRules, {
        partySight: () => {
          throw new Error("the guard computed sight");
        },
      });
      try {
        assert.equal(new SizeGuard({ sceneLimit: measured + reserve + explored }).check(state, [sceneId], 0).ok, true, sceneId.slice(0, 4));
        const refused = new SizeGuard({ sceneLimit: measured + reserve + explored - 1 }).check(state, [sceneId], 0);
        assert.equal(refused.ok, false, sceneId.slice(0, 4));
      } finally {
        Object.assign(visionRules, real);
      }
      // The real tiles, where the party sees everything, fit inside the reserve.
      const withSight = serializedBytes(projectState(state, DM, { sceneId }));
      assert.ok(withSight - measured <= reserve, `${withSight - measured} over ${reserve}`);
      assert.ok(Object.keys(projectState(state, P1, { sceneId }).sight).length > 0);
    }
  });

  test("a scene without vision reserves nothing for sight, and one that is not exploring nothing for its layer", () => {
    const state = bright("s9");
    state.scenes.s9 = { ...state.scenes.s9!, vision: { on: false, light: "bright" } };
    const measured = serializedBytes(projectState(state, DM, { sceneId: "s9" }));
    assert.equal(new SizeGuard({ sceneLimit: measured }).check(state, ["s9"], 0).ok, true);
  });

  test("an op that makes another scene explore is checked with that scene's reserve, and says what to do when only it does not fit", () => {
    const state = bright("s9");
    state.scenes.s8 = scene("s8", { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark" } });
    const moved = { ...state, meta: { ...state.meta, playerSceneId: "s8" } };
    const bytes = serializedBytes(moved);
    const fits = new SizeGuard({ stateLimit: bytes + exploredReserve(moved) });
    assert.equal(fits.check(moved, [], 0, state).ok, true);
    const tight = new SizeGuard({ stateLimit: bytes + exploredReserve(moved) - 1 });
    assert.deepEqual(tight.check(moved, [], 0, state), { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE });
    // The same room for any other op is simply full.
    assert.match((tight.check(moved, [], 0, moved) as { message: string }).message, /^the room is full/);
    // The projected check of the scene that starts exploring runs too, though the op never named it.
    const sceneBytes = serializedBytes(projectState({ ...moved, sight: {} } as unknown as RoomState, DM, { sceneId: "s8" }));
    const sightReserve = 13 * 13 * sightEntryMaxBytes("s8");
    const sceneTight = new SizeGuard({ sceneLimit: sceneBytes + sightReserve + exploredReserve(moved) - 1 });
    assert.deepEqual(sceneTight.check(moved, [], 0, state), { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE });
  });

  test("growth an explore spends is counted, so the next check measures before it could pass the limit", () => {
    const state = room();
    const bytes = serializedBytes(state);
    const guard = new SizeGuard({ stateLimit: bytes + 1_000 });
    guard.stateMeasured(bytes);
    guard.grew(990, ["s1"]);
    const bigger = { ...state, tokens: { t1: token("t1", { name: "x".repeat(1_100) }) } };
    // Twenty bytes of estimated growth would pass the limit, so this measures, and the real state is over it.
    assert.equal(guard.check(bigger, [], 20).ok, false);
  });
});

describe("growthBound's keys (docs/design-v1-maps-vision.md 2.4)", () => {
  test("a new entry counts its collection key as JSON writes it, so an explore's growth is what it takes off the reserve, escaped scene IDs included", () => {
    for (const sceneId of ["0f8fad5b-d9cb-469f-a165-70867728950e", "\u0001".repeat(64), "梟".repeat(64), `"${"\\".repeat(30)}`]) {
      const state = room();
      state.meta.playerSceneId = sceneId;
      state.scenes = { [sceneId]: scene(sceneId, { fogEnabled: true, vision: { on: true, light: "dark" } }) };
      state.characters.c1 = character("c1", { actor: { ...character("c1").actor, senses: "darkvision 30 ft" } });
      state.tokens.pc = token("pc", { sceneId, kind: "pc", actor: { ref: "c1" }, x: 20, y: 5 });
      const op = exploreOp(state);
      assert.ok(op);
      const result = applyOp(state, op, { memberId: "server", role: "dm" }, { seq: 1, at: "2026-10-12T00:00:00.000Z" });
      assert.ok(result.ok);
      const bound = growthBound(state, result.state, result.touched);
      assert.ok(bound >= serializedBytes(result.state) - serializedBytes(state), sceneId.slice(0, 4));
      assert.equal(bound, exploredReserve(state) - exploredReserve(result.state), sceneId.slice(0, 4));
    }
  });
});

describe("SizeGuard's room-level part (docs/design-v1-dm-tools.md 2.4)", () => {
  /** s1 is small, and s2, which nobody views, holds a big token. */
  function twoScenes(): RoomState {
    const state = room();
    state.tokens.big = token("big", { name: "B".repeat(2_000), sceneId: "s2", notes: "n".repeat(3_000) });
    return state;
  }

  function journalOp(bytes: number): Op {
    return { t: "journal.create", page: { id: "pg1", title: "Notes", access: "dm", blocks: [{ id: "abcdefghijkl", text: "x".repeat(bytes) }] } };
  }

  test("a journal edit that would carry the scene nobody views past its limit is refused, and a smaller one passes", () => {
    const state = twoScenes();
    const limit = serializedBytes(projectState(state, DM, { sceneId: "s2" })) + 400;
    for (const [bytes, ok] of [
      [600, false],
      [100, true],
    ] as const) {
      const next = applied(state, journalOp(bytes));
      // A room-level op touches no scene, so it names none: the guard checks the largest scene for it.
      const guard = new SizeGuard({ sceneLimit: limit });
      const check = guard.check(next.state, [], next.growth, state);
      assert.equal(check.ok, ok, `${bytes} bytes`);
      if (!check.ok) assert.match(check.message, /scene/);
    }
  });

  test("the measure is a DM's projection of the scene, exactly, so a room far under the limit is never measured by projecting", () => {
    const state = twoScenes();
    const next = applied(state, journalOp(300)).state;
    for (const sceneId of ["s1", "s2"]) {
      const bytes = serializedBytes(projectState({ ...next, sight: {} } as unknown as RoomState, DM, { sceneId }));
      assert.equal(new SizeGuard({ sceneLimit: bytes }).check(next, [sceneId], 0).ok, true, sceneId);
      assert.equal(new SizeGuard({ sceneLimit: bytes - 1 }).check(next, [sceneId], 0).ok, false, sceneId);
    }
  });

  test("documents of handout pages count, since they ride in every DM snapshot (docs/design-v1-pdf-handouts.md 3.4)", () => {
    const pages = Array.from({ length: 100 }, (_, i) => ({ assetId: `0192f0aa-0000-7000-8000-${String(i).padStart(12, "0")}`, width: 1584, height: 2048 }));
    const next = applied(twoScenes(), { t: "handoutDoc.create", doc: { id: "d1", title: "Strange letter", pages } }).state;
    for (const sceneId of ["s1", "s2"]) {
      const bytes = serializedBytes(projectState({ ...next, sight: {} } as unknown as RoomState, DM, { sceneId }));
      assert.equal(new SizeGuard({ sceneLimit: bytes }).check(next, [sceneId], 0).ok, true, sceneId);
      assert.equal(new SizeGuard({ sceneLimit: bytes - 1 }).check(next, [sceneId], 0).ok, false, sceneId);
    }
  });

  test("every whisper counts, so an op that fits the DM with fewer whispers but not the other is refused", () => {
    const state = room();
    state.members.dm2 = { ...state.members.dm1!, id: "dm2", name: "Second DM" };
    const whisper = (id: string, to: string, text: string) => ({ id, at: "2026-10-14T00:00:00.000Z", kind: "whisper" as const, from: "p1", to: [to], text });
    state.log = [whisper("0:0", "dm1", "w".repeat(900)), whisper("0:1", "dm2", "short")];
    const dm2: Viewer = { memberId: "dm2", role: "dm" };
    const next = applied(state, { t: "log.chat", text: "hello" });
    const fewer = serializedBytes(projectState(next.state, dm2, { sceneId: "s1" }));
    const more = serializedBytes(projectState(next.state, { memberId: "dm1", role: "dm" }, { sceneId: "s1" }));
    assert.ok(more - fewer > 800);
    const guard = new SizeGuard({ sceneLimit: fewer + 100 });
    assert.equal(guard.check(next.state, [], next.growth, state).ok, false);
    // The measure is the most any DM can receive: every whisper, the other DM's short one too.
    const all = more + serializedBytes(state.log[1]) + 1;
    assert.equal(new SizeGuard({ sceneLimit: all }).check(next.state, [], next.growth, state).ok, true);
    assert.equal(new SizeGuard({ sceneLimit: all - 1 }).check(next.state, [], next.growth, state).ok, false);
  });

  test("a scene already over its limit refuses only an op that grows it, so the room's other edits still work", () => {
    const state = twoScenes();
    const limit = serializedBytes(projectState(state, DM, { sceneId: "s2" })) - 10;
    const guard = new SizeGuard({ sceneLimit: limit });
    // A move on s1 grows neither s2 nor the room-level part.
    const moved = applied(state, { t: "token.create", token: { id: "t1", sceneId: "s1", kind: "monster", name: "Rat", size: "tiny", x: 1, y: 1, actor: { inline: actor() } } }, 1);
    assert.equal(guard.check(moved.state, ["s1"], moved.growth, state).ok, true);
    // A chat line grows the room-level part every scene's projection carries.
    const chat = applied(moved.state, { t: "log.chat", text: "hello" }, 2);
    assert.equal(guard.check(chat.state, [], chat.growth, moved.state).ok, false);
    // A deletion on the full scene shrinks it, and passes.
    const gone = applied(chat.state, { t: "token.delete", tokenId: "big" }, 3);
    assert.equal(guard.check(gone.state, ["s2"], gone.growth, chat.state).ok, true);
  });

  test("an edit on a scene already over its limit passes when it does not grow the scene's whole measure, and is refused when it does", () => {
    const state = twoScenes();
    const limit = serializedBytes(projectState(state, DM, { sceneId: "s2" })) - 10;
    const rename = (name: string, seq: number) => applied(state, { t: "token.update", tokenId: "big", patch: { name } }, seq);
    // A shorter name shrinks the scene, which stays over its limit: an edit that frees space must not be refused.
    const shorter = rename("B".repeat(1_980), 1);
    assert.equal(new SizeGuard({ sceneLimit: limit }).check(shorter.state, ["s2"], shorter.growth, state).ok, true);
    // The same length changes nothing, and passes too.
    const same = rename("C".repeat(2_000), 1);
    assert.equal(new SizeGuard({ sceneLimit: limit }).check(same.state, ["s2"], same.growth, state).ok, true);
    // A longer one grows it, and is refused.
    const longer = rename("B".repeat(2_001), 1);
    const refused = new SizeGuard({ sceneLimit: limit }).check(longer.state, ["s2"], longer.growth, state);
    assert.equal(refused.ok, false);
    // The same guard, once it measured the scene over its limit, still lets the next shrinking edit through.
    const guard = new SizeGuard({ sceneLimit: limit });
    assert.equal(guard.check(shorter.state, ["s2"], shorter.growth, state).ok, true);
    const shorterStill = applied(shorter.state, { t: "token.update", tokenId: "big", patch: { name: "B".repeat(1_960) } }, 2);
    assert.equal(guard.check(shorterStill.state, ["s2"], shorterStill.growth, shorter.state).ok, true);
  });

  test("companion blocks ride outside the measure, so with 3 MiB of them a map edit that fits without them passes, and one that does not is refused as before (docs/design-v1-companion-stat-blocks.md 3.4)", () => {
    const state = twoScenes();
    state.characters.c1 = character("c1", { name: "Bree" });
    // The measure counts the blocks' field as empty: it is a DM's projection without them, to the byte.
    const without = serializedBytes(projectState({ ...state, sight: {} } as unknown as RoomState, DM, { sceneId: "s2" }));
    const blocks: RoomState["companionBlocks"] = {};
    for (let i = 0; i < 192; i++) blocks[`b${i}`] = companionBlock(`b${i}`, "c1", { traits: [{ name: "", text: "x".repeat(15_000) }] });
    const heavy = { ...state, companionBlocks: blocks };
    assert.ok(serializedBytes(blocks) > 2.7 * 1024 * 1024, `${serializedBytes(blocks)} bytes of blocks`);
    for (const sceneId of ["s1", "s2"]) {
      const exact = serializedBytes(projectState({ ...state, sight: {} } as unknown as RoomState, DM, { sceneId }));
      assert.equal(new SizeGuard({ sceneLimit: exact }).check(heavy, [sceneId], 0).ok, true, sceneId);
      assert.equal(new SizeGuard({ sceneLimit: exact - 1 }).check(heavy, [sceneId], 0).ok, false, sceneId);
    }
    // A map edit whose scene part fits passes with all those blocks, and a longer one is refused as today.
    const limit = without + 10;
    const fits = applied(heavy, { t: "token.update", tokenId: "big", patch: { name: "B".repeat(2_005) } });
    assert.equal(new SizeGuard({ sceneLimit: limit }).check(fits.state, ["s2"], fits.growth, heavy).ok, true);
    const over = applied(heavy, { t: "token.update", tokenId: "big", patch: { name: "B".repeat(2_011) } });
    const refused = new SizeGuard({ sceneLimit: limit }).check(over.state, ["s2"], over.growth, heavy);
    assert.deepEqual(refused, { ok: false, code: "quota", message: "this scene is at its 0 MiB size limit" });
    // A block save touches no scene and grows no scene's measure, so the scene check never refuses it.
    const { rev: _rev, ...block } = companionBlock("one-more", "c1", { traits: [{ name: "", text: "x".repeat(15_000) }] });
    const saved = applied(heavy, { t: "companionBlock.create", block });
    assert.equal(new SizeGuard({ sceneLimit: without }).check(saved.state, [], saved.growth, heavy).ok, true);
    // The import's whole-room check reads the same measure.
    assert.equal(checkWholeScenes(heavy, without).ok, true);
    assert.equal(checkWholeScenes(heavy, without - 1).ok, false);
  });

  test("an import is checked with the room-level part and every scene, the journal included", () => {
    const state = twoScenes();
    const limit = serializedBytes(projectState(state, DM, { sceneId: "s2" })) + 200;
    assert.equal(checkWholeScenes(state, limit).ok, true);
    const withPage = applied(state, journalOp(400)).state;
    assert.equal(checkWholeScenes(withPage, limit).ok, false);
  });
});
