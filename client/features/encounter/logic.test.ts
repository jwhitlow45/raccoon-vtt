import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InitEntry, LogEntry, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { actor, apply, character, DM, effect, entry, P1, reveal, room, token } from "#shared/testutil.ts";
import {
  addCandidates,
  answersPrompt,
  concentrationPrompt,
  dropIndex,
  entryBatches,
  entryName,
  expiryNotice,
  groupEntries,
  hasStarted,
  hpView,
  onAnotherScene,
  portraitDisposition,
  ownCandidates,
  ownsEntry,
  parseInitiative,
  reorderTie,
  roundHeaderForm,
  rowAc,
  turnOp,
  rollReminder,
  scoreFills,
  sortedEntries,
  stripRows,
  tieRun,
  turnAlert,
  turnMark,
  turnStatus,
  upcoming,
  valueChanges,
  whoseTurn,
} from "./logic.ts";

const ids = (entries: readonly InitEntry[]) => entries.map((e) => e.id);

describe("typing initiative values", () => {
  test("whole numbers, with spaces and signs", () => {
    assert.deepEqual(parseInitiative(" 14 "), { ok: true, value: 14 });
    assert.deepEqual(parseInitiative("+3"), { ok: true, value: 3 });
    assert.deepEqual(parseInitiative("-1"), { ok: true, value: -1 });
    assert.deepEqual(parseInitiative("−2"), { ok: true, value: -2 });
    assert.deepEqual(parseInitiative("-0"), { ok: true, value: 0 });
    assert.ok(Object.is((parseInitiative("-0") as { value: number }).value, 0));
  });

  test("an empty box clears the value", () => {
    assert.deepEqual(parseInitiative(""), { ok: true, value: null });
    assert.deepEqual(parseInitiative("   "), { ok: true, value: null });
  });

  test("anything else is refused with a reason", () => {
    for (const text of ["1.5", "abc", "1d20", "14!", "--3", "1000"]) {
      const parsed = parseInitiative(text);
      assert.equal(parsed.ok, false, text);
    }
    assert.deepEqual(parseInitiative("101"), { ok: false, error: "Use a number from -50 to 100." });
    assert.equal(parseInitiative("-51").ok, false);
    assert.deepEqual(parseInitiative("100"), { ok: true, value: 100 });
    assert.deepEqual(parseInitiative("-50"), { ok: true, value: -50 });
  });

  test("several at once: only changed rows go out, and a group shares one value", () => {
    const current: Record<string, number | null> = { a: 12, g1: null, g2: 7, b: 3 };
    const result = valueChanges(
      [
        { key: "a", entryIds: ["a"], text: "12" },
        { key: "group:goblin", entryIds: ["g1", "g2"], text: "7" },
        { key: "b", entryIds: ["b"], text: "" },
      ],
      (id) => current[id] ?? null,
    );
    assert.deepEqual(result.values, [
      { entryId: "g1", value: 7 },
      { entryId: "b", value: null },
    ]);
    assert.deepEqual(result.errors, {});
  });

  test("several at once: a bad field is reported and the good ones still go out", () => {
    const result = valueChanges(
      [
        { key: "a", entryIds: ["a"], text: "x" },
        { key: "b", entryIds: ["b"], text: "9" },
      ],
      () => null,
    );
    assert.deepEqual(result.values, [{ entryId: "b", value: 9 }]);
    assert.deepEqual(Object.keys(result.errors), ["a"]);
  });
});

describe("grouping identical monsters", () => {
  test("rows sharing a groupKey form one group, in table order", () => {
    const entries = [
      entry("pc", { groupKey: undefined }),
      entry("g1", { groupKey: "goblin" }),
      entry("w", { groupKey: "wolf" }),
      entry("g2", { groupKey: "goblin" }),
      entry("x"),
    ];
    assert.deepEqual(groupEntries(entries), [
      { key: "entry:pc", entryIds: ["pc"] },
      { key: "group:goblin", entryIds: ["g1", "g2"] },
      { key: "group:wolf", entryIds: ["w"] },
      { key: "entry:x", entryIds: ["x"] },
    ]);
  });

  test("a player's projection has no group keys, so every row stands alone", () => {
    assert.deepEqual(groupEntries([entry("a"), entry("b")]).map((g) => g.entryIds), [["a"], ["b"]]);
  });
});

describe("dragging ties", () => {
  const table = sortedEntries([
    entry("a", { value: 15, tieOrder: 0 }),
    entry("b", { value: 12, tieOrder: 1 }),
    entry("c", { value: 12, tieOrder: 2 }),
    entry("d", { value: 12, tieOrder: 3 }),
    entry("e", { value: 8, tieOrder: 4 }),
    entry("n1", { value: null, tieOrder: 5 }),
    entry("n2", { value: null, tieOrder: 6 }),
  ]);

  test("a tie run is the rows around one that share its value", () => {
    assert.deepEqual(tieRun(table, 2), { start: 1, end: 4 });
    assert.deepEqual(tieRun(table, 0), { start: 0, end: 1 });
    assert.deepEqual(tieRun(table, 6), { start: 5, end: 7 });
  });

  test("a move within the tie lists only the tie's rows in their new order", () => {
    assert.deepEqual(reorderTie(table, "d", 1), ["d", "b", "c"]);
    assert.deepEqual(reorderTie(table, "b", 3), ["c", "d", "b"]);
    assert.deepEqual(reorderTie(table, "n2", 5), ["n2", "n1"]);
  });

  test("a drag past a different value stops at the edge of the tie", () => {
    assert.deepEqual(reorderTie(table, "d", 0), ["d", "b", "c"]);
    assert.deepEqual(reorderTie(table, "b", 6), ["c", "d", "b"]);
  });

  test("no move, no op", () => {
    assert.equal(reorderTie(table, "c", 2), null);
    assert.equal(reorderTie(table, "a", 3), null);
    assert.equal(reorderTie(table, "missing", 0), null);
  });

  test("the reducer turns the listed order into tieOrder and leaves other ties alone", () => {
    const state = room({
      encounter: { rev: 0, round: 1, activeEntryId: null, entries: table.map((e) => ({ ...e })) },
    });
    const order = reorderTie(table, "d", 1)!;
    const next = apply(state, { t: "encounter.reorder", entryIds: order });
    const sorted = sortedEntries(next.encounter!.entries);
    assert.deepEqual(ids(sorted), ["a", "d", "b", "c", "e", "n1", "n2"]);
    assert.deepEqual(
      sorted.map((e) => e.tieOrder),
      sorted.map((_, i) => i),
    );

    const back = apply(next, { t: "encounter.reorder", entryIds: reorderTie(sorted, "n2", 5)! });
    assert.deepEqual(ids(sortedEntries(back.encounter!.entries)), ["a", "d", "b", "c", "e", "n2", "n1"]);
  });

  test("the drop index counts the other rows above the pointer", () => {
    const mids = [20, 60, 100, 140];
    assert.equal(dropIndex(mids, 0, 10), 0);
    assert.equal(dropIndex(mids, 0, 70), 1);
    assert.equal(dropIndex(mids, 0, 500), 3);
    assert.equal(dropIndex(mids, 3, 50), 1);
    assert.equal(dropIndex(mids, 3, 0), 0);
    assert.equal(dropIndex(mids, 1, 60), 1);
  });
});

describe("turn banners", () => {
  const rows = [entry("a"), entry("me"), entry("dead"), entry("b")];
  const mine = (e: InitEntry) => e.id === "me";

  test("your turn when the active row is yours", () => {
    assert.equal(turnStatus({ entries: rows, activeEntryId: "me", mine }), "yours");
  });

  test("never up next: the visible order cannot know about a fogged or hidden row in between", () => {
    // In the player's view "me" follows "a", but a goblin under fog may act between them.
    assert.equal(turnStatus({ entries: rows, activeEntryId: "a", mine }), "none");
    assert.equal(turnStatus({ entries: [entry("me"), entry("a"), entry("b")], activeEntryId: "b", mine }), "none");
  });

  test("nothing when someone else acts, or nobody is active", () => {
    assert.equal(turnStatus({ entries: rows, activeEntryId: "b", mine }), "none");
    assert.equal(turnStatus({ entries: rows, activeEntryId: null, mine }), "none");
    assert.equal(turnStatus({ entries: rows, activeEntryId: "gone", mine }), "none");
  });

  test("a banner fires once per turn, quietly on the first look", () => {
    const enc = (activeEntryId: string, round = 1) => ({ round, activeEntryId });
    const first = turnMark(enc("me"), "yours");
    assert.deepEqual(turnAlert(null, first), { kind: "yours", loud: false });
    assert.equal(turnAlert(first, turnMark(enc("me"), "yours")), null);
    assert.deepEqual(turnAlert(turnMark(enc("b"), "none"), turnMark(enc("me"), "yours")), { kind: "yours", loud: true });
    assert.equal(turnAlert(first, turnMark(enc("b"), "none")), null);

    // The same creature's turn in the next round is a new turn.
    assert.deepEqual(turnAlert(first, turnMark(enc("me", 2), "yours")), { kind: "yours", loud: true });
  });
});

describe("whose turn the strip and the tracker name", () => {
  test("a player's projection says whether the fight started, and the DM's view answers from the active row", () => {
    assert.equal(hasStarted({ activeEntryId: null, started: false }), false);
    assert.equal(hasStarted({ activeEntryId: null, started: true }), true);
    assert.equal(hasStarted({ activeEntryId: null }), false);
    assert.equal(hasStarted({ activeEntryId: "a" }), true);
  });

  test("before Start a player reads not started, never another creature's turn", () => {
    assert.deepEqual(whoseTurn({ dm: false, started: false, activeName: null, yours: false }), { name: "Not started", line: "The fight has not started yet" });
    assert.deepEqual(whoseTurn({ dm: true, started: false, activeName: null, yours: false }), { name: "Not started", line: "Press Start for the first turn" });
    assert.deepEqual(whoseTurn({ dm: false, started: true, activeName: null, yours: false }), { name: "Another creature", line: "Another creature's turn" });
    assert.deepEqual(whoseTurn({ dm: false, started: true, activeName: "Thorn", yours: true }), { name: "Thorn", line: "Your turn" });
    assert.deepEqual(whoseTurn({ dm: true, started: true, activeName: "Goblin 2", yours: false }), { name: "Goblin 2", line: "Goblin 2's turn" });
  });
});

describe("the strip", () => {
  const rows = [entry("a"), entry("b"), entry("dead"), entry("c"), entry("d")];
  const skip = (e: InitEntry) => e.id === "dead";

  test("the active row, then the next few in turn order, wrapping and skipping the defeated", () => {
    const r = upcoming({ entries: rows, activeEntryId: "b", count: 3, fromTop: false, skip });
    assert.equal(r.current?.id, "b");
    assert.deepEqual(ids(r.next), ["c", "d", "a"]);
  });

  test("never lists the active row twice", () => {
    const r = upcoming({ entries: rows.slice(0, 2), activeEntryId: "a", count: 5, fromTop: false, skip });
    assert.deepEqual(ids(r.next), ["b"]);
  });

  test("with no active row, the DM sees who starts and a player sees nobody", () => {
    assert.deepEqual(ids(upcoming({ entries: rows, activeEntryId: null, count: 2, fromTop: true, skip }).next), ["a", "b"]);
    const player = upcoming({ entries: rows, activeEntryId: null, count: 2, fromTop: false, skip });
    assert.equal(player.current, null);
    assert.deepEqual(player.next, []);
  });
});

describe("whose row it is", () => {
  function state(): RoomState {
    const s = room();
    s.characters.c1 = character("c1", { ownerIds: ["p1"], name: "Thorn" });
    s.tokens.pc = token("pc", { kind: "pc", name: "Thorn", actor: { ref: "c1" } });
    s.tokens.familiar = token("familiar", { kind: "npc", name: "Owl", ownerIds: ["p1"] });
    s.tokens.gob = token("gob", { name: "Goblin", number: 2 });
    return s;
  }

  test("through the token, its character, or a character row", () => {
    const s = state();
    assert.equal(ownsEntry(s, "p1", { tokenId: "pc" }), true);
    assert.equal(ownsEntry(s, "p1", { tokenId: "familiar" }), true);
    assert.equal(ownsEntry(s, "p1", { characterId: "c1" }), true);
    assert.equal(ownsEntry(s, "p2", { tokenId: "pc" }), false);
    assert.equal(ownsEntry(s, "p1", { tokenId: "gob" }), false);
    assert.equal(ownsEntry(s, "p1", { tokenId: "missing" }), false);
  });

  test("names come from the view, with numbers for duplicates", () => {
    const s = state();
    assert.equal(entryName(s, { tokenId: "gob" }), "Goblin 2");
    assert.equal(entryName(s, { characterId: "c1" }), "Thorn");
    assert.equal(entryName(s, { tokenId: "elsewhere" }), "Creature on another scene");
    assert.equal(entryName(s, { label: "Lair action" }), "Lair action");
  });

  test("a row whose token this view does not hold, and that has no label, is on another scene", () => {
    const s = state();
    assert.equal(onAnotherScene(s, { tokenId: "elsewhere" }), true);
    assert.equal(onAnotherScene(s, { tokenId: "gob" }), false);
    assert.equal(onAnotherScene(s, { tokenId: "elsewhere", label: "Hidden archer" }), false, "the DM's label names it");
    assert.equal(onAnotherScene(s, { label: "Lair action" }), false);
  });

  test("an unknown creature's picture takes the neutral ring, never the ally's (OP-10)", () => {
    const s = state();
    assert.equal(portraitDisposition(s.tokens.elsewhere, onAnotherScene(s, { tokenId: "elsewhere" })), "neutral");
    assert.equal(portraitDisposition(s.tokens.gob, onAnotherScene(s, { tokenId: "gob" })), s.tokens.gob!.disposition);
    assert.equal(portraitDisposition(undefined, onAnotherScene(s, {})), "ally", "a party member with no token here is an ally");
  });

  test("a player adds only their own creatures that are not in the fight", () => {
    const s = state();
    s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e1", { tokenId: "familiar" })] };
    assert.deepEqual(ownCandidates(s, "p1", "s1").map((t) => t.id), ["pc"]);
    assert.deepEqual(ownCandidates(s, "p2", "s1"), []);
  });
});

describe("adding tokens", () => {
  function scene(): RoomState {
    const s = room();
    s.tokens.a = token("a", { name: "Goblin", number: 1, x: 1, y: 1 });
    s.tokens.b = token("b", { name: "Goblin", number: 2, x: 30, y: 20 });
    s.tokens.hidden = token("hidden", { name: "Assassin", visibility: "dm", x: 1, y: 2 });
    s.tokens.chest = token("chest", { name: "Chest", kind: "object", x: 2, y: 2 });
    s.tokens.exempt = token("exempt", { name: "Giant", fogExempt: true, x: 30, y: 21 });
    s.tokens.other = token("other", { name: "Rat", sceneId: "s2" });
    s.tokens.dead = token("dead", { name: "Goblin", number: 3, actor: { inline: actor({ life: "dead" }) } });
    return s;
  }

  test("every creature on the scene, but not objects, the dead, other scenes or rows already in", () => {
    const s = scene();
    s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e", { tokenId: "a" })] };
    assert.deepEqual(addCandidates(s, "s1", "scene", null).map((t) => t.id), ["hidden", "exempt", "b"]);
  });

  test("visible only leaves out hidden tokens and tokens withheld under the fog", () => {
    const s = scene();
    s.scenes.s1!.fogEnabled = true;
    // Reveal the top-left tile only: a, hidden and chest stand in it, b and the giant in the dark.
    s.fogTiles["s1:0,0"] = { sceneId: "s1", tx: 0, ty: 0, rev: 0, bits: encodeTile(fullTileBits()) };
    assert.deepEqual(addCandidates(s, "s1", "visible", null).map((t) => t.id), ["exempt", "a"]);
    s.scenes.s1!.fogEnabled = false;
    assert.deepEqual(addCandidates(s, "s1", "visible", null).map((t) => t.id), ["exempt", "a", "b"]);
  });

  test("visible only reads the fog players get, explored ground included, and the party's sight on a vision scene", () => {
    const s = scene();
    s.scenes.s1!.fogEnabled = true;
    // The DM's own fog reveals nothing, and the party explored the top-left tile.
    s.exploredTiles = { "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 0, bits: encodeTile(fullTileBits()) } };
    assert.deepEqual(addCandidates(s, "s1", "visible", null).map((t) => t.id), ["exempt", "a"]);

    // A dark scene with party vision: Thorn's torch lights the goblin beside it, and the other one stands in the dark.
    s.scenes.s1!.vision = { on: true, light: "dark" };
    s.tokens.pc = token("pc", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 3, y: 1, light: { bright: 20, dim: 20 } });
    const dmView = projectState(s, DM, { sceneId: "s1" }) as unknown as RoomState;
    assert.deepEqual(addCandidates(dmView, "s1", "visible", null).map((t) => t.id), ["exempt", "a", "pc"]);
  });

  test("the selected token, even an object or a dead one", () => {
    const s = scene();
    assert.deepEqual(addCandidates(s, "s1", "selected", "chest").map((t) => t.id), ["chest"]);
    assert.deepEqual(addCandidates(s, "s1", "selected", "dead").map((t) => t.id), ["dead"]);
    assert.deepEqual(addCandidates(s, "s1", "selected", null), []);
  });

  test("large additions are cut into batches the op accepts", () => {
    let n = 0;
    const tokens = Array.from({ length: 205 }, (_, i) => token(`t${i}`));
    const batches = entryBatches(tokens, () => `id${n++}`);
    assert.deepEqual(batches.map((b) => b.length), [100, 100, 5]);
    assert.deepEqual(batches[0]![0], { id: "id0", tokenId: "t0" });
  });

  test("initiative scores fill monster rows that have no value yet", () => {
    const s = scene();
    s.tokens.a!.actor = { inline: actor({ initScore: 12 }) };
    s.tokens.b!.actor = { inline: actor({ initScore: 12 }) };
    s.characters.c1 = character("c1", { actor: actor({ initScore: 15 }) });
    s.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" } });
    const entries = [
      entry("ea", { tokenId: "a", value: null }),
      entry("eb", { tokenId: "b", value: 9 }),
      entry("epc", { tokenId: "pc", value: null }),
      entry("ehidden", { tokenId: "hidden", value: null }),
    ];
    assert.deepEqual(scoreFills(s, entries), [{ entryId: "ea", value: 12 }]);
  });
});

describe("what a row shows", () => {
  test("HP as the projection sent it", () => {
    assert.deepEqual(hpView({ life: "alive", effects: [], hp: { cur: 5, max: 10, temp: 2 } }), { kind: "exact", cur: 5, max: 10, temp: 2 });
    assert.deepEqual(hpView({ life: "alive", effects: [], hpBar: 0.45 }), { kind: "bar", fraction: 0.45 });
    assert.deepEqual(hpView({ life: "alive", effects: [], hpLabel: "Bloodied" }), { kind: "label", label: "Bloodied" });
    assert.deepEqual(hpView({ life: "alive", effects: [] }), { kind: "none" });
    assert.deepEqual(hpView({ life: "dead", effects: [] }), { kind: "label", label: "Dead" });
    assert.deepEqual(hpView(undefined), { kind: "none" });
  });

  test("roll reminders from effects, unless the DM set one by hand", () => {
    assert.equal(rollReminder({}, [effect("1", { key: "invisible" })]), "adv");
    assert.equal(rollReminder({}, [effect("1", { key: "surprised" })]), "dis");
    assert.equal(rollReminder({}, [effect("1", { key: "stunned" })]), "dis");
    assert.equal(rollReminder({}, [effect("1", { key: "invisible" }), effect("2", { key: "surprised" })]), undefined);
    assert.equal(rollReminder({ advantage: "adv" }, [effect("1", { key: "surprised" })]), "adv");
    assert.equal(rollReminder({}, undefined), undefined);
  });
});

describe("log prompts", () => {
  const event = (id: string, data: LogEntry["data"]): LogEntry => ({ id, at: "2026-10-12T20:00:00.000Z", kind: "event", ...(data ? { data } : {}) });

  test("a concentration check, but not the notice that concentration ended", () => {
    assert.deepEqual(concentrationPrompt(event("1:0", { type: "concentration", characterId: "c1", dc: 12 })), {
      logId: "1:0",
      target: { characterId: "c1" },
      dc: 12,
    });
    assert.deepEqual(concentrationPrompt(event("2:0", { type: "concentration", tokenId: "t1" })), { logId: "2:0", target: { tokenId: "t1" } });
    assert.equal(concentrationPrompt(event("3:0", { type: "concentration", characterId: "c1", ended: true, spell: "Bless" })), null);
    assert.equal(concentrationPrompt(event("4:0", { type: "encounter", action: "start" })), null);
  });

  test("the owner answers, or the DM for creatures no player owns", () => {
    const s = room();
    s.characters.c1 = character("c1", { ownerIds: ["p1"] });
    s.tokens.gob = token("gob");
    const pc = { logId: "1", target: { characterId: "c1" } };
    const monster = { logId: "2", target: { tokenId: "gob" } };
    assert.equal(answersPrompt(s, { memberId: "p1", role: "player" }, pc), true);
    assert.equal(answersPrompt(s, { memberId: "p2", role: "player" }, pc), false);
    assert.equal(answersPrompt(s, DM, pc), false);
    assert.equal(answersPrompt(s, DM, monster), true);
    assert.equal(answersPrompt(s, { memberId: "p1", role: "player" }, monster), false);
  });

  test("expired effects become notices", () => {
    assert.deepEqual(expiryNotice(event("5:1", { type: "effect", tokenId: "t1", key: "blessed", action: "expire" })), {
      logId: "5:1",
      target: { tokenId: "t1" },
      key: "blessed",
    });
    assert.equal(expiryNotice(event("5:2", { type: "effect", tokenId: "t1", key: "blessed", action: "add" })), null);
  });
});

describe("the initiative strip's rows", () => {
  test("the DM sees who acts and who comes next, and a player only who acts", () => {
    const entries = sortedEntries([entry("a", { value: 20 }), entry("b", { value: 15, tieOrder: 1 }), entry("c", { value: 10, tieOrder: 2 })]);
    const skip = () => false;
    const dm = stripRows({ dm: true, entries, activeEntryId: "a", count: 3, skip });
    assert.deepEqual([dm.current?.id, ids(dm.next)], ["a", ["b", "c"]]);
    const player = stripRows({ dm: false, entries, activeEntryId: "a", count: 3, skip });
    assert.deepEqual([player.current?.id, ids(player.next)], ["a", []]);
    // Before Start, or while a creature the player cannot see acts, a player's strip names nobody.
    assert.deepEqual(stripRows({ dm: false, entries, activeEntryId: null, count: 3, skip }), { current: null, next: [] });
    assert.deepEqual(ids(stripRows({ dm: true, entries, activeEntryId: null, count: 2, skip }).next), ["a", "b"]);
  });
});

describe("the turn a press ends", () => {
  const at = (activeEntryId: string | null, ...pending: ClientOp[]) => ({
    view: { encounter: { rev: 0, round: 2, activeEntryId, entries: [] } },
    pending: pending.map((op) => ({ op })),
  });
  const turn = (entry: string | null, round = 2) => ({ entry, round });

  test("names the turn on screen by row and round, or none before the first", () => {
    assert.deepEqual(turnOp("encounter.next", at("a")), { t: "encounter.next", from: turn("a") });
    assert.deepEqual(turnOp("encounter.prev", at("b")), { t: "encounter.prev", from: turn("b") });
    assert.deepEqual(turnOp("encounter.next", at(null)), { t: "encounter.next", from: turn(null) });
    assert.deepEqual(turnOp("encounter.next", { view: { encounter: null }, pending: [] }), { t: "encounter.next", from: turn(null, 1) });
    assert.deepEqual(turnOp("encounter.next", { view: null, pending: [] }), { t: "encounter.next", from: turn(null, 1) });
  });

  test("a second press while the first waits repeats it, so a double tap moves the turn once", () => {
    // The first press already shows the goblin's turn on this device.
    assert.deepEqual(turnOp("encounter.next", at("goblin", { t: "encounter.next", from: turn("ayla") })), { t: "encounter.next", from: turn("ayla") });
    assert.deepEqual(turnOp("encounter.prev", at("ayla", { t: "encounter.prev", from: turn("goblin") })), { t: "encounter.prev", from: turn("goblin") });
    // A lone combatant's next turn has the same row, so the round tells the press apart.
    assert.deepEqual(turnOp("encounter.next", at("solo", { t: "encounter.next", from: turn("solo", 1) })), { t: "encounter.next", from: turn("solo", 1) });
    // Other ops in between do not part the two presses.
    assert.deepEqual(turnOp("encounter.next", at("goblin", { t: "encounter.next", from: turn("ayla") }, { t: "token.move", tokenId: "t", x: 1, y: 1 })), { t: "encounter.next", from: turn("ayla") });
  });

  test("a press of the other kind is a change of mind, so it ends the turn on screen", () => {
    assert.deepEqual(turnOp("encounter.prev", at("goblin", { t: "encounter.next", from: turn("ayla") })), { t: "encounter.prev", from: turn("goblin") });
    assert.deepEqual(turnOp("encounter.next", at("ayla", { t: "encounter.next", from: turn("ayla") }, { t: "encounter.prev", from: turn("goblin") })), { t: "encounter.next", from: turn("ayla") });
    // A press stored before the field, or sent by an older page, names no turn to repeat.
    assert.deepEqual(turnOp("encounter.next", at("goblin", { t: "encounter.next" })), { t: "encounter.next", from: turn("goblin") });
  });
});

describe("a player's own row acting out of their view", () => {
  test("shows them neither End Turn nor Your turn", () => {
    for (const hide of ["row", "scene"] as const) {
      const state = room({
        characters: { c1: character("c1", { ownerIds: ["p1"] }) },
        tokens: { pc: token("pc", { kind: "pc", actor: { ref: "c1" } }), g1: token("g1") },
        encounter: { rev: 0, round: 1, activeEntryId: "e-pc", entries: [entry("e-pc", { tokenId: "pc", value: 15, hidden: hide === "row" }), entry("e-g1", { tokenId: "g1", value: 10 })] },
      });
      if (hide === "scene") state.tokens.pc!.sceneId = "s2";
      const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
      const encounter = view.encounter!;
      assert.equal(encounter.activeEntryId, null, hide);
      assert.equal(turnStatus({ entries: encounter.entries, activeEntryId: encounter.activeEntryId, mine: (e) => ownsEntry(view, "p1", e) }), "none", hide);
      // The press the page would send names no turn of the player's, so the server's answer moves nothing.
      assert.deepEqual(turnOp("encounter.next", { view, pending: [] }).from, { entry: null, round: 1 });
    }
  });
});

describe("a hidden creature revealed on its turn", () => {
  test("players read another creature's turn while it stands in the fog, and its name once it walks into view", () => {
    let state = room({
      characters: { c1: character("c1", { ownerIds: ["p1"] }) },
      tokens: { pc: token("pc", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 }), lurker: token("lurker", { name: "Lurker", x: 20, y: 20, visibility: "dm" }) },
    });
    state.scenes.s1!.fogEnabled = true;
    reveal(state, "s1", { x: 0, y: 0, w: 6, h: 6 });
    const line = () => {
      const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
      const encounter = view.encounter!;
      const active = encounter.entries.find((e) => e.id === encounter.activeEntryId);
      return whoseTurn({ dm: false, started: hasStarted(encounter), activeName: active ? entryName(view, active) : null, yours: false }).line;
    };
    state = apply(state, { t: "encounter.start", entries: [{ id: "e-pc", tokenId: "pc", value: 20 }, { id: "e-l", tokenId: "lurker", value: 10 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "encounter.next" }, DM, 3);
    assert.equal(state.tokens.lurker!.visibility, "all", "revealed");
    assert.equal(line(), "Another creature's turn");
    state = apply(state, { t: "token.move", tokenId: "lurker", x: 3, y: 3 }, DM, 4);
    assert.equal(line(), "Lurker's turn");
  });
});

describe("the round header's form (docs/design-v1-combat-flow.md 3.1)", () => {
  test("full and sticky from three full headers, compact from three 44 px rows, and scrolling with the list below that", () => {
    const forms = [111, 131, 132, 147, 167, 168, 169, 223, 400].map((px) => [px, roundHeaderForm(px, 56)]);
    assert.deepEqual(forms, [
      [111, "static"],
      [131, "static"],
      [132, "compact"],
      [147, "compact"],
      [167, "compact"],
      [168, "full"],
      [169, "full"],
      [223, "full"],
      [400, "full"],
    ]);
  });

  test("the side panel's taller header asks for more room before it sticks in full", () => {
    assert.equal(roundHeaderForm(203, 68), "compact");
    assert.equal(roundHeaderForm(204, 68), "full");
    assert.equal(roundHeaderForm(0, 56), "static", "a hidden pane measures 0");
  });
});

describe("the AC a row shows (docs/design-v1-combat-flow.md 3.3)", () => {
  test("whatever AC the viewer's copy holds, above 0, alive, and with HP to show", () => {
    assert.equal(rowAc(actor({ ac: 15 })), 15);
    assert.equal(rowAc({ life: "alive", effects: [], hpLabel: "Healthy" }), null, "a player's copy of a monster holds no AC");
    assert.equal(rowAc(actor({ ac: 0 })), null);
    assert.equal(rowAc(actor({ ac: 15, life: "dead" })), null, "a corpse's AC answers nothing");
    assert.equal(rowAc(actor({ ac: 15, hp: { cur: 0, max: 0, temp: 0 } })), null, "a creature at max HP 0");
    assert.equal(rowAc(actor({ ac: 13 }), { kind: "object", companion: { of: "c1", turn: "none" } }), null, "an effect");
    assert.equal(rowAc(actor({ ac: 13 }), { kind: "npc", companion: { of: "c1", turn: "shared" } }), 13, "a creature companion");
    assert.equal(rowAc(undefined), null);
  });
});
