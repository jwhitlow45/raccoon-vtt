import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkLimits, LIMITS } from "../limits.ts";
import { eventLines } from "../logRings.ts";
import type { JournalPage, Pin, RollRequest, RoomState } from "../model.ts";
import type { Op, RollRequestInput } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, P1, P2, actor, character, effect, env, member, refused, room, token } from "../testutil.ts";
import { derivedId } from "./duplicate.ts";
import { DEPENDED_ON, PARENT_GONE } from "./misc.ts";
import { FINAL, isFinal, NOT_PLAYED } from "./rolls.ts";

/**
 * The wave 5 reducer (docs/design-v1-dm-tools.md): journal pages with
 * secret blocks, map pins, roll requests and their answers, and the group
 * edits of section 3.5, with the member removal, scene deletion, duplicate
 * and restore rules each of them adds.
 */

function run(state: RoomState, op: Op, seq = 1, who = DM): Applied {
  const result = applyOp(state, op, who, env(seq));
  assert.ok(result.ok, `expected ${op.t} to apply, got ${result.ok ? "" : `${result.code}: ${result.message}`}`);
  return result;
}

function undo(state: RoomState, applied: Applied, seq = 50): Applied {
  assert.ok(applied.inverse, "the op has an inverse");
  return run(state, { t: "sys.restore", entries: applied.inverse, from: "undo", deps: true }, seq);
}

const BLOCK = (n: number) => `block${String(n).padStart(7, "0")}`;

function page(overrides: Partial<JournalPage> = {}): JournalPage {
  return {
    id: "pg1",
    rev: 0,
    title: "Old map",
    access: "all",
    blocks: [
      { id: BLOCK(1), text: "The crypt lies north." },
      { id: BLOCK(2), text: "The lich is the innkeeper.", secret: { revealed: false } },
    ],
    ...overrides,
  };
}

function pin(id: string, overrides: Partial<Pin> = {}): Pin {
  return { id, rev: 0, sceneId: "s1", x: 3.5, y: 4.5, color: "#ff8800", visibility: "all", ...overrides };
}

describe("journal pages", () => {
  test("a page is created with its secret blocks hidden, whatever the op says of them", () => {
    const state = room();
    const after = run(state, {
      t: "journal.create",
      page: { id: "pg1", title: "Old map", access: "all", blocks: [{ id: BLOCK(1), text: "North." }, { id: BLOCK(2), text: "Lich.", secret: true }] },
    }).state;
    assert.deepEqual(after.journal.pg1!.blocks, [
      { id: BLOCK(1), text: "North." },
      { id: BLOCK(2), text: "Lich.", secret: { revealed: false } },
    ]);
  });

  test("a saved edit keeps what is revealed, so a draft from before a reveal cannot hide it again, and a new secret starts hidden", () => {
    const state = room({ journal: { pg1: page() } });
    const revealed = run(state, { t: "journal.reveal", pageId: "pg1", blockId: BLOCK(2), revealed: true }).state;
    const edited = run(
      revealed,
      {
        t: "journal.update",
        pageId: "pg1",
        patch: { blocks: [{ id: BLOCK(2), text: "The lich is the innkeeper, Mara.", secret: true }, { id: BLOCK(3), text: "A second secret.", secret: true }] },
      },
      2,
    ).state;
    assert.deepEqual(edited.journal.pg1!.blocks, [
      { id: BLOCK(2), text: "The lich is the innkeeper, Mara.", secret: { revealed: true } },
      { id: BLOCK(3), text: "A second secret.", secret: { revealed: false } },
    ]);
  });

  test("reveal and hide are their own op, undo as a whole-page restore, and are refused once the page changed since", () => {
    const state = room({ journal: { pg1: page() } });
    const revealed = run(state, { t: "journal.reveal", pageId: "pg1", blockId: BLOCK(2), revealed: true });
    assert.equal(revealed.state.journal.pg1!.blocks[1]!.secret?.revealed, true);
    // Revealing again changes nothing, so it is no step at all.
    assert.equal(run(revealed.state, { t: "journal.reveal", pageId: "pg1", blockId: BLOCK(2), revealed: true }, 2).inverse, null);
    const undone = undo(revealed.state, revealed);
    assert.equal(undone.state.journal.pg1!.blocks[1]!.secret?.revealed, false);
    const retitled = run(revealed.state, { t: "journal.update", pageId: "pg1", patch: { title: "Older map" } }, 3).state;
    assert.equal(applyOp(retitled, { t: "sys.restore", entries: revealed.inverse!, from: "undo", deps: true }, DM, env(4)).ok, false);
    assert.equal(refused(state, { t: "journal.reveal", pageId: "pg1", blockId: BLOCK(1), revealed: true }).code, "invalid");
    assert.equal(refused(state, { t: "journal.reveal", pageId: "pg1", blockId: BLOCK(9), revealed: true }).code, "gone");
  });

  test("a page private to a player names a member of the room", () => {
    const state = room();
    const op = (member: string): Op => ({ t: "journal.create", page: { id: "pg1", title: "Note", access: { member }, blocks: [] } });
    assert.equal(run(state, op("p1")).state.journal.pg1!.access instanceof Object, true);
    assert.equal(refused(state, op("nobody")).code, "gone");
  });

  test("deleting a page makes its pins DM only and unlinks them in the same op, and one undo puts both back", () => {
    const state = room({ journal: { pg1: page({ access: { member: "p1" } }) }, pins: { a: pin("a", { pageId: "pg1" }), b: pin("b"), c: pin("c", { pageId: "pg1", sceneId: "s2" }) } });
    const deleted = run(state, { t: "journal.delete", pageId: "pg1" });
    assert.equal(deleted.state.journal.pg1, undefined);
    assert.deepEqual(deleted.state.pins.a, { ...pin("a"), visibility: "dm", rev: 1 });
    assert.deepEqual(deleted.state.pins.c, { ...pin("c", { sceneId: "s2" }), visibility: "dm", rev: 1 });
    assert.equal(deleted.state.pins.b, state.pins.b);
    const undone = undo(deleted.state, deleted).state;
    assert.equal(undone.journal.pg1!.title, "Old map");
    assert.equal(undone.pins.a!.pageId, "pg1");
    assert.equal(undone.pins.a!.visibility, "all");
    assert.equal(undone.pins.c!.pageId, "pg1");
  });

  test("member removal makes a page private to that member the DM's", () => {
    const state = room({ journal: { pg1: page({ access: { member: "p1" } }), pg2: page({ id: "pg2", access: { member: "p2" } }), pg3: page({ id: "pg3" }) } });
    const after = run(state, { t: "sys.memberRemove", memberId: "p1" }).state;
    assert.equal(after.journal.pg1!.access, "dm");
    assert.deepEqual(after.journal.pg2!.access, { member: "p2" });
    assert.equal(after.journal.pg3!.access, "all");
  });

  test("a member made a DM has their private pages made the DM's in the same op, and a room with no pages changes as before", () => {
    const state = room({ journal: { pg1: page({ access: { member: "p1" } }), pg2: page({ id: "pg2", access: { member: "p2" } }) } });
    const promoted = run(state, { t: "sys.memberSetKind", memberId: "p1", kind: "dm" });
    assert.equal(promoted.state.journal.pg1!.access, "dm");
    assert.deepEqual(promoted.state.journal.pg2!.access, { member: "p2" });
    assert.deepEqual(promoted.touched.filter((k) => !k.startsWith("log:")), ["member:p1", "journal:pg1"]);
    // Made a player again, the member gets back nothing: the page stays the DM's.
    assert.equal(run(promoted.state, { t: "sys.memberSetKind", memberId: "p1", kind: "player" }, 2).state.journal.pg1!.access, "dm");
    // A stored kind change in a room with no pages, every room from before wave 5, touches what it always did.
    const plain = run(room(), { t: "sys.memberSetKind", memberId: "p2", kind: "dm" });
    assert.deepEqual(plain.touched, ["member:p2", "log:1:0"]);
  });

  test("the room holds at most 200 pages, 32 KiB each and 1 MiB together", () => {
    const pages: Record<string, JournalPage> = {};
    for (let i = 0; i <= LIMITS.journalPagesPerRoom; i++) pages[`pg${i}`] = page({ id: `pg${i}` });
    assert.equal(checkLimits(room({ journal: pages })).ok, false);
    const big = page({ blocks: Array.from({ length: 9 }, (_, i) => ({ id: BLOCK(i), text: "x".repeat(4_000) })) });
    const check = checkLimits(room({ journal: { pg1: big } }));
    assert.equal(check.ok, false);
    if (!check.ok) assert.match(check.message, /journal page is at most 32 KiB/);
    const many: Record<string, JournalPage> = {};
    for (let i = 0; i < 40; i++) many[`pg${i}`] = page({ id: `pg${i}`, blocks: Array.from({ length: 7 }, (_, j) => ({ id: BLOCK(j), text: "y".repeat(4_000) })) });
    const all = checkLimits(room({ journal: many }));
    assert.equal(all.ok, false);
    if (!all.ok) assert.match(all.message, /MiB of journal pages/);
  });
});

describe("map pins", () => {
  test("a put creates a pin or replaces the one of the same id on its scene, and names only a page that exists", () => {
    const state = room({ journal: { pg1: page() } });
    const put = (overrides: Partial<Pin>): Op => {
      const { rev: _rev, ...input } = pin("a", overrides);
      return { t: "pin.put", pin: input };
    };
    const placed = run(state, put({ pageId: "pg1", label: "Crypt" })).state;
    assert.deepEqual(placed.pins.a, { ...pin("a", { pageId: "pg1", label: "Crypt" }), rev: 1 });
    const moved = run(placed, put({ x: 9, y: 9 }), 2).state;
    assert.equal(moved.pins.a!.x, 9);
    assert.equal(moved.pins.a!.pageId, undefined);
    assert.equal(refused(placed, put({ sceneId: "s2" })).code, "invalid");
    assert.equal(refused(state, put({ pageId: "gone" })).code, "gone");
    assert.equal(refused(state, put({ sceneId: "nowhere" })).code, "gone");
    assert.equal(run(placed, { t: "pin.remove", pinId: "a" }, 3).state.pins.a, undefined);
    assert.equal(refused(state, { t: "pin.remove", pinId: "a" }).code, "gone");
  });

  test("a scene holds at most 200 pins", () => {
    const pins: Record<string, Pin> = {};
    for (let i = 0; i <= LIMITS.pinsPerScene; i++) pins[`p${i}`] = pin(`p${i}`);
    assert.equal(checkLimits(room({ pins }), "s1").ok, false);
    assert.equal(checkLimits(room({ pins }), "s2").ok, true);
  });

  test("a scene's deletion takes its pins, and a duplicate copies them with derived ids and their pages", () => {
    const state = room({ journal: { pg1: page() }, pins: { a: pin("a", { pageId: "pg1" }), b: pin("b", { sceneId: "s2" }) } });
    const copy = run(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: false, drawings: false } }).state;
    const id = derivedId("s3", "a");
    assert.deepEqual(copy.pins[id], { ...pin(id, { pageId: "pg1", sceneId: "s3" }), rev: 1 });
    const deleted = run(state, { t: "scene.delete", sceneId: "s1" }).state;
    assert.equal(deleted.pins.a, undefined);
    assert.ok(deleted.pins.b);
  });

  test("a restore never strands a pin: a page or scene a pin stands on stays, and a pin whose page is gone stays gone", () => {
    const state = room();
    const created = run(state, { t: "journal.create", page: { id: "pg1", title: "Old map", access: "all", blocks: [] } });
    const pinned = run(created.state, { t: "pin.put", pin: { id: "a", sceneId: "s1", x: 1, y: 1, color: "#ff8800", visibility: "all", pageId: "pg1" } }, 2);
    // Undoing the page's creation would leave the pin naming nothing.
    const takeBack = applyOp(pinned.state, { t: "sys.restore", entries: created.inverse!, from: "undo", deps: true }, DM, env(3));
    assert.deepEqual(takeBack.ok ? null : takeBack.message, DEPENDED_ON);
    // A pin put back after its page went would name nothing either.
    const removed = run(pinned.state, { t: "pin.remove", pinId: "a" }, 3);
    const pageGone = run(removed.state, { t: "journal.delete", pageId: "pg1" }, 4).state;
    const back = applyOp(pageGone, { t: "sys.restore", entries: removed.inverse!, from: "undo", deps: true }, DM, env(5));
    assert.deepEqual(back.ok ? null : back.message, PARENT_GONE);
    // A scene a pin stands on is work that depends on it.
    const scene = run(state, { t: "scene.create", scene: { id: "s3", name: "New", bounds: { w: 10, h: 10 } } });
    const onIt = run(scene.state, { t: "pin.put", pin: { id: "b", sceneId: "s3", x: 1, y: 1, color: "#ff8800", visibility: "all" } }, 2);
    const unmake = applyOp(onIt.state, { t: "sys.restore", entries: scene.inverse!, from: "undo", deps: true }, DM, env(3));
    assert.deepEqual(unmake.ok ? null : unmake.message, DEPENDED_ON);
  });
});

describe("roll requests", () => {
  /** p1 plays Thorn (a character) and owns a familiar token. p2 plays Vex. The DM owns a token too. */
  function party(): RoomState {
    const state = room();
    state.members.dm2 = member("dm2", "dm");
    state.characters.thorn = character("thorn", { name: "Thorn", ownerIds: ["p1"] });
    state.characters.vex = character("vex", { name: "Vex", ownerIds: ["p2"] });
    state.characters.npc = character("npc", { name: "Guide", ownerIds: [] });
    state.tokens.thorn = token("thorn", { kind: "pc", actor: { ref: "thorn" }, sceneId: "s1" });
    state.tokens.owl = token("owl", { name: "Owl", ownerIds: ["p1"], sceneId: "s1" });
    state.tokens.away = token("away", { name: "Hawk", ownerIds: ["p1"], sceneId: "s2" });
    state.tokens.goblin = token("goblin", { name: "Goblin", sceneId: "s1" });
    state.tokens.pet = token("pet", { name: "DM's cat", ownerIds: ["dm2"], sceneId: "s1" });
    return state;
  }

  function request(overrides: Partial<RollRequestInput> = {}): RollRequestInput {
    return {
      id: "r1",
      test: { kind: "save", choices: [{ ability: "dex" }] },
      dc: 15,
      dcShown: true,
      resultShown: true,
      targets: [{ characterId: "thorn" }, { characterId: "vex" }, { tokenId: "owl" }],
      ...overrides,
    };
  }

  function asked(overrides: Partial<RollRequestInput> = {}): RoomState {
    return run(party(), { t: "roll.ask", request: request(overrides) }).state;
  }

  const answer = (target: { tokenId: string } | { characterId: string }, rest: { choice?: 0 | 1; total?: number; result?: "pass" | "fail" }): Op => ({ t: "roll.answer", rollId: "r1", target, ...rest });

  test("only creatures a player plays can be asked, and a token only on the players' scene", () => {
    const state = asked();
    assert.deepEqual(state.rolls.r1, {
      id: "r1",
      rev: 1,
      test: { kind: "save", choices: [{ ability: "dex" }] },
      dc: 15,
      dcShown: true,
      resultShown: true,
      at: env(1).at,
      targets: [{ characterId: "thorn" }, { characterId: "vex" }, { tokenId: "owl" }],
    });
    for (const targets of [[{ tokenId: "goblin" }], [{ tokenId: "pet" }], [{ characterId: "npc" }]]) {
      assert.deepEqual(refused(party(), { t: "roll.ask", request: request({ targets }) }), { ok: false, code: "invalid", message: NOT_PLAYED });
    }
    assert.match(refused(party(), { t: "roll.ask", request: request({ targets: [{ tokenId: "away" }] }) }).message, /players' scene/);
    assert.equal(refused(state, { t: "roll.ask", request: request() }).code, "invalid");
  });

  test("at most 20 requests are open at once", () => {
    const rolls: Record<string, RollRequest> = {};
    for (let i = 0; i <= LIMITS.openRollsPerRoom; i++) rolls[`r${i}`] = { ...asked().rolls.r1!, id: `r${i}` };
    const check = checkLimits(room({ rolls }));
    assert.equal(check.ok, false);
  });

  test("a total passes at exactly the DC and fails below it, by the reducer whoever answers", () => {
    let state = asked();
    state = run(state, answer({ characterId: "thorn" }, { total: 15 }), 2, P1).state;
    state = run(state, answer({ characterId: "vex" }, { total: 14 }), 3, P2).state;
    const targets = state.rolls.r1!.targets;
    assert.deepEqual(targets[0], { characterId: "thorn", total: 15, result: "pass", by: "p1" });
    assert.deepEqual(targets[1], { characterId: "vex", total: 14, result: "fail", by: "p2" });
    assert.deepEqual(targets[2], { tokenId: "owl" });
  });

  test("an answer writes a log line with the test and both switches", () => {
    const after = run(asked({ dcShown: false }), answer({ characterId: "thorn" }, { total: 17 }), 2, P1);
    // Only Thorn's players read it, so the line is the DM's, with a copy of what Thorn's player read.
    assert.deepEqual(eventLines(after.log).map((e) => e.data), [{ type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "thorn", total: 17, result: "pass", dc: 15, resultShown: true }]);
  });

  test("with two choices the answer says which was rolled, the first when it says nothing", () => {
    const state = asked({ test: { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] }, dc: undefined });
    const rolled = run(state, answer({ characterId: "thorn" }, { choice: 1, total: 12 }), 2, P1).state;
    assert.deepEqual(rolled.rolls.r1!.targets[0], { characterId: "thorn", choice: 1, total: 12, by: "p1" });
    const first = run(state, answer({ characterId: "thorn" }, { total: 12 }), 2, P1).state;
    assert.equal(first.rolls.r1!.targets[0]!.choice, 0);
    assert.equal(refused(state, answer({ characterId: "thorn" }, { choice: 1 as 0 | 1, result: "pass" })).code, "invalid");
    const one = asked();
    assert.equal(refused(one, answer({ characterId: "thorn" }, { choice: 1, total: 3 }), DM).code, "invalid");
  });

  test("a save may be failed without rolling, which marks the player's own choice and only theirs", () => {
    const state = run(asked(), answer({ characterId: "thorn" }, { result: "fail" }), 2, P1);
    assert.deepEqual(state.state.rolls.r1!.targets[0], { characterId: "thorn", result: "fail", noRoll: true, by: "p1" });
    assert.equal((state.log[0]!.data as { noRoll?: true }).noRoll, true);
    // A DM's bare fail is a mark, not the player's choice.
    const marked = run(asked(), answer({ characterId: "thorn" }, { result: "fail" }), 2, DM).state;
    assert.deepEqual(marked.rolls.r1!.targets[0], { characterId: "thorn", result: "fail", by: "dm1" });
    // A DM overruling it keeps the player's choice beside the new result.
    const overruled = run(state.state, answer({ characterId: "thorn" }, { result: "pass" }), 3, DM).state;
    assert.deepEqual(overruled.rolls.r1!.targets[0], { characterId: "thorn", result: "pass", noRoll: true, by: "dm1" });
    // A reopen clears it into previous, and a total replaces it.
    const reopened = run(state.state, { t: "roll.reopen", rollId: "r1", target: { characterId: "thorn" } }, 3, DM).state;
    assert.deepEqual(reopened.rolls.r1!.targets[0], { characterId: "thorn", previous: { result: "fail", noRoll: true } });
    const rolled = run(state.state, answer({ characterId: "thorn" }, { total: 16 }), 3, P1).state;
    assert.deepEqual(rolled.rolls.r1!.targets[0], { characterId: "thorn", total: 16, result: "pass", by: "p1", previous: { result: "fail", noRoll: true } });
  });

  test("a replaced answer is kept as previous, and on a request with no DC its mark goes with it unless the new answer brings its own", () => {
    let state = asked({ dc: undefined });
    state = run(state, answer({ characterId: "thorn" }, { total: 12 }), 2, P1).state;
    state = run(state, answer({ characterId: "thorn" }, { result: "pass" }), 3, DM).state;
    assert.deepEqual(state.rolls.r1!.targets[0], { characterId: "thorn", total: 12, result: "pass", by: "dm1" });
    // The player's new total replaces the answer the DM marked, so the old pass belongs to the old total.
    const changed = run(state, answer({ characterId: "thorn" }, { total: 17 }), 4, P1).state;
    assert.deepEqual(changed.rolls.r1!.targets[0], { characterId: "thorn", total: 17, by: "p1", previous: { total: 12, result: "pass" } });
    // A result the new answer supplies is kept: a save failed without rolling, or a DM's replacement mark.
    const gaveUp = run(state, answer({ characterId: "thorn" }, { result: "fail" }), 4, P1).state;
    assert.deepEqual(gaveUp.rolls.r1!.targets[0], { characterId: "thorn", result: "fail", noRoll: true, by: "p1", previous: { total: 12, result: "pass" } });
    const dmMark = run(state, answer({ characterId: "thorn" }, { total: 9, result: "fail" }), 4, DM).state;
    assert.deepEqual(dmMark.rolls.r1!.targets[0], { characterId: "thorn", total: 9, result: "fail", by: "dm1", previous: { total: 12, result: "pass" } });
  });

  test("an answer is final once it has a result only when the DC is hidden and pass or fail shown", () => {
    const hidden = run(asked({ dcShown: false }), answer({ characterId: "thorn" }, { total: 12 }), 2, P1).state;
    assert.equal(isFinal(hidden.rolls.r1!, hidden.rolls.r1!.targets[0]!), true);
    assert.deepEqual(refused(hidden, answer({ characterId: "thorn" }, { total: 15 }), P1, 3), { ok: false, code: "forbidden", message: FINAL });
    // The DM can change it, or reopen it for one more answer.
    assert.equal(run(hidden, answer({ characterId: "thorn" }, { result: "pass" }), 3, DM).state.rolls.r1!.targets[0]!.result, "pass");
    const reopened = run(hidden, { t: "roll.reopen", rollId: "r1", target: { characterId: "thorn" } }, 3, DM).state;
    assert.deepEqual(reopened.rolls.r1!.targets[0], { characterId: "thorn", previous: { total: 12, result: "fail" } });
    const again = run(reopened, answer({ characterId: "thorn" }, { total: 16 }), 4, P1).state;
    assert.deepEqual(again.rolls.r1!.targets[0], { characterId: "thorn", total: 16, result: "pass", by: "p1", previous: { total: 12, result: "fail" } });
    assert.equal(refused(again, answer({ characterId: "thorn" }, { total: 1 }), P1, 5).code, "forbidden");
    // With the DC shown, or pass or fail hidden, or no DC, a player changes freely.
    for (const overrides of [{}, { dcShown: false, resultShown: false }, { dc: undefined, dcShown: false }]) {
      const state = run(asked(overrides), answer({ characterId: "thorn" }, { total: 12 }), 2, P1).state;
      assert.equal(run(state, answer({ characterId: "thorn" }, { total: 14 }), 3, P1).state.rolls.r1!.targets[0]!.total, 14);
    }
  });

  test("a reopen of a target that has not answered changes nothing", () => {
    assert.equal(run(asked(), { t: "roll.reopen", rollId: "r1", target: { characterId: "thorn" } }).inverse, null);
  });

  test("close removes one request or several, passing over one already closed", () => {
    let state = asked();
    state = run(state, { t: "roll.ask", request: request({ id: "r2" }) }, 2).state;
    const closed = run(state, { t: "roll.close", rollIds: ["r1", "r2", "gone"] }, 3);
    assert.deepEqual(closed.state.rolls, {});
    const back = undo(closed.state, closed).state;
    assert.deepEqual(Object.keys(back.rolls).sort(), ["r1", "r2"]);
  });

  test("asking undoes as removal while nobody has answered, and not once someone has", () => {
    const ask = run(party(), { t: "roll.ask", request: request() });
    assert.deepEqual(undo(ask.state, ask).state.rolls, {});
    const answered = run(ask.state, answer({ characterId: "thorn" }, { total: 3 }), 2, P1).state;
    assert.equal(applyOp(answered, { t: "sys.restore", entries: ask.inverse!, from: "undo", deps: true }, DM, env(3)).ok, false);
  });

  test("a target not in the request is gone", () => {
    assert.equal(refused(asked(), answer({ characterId: "npc" }, { total: 3 })).code, "gone");
    assert.equal(refused(asked(), { t: "roll.answer", rollId: "r9", target: { characterId: "thorn" }, total: 3 }).code, "gone");
  });
});

describe("group edits (section 3.5)", () => {
  function three(): RoomState {
    const state = room();
    for (const id of ["g1", "g2", "g3"]) state.tokens[id] = token(id, { name: "Goblin", sceneId: "s1" });
    state.tokens.mine = token("mine", { ownerIds: ["p1"], sceneId: "s1" });
    return state;
  }

  test("token.updateMany changes every token alike, applies whole or not at all, and undoes as one step", () => {
    const state = three();
    const hidden = run(state, { t: "token.updateMany", tokenIds: ["g1", "g2", "g3"], patch: { visibility: "dm", locked: true } });
    for (const id of ["g1", "g2", "g3"]) {
      assert.equal(hidden.state.tokens[id]!.visibility, "dm");
      assert.equal(hidden.state.tokens[id]!.locked, true);
    }
    assert.equal(refused(state, { t: "token.updateMany", tokenIds: ["g1", "gone", "g3"], patch: { locked: true } }).code, "gone");
    const undone = undo(hidden.state, hidden).state;
    for (const id of ["g1", "g2", "g3"]) assert.deepEqual(undone.tokens[id], { ...state.tokens[id]!, rev: undone.tokens[id]!.rev });
  });

  test("token.deleteMany deletes each as token.delete does, initiative rows included", () => {
    const state = three();
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [{ id: "e1", tokenId: "g1", value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false }] };
    const gone = run(state, { t: "token.deleteMany", tokenIds: ["g1", "g2"] });
    assert.equal(gone.state.tokens.g1, undefined);
    assert.equal(gone.state.tokens.g2, undefined);
    assert.ok(gone.state.tokens.g3);
    assert.deepEqual(gone.state.encounter?.entries, []);
    const back = undo(gone.state, gone).state;
    assert.ok(back.tokens.g1 && back.tokens.g2);
    assert.equal(back.encounter?.entries.length, 1);
  });

  test("actor.effects adds and removes on several creatures in one step, each as its single op", () => {
    const state = three();
    state.tokens.g3 = token("g3", { actor: { inline: actor({ effects: [effect("x1", { key: "poisoned" })] }) } });
    const op: Op = {
      t: "actor.effects",
      add: [
        { target: { tokenId: "g1" }, effect: { id: "f1", key: "frightened" } },
        { target: { tokenId: "g2" }, effect: { id: "f2", key: "frightened" } },
      ],
      remove: [{ target: { tokenId: "g3" }, effectId: "x1" }],
    };
    const done = run(state, op);
    assert.deepEqual(
      ["g1", "g2", "g3"].map((id) => (done.state.tokens[id]!.actor as { inline: { effects: { key: string }[] } }).inline.effects.map((e) => e.key)),
      [["frightened"], ["frightened"], []],
    );
    assert.equal(refused(state, { t: "actor.effects", remove: [{ target: { tokenId: "g1" }, effectId: "nope" }] }).code, "gone");
    const back = undo(done.state, done).state;
    assert.deepEqual((back.tokens.g3!.actor as { inline: { effects: { key: string }[] } }).inline.effects.map((e) => e.key), ["poisoned"]);
    assert.deepEqual((back.tokens.g1!.actor as { inline: { effects: unknown[] } }).inline.effects, []);
  });
});

describe("the drawing permission and the monster link in the reducer", () => {
  test("member removal drops the member from who may draw, as from who may move any token", () => {
    const state = room();
    state.meta.settings = { ...state.meta.settings, playersDraw: ["p1", "p2"], playersMoveAny: ["p1"] };
    const after = run(state, { t: "sys.memberRemove", memberId: "p1" }).state;
    assert.deepEqual(after.meta.settings.playersDraw, ["p2"]);
    assert.deepEqual(after.meta.settings.playersMoveAny, []);
  });

  test("a stored drawing replays whatever the setting says now: the permission is not the reducer's", () => {
    const state = room();
    state.meta.settings = { ...state.meta.settings, playersDraw: "none" };
    const drawn = run(state, { t: "drawing.create", drawing: { id: "d1", sceneId: "s1", kind: "free", points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } }, 1, P1);
    assert.ok(drawn.state.drawings.d1);
  });

  test("monsterId is attached and detached through the actor patch", () => {
    const state = room({ tokens: { g1: token("g1") } });
    const linked = run(state, { t: "token.update", tokenId: "g1", patch: { actor: { monsterId: "m1" } } }).state;
    assert.equal((linked.tokens.g1!.actor as { inline: { monsterId?: string } }).inline.monsterId, "m1");
    const unlinked = run(linked, { t: "token.update", tokenId: "g1", patch: { actor: { monsterId: null } } }, 2).state;
    assert.equal("monsterId" in (unlinked.tokens.g1!.actor as { inline: object }).inline, false);
  });
});
