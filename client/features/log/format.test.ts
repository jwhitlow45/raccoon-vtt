import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry, Member, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { createFixtureState, FIXTURE_IDS } from "../../dev/fixture.ts";
import { chatTargets, composerTarget, creatureName, describeEvent, mergeLog, messageOp, whisperHeading } from "./format.ts";

const { dm, thorn, vex } = FIXTURE_IDS;

function fixture(): RoomState {
  return createFixtureState({ fog: "off", blackout: false });
}

function playerView(state: RoomState, memberId: string): RoomState {
  return projectState(state, { memberId, role: "player" }, { sceneId: null }) as unknown as RoomState;
}

const member = (id: string, name: string, kind: Member["kind"]): Member => ({ id, rev: 1, name, color: "#ffffff", kind, createdAt: "" });

describe("event text", () => {
  test("names come from the viewer's own projection", () => {
    const state = fixture();
    const giant = Object.values(state.tokens).find((t) => t.name === "Stone giant")!;
    const event = { type: "hp" as const, tokenId: giant.id, change: "damage" as const, label: "Healthy" as const };
    assert.equal(describeEvent(event, state), "Stone giant takes damage (Healthy).");
    assert.equal(describeEvent(event, playerView(state, thorn)), "Huge figure takes damage (Healthy).");
  });

  test("numbered duplicates and characters", () => {
    const state = fixture();
    const goblin = Object.values(state.tokens).find((t) => t.name === "Goblin" && t.number === 1)!;
    assert.equal(creatureName(state, { tokenId: goblin.id }), "Goblin 1");
    assert.equal(creatureName(state, { characterId: FIXTURE_IDS.vexChar }), "Vex");
  });

  test("a creature this view does not hold stays anonymous", () => {
    const state = fixture();
    const hidden = Object.values(state.tokens).find((t) => t.visibility === "dm")!;
    const view = playerView(state, thorn);
    assert.equal(creatureName(view, { tokenId: hidden.id }), "A creature");
  });

  test("numbers appear only when the event kept them", () => {
    const state = fixture();
    const target = { characterId: FIXTURE_IDS.thornChar };
    assert.equal(describeEvent({ type: "hp", ...target, change: "damage", amount: 7, crit: true, label: "Bloodied" }, state), "Thorn takes 7 damage from a Critical Hit (Bloodied).");
    assert.equal(describeEvent({ type: "hp", ...target, change: "heal", label: "Healthy" }, state), "Thorn regains HP (Healthy).");
    assert.equal(describeEvent({ type: "hp", ...target, change: "set", amount: 12 }, state), "Thorn's HP is set to 12.");
    assert.equal(describeEvent({ type: "hp", ...target, change: "temp", amount: 5 }, state), "Thorn gains 5 Temporary HP.");
    // With the numbers, the line says what was left, and the label only when it adds Dying or Dead.
    const left = (cur: number, temp = 0) => ({ cur, max: 7, temp });
    assert.equal(describeEvent({ type: "hp", ...target, change: "damage", amount: 4, label: "Bloodied", left: left(3) }, state), "Thorn takes 4 damage, 3/7 left.");
    assert.equal(describeEvent({ type: "hp", ...target, change: "damage", amount: 9, label: "Dying", left: left(0) }, state), "Thorn takes 9 damage, 0/7 left (Dying).");
    assert.equal(describeEvent({ type: "hp", ...target, change: "heal", amount: 2, label: "Healthy", left: left(5, 3) }, state), "Thorn regains 2 HP, 5/7 +3 temp now.");
    assert.equal(describeEvent({ type: "hp", ...target, change: "set", amount: 6, label: "Healthy", left: left(6) }, state), "Thorn's HP is set to 6/7.");
    assert.equal(
      describeEvent({ type: "hp", ...target, change: "damage", amount: 4, back: true, label: "Healthy", left: left(7) }, state),
      "The DM took back 4 damage to Thorn, 7/7 now.",
    );
    assert.equal(describeEvent({ type: "hp", ...target, change: "heal", back: true, label: "Bloodied" }, state), "The DM took back healing on Thorn (Bloodied).");
    assert.equal(describeEvent({ type: "rest", ...target, kind: "long", label: "Healthy", left: left(7) }, state), "Thorn finishes a Long Rest, 7/7 now.");
    assert.equal(describeEvent({ type: "rest", ...target, kind: "short", amount: 3, label: "Healthy", left: left(6) }, state), "Thorn finishes a Short Rest and regains 3 HP, 6/7 now.");
    assert.equal(describeEvent({ type: "rest", ...target, kind: "short", label: "Bloodied" }, state), "Thorn finishes a Short Rest (Bloodied).");
    assert.equal(describeEvent({ type: "concentration", ...target, dc: 10, spell: "Bless" }, state), "Thorn makes a DC 10 Constitution save to keep concentrating on Bless.");
    assert.equal(describeEvent({ type: "concentration", ...target, spell: "Bless" }, state), "Thorn makes a Constitution save to keep concentrating on Bless.");
    assert.equal(describeEvent({ type: "concentration", ...target, ended: true }, state), "Thorn loses Concentration.");
    // Only the DM's log holds lines about a condition hidden from players, and it says so.
    assert.equal(describeEvent({ type: "effect", ...target, key: "poisoned", action: "add", hidden: true }, state), "Thorn gains Poisoned (hidden from players).");
    assert.equal(describeEvent({ type: "concentration", ...target, ended: true, hidden: true }, state), "Thorn loses Concentration (hidden from players).");
  });

  test("life, effects and death saves", () => {
    const state = fixture();
    const target = { characterId: FIXTURE_IDS.thornChar };
    assert.equal(describeEvent({ type: "life", ...target, life: "dying" }, state), "Thorn is dying.");
    assert.equal(describeEvent({ type: "life", ...target, life: "alive" }, state), "Thorn is back on their feet.");
    assert.equal(describeEvent({ type: "effect", ...target, key: "poisoned", action: "add" }, state), "Thorn gains Poisoned.");
    assert.equal(describeEvent({ type: "effect", ...target, key: "hunters-mark", action: "expire" }, state), "Hunter’s Mark ends on Thorn.");
    assert.equal(describeEvent({ type: "effect", ...target, key: "concentrating", spell: "Bless", action: "add" }, state), "Thorn is concentrating on Bless.");
    assert.equal(describeEvent({ type: "effect", ...target, key: "custom", action: "remove" }, state), "Thorn loses a custom effect.");
    assert.equal(describeEvent({ type: "deathSave", ...target, ok: 1, fail: 2 }, state), "Thorn's Death Saving Throws: 1 success, 2 failures.");
  });

  test("turns, encounters, handouts and members", () => {
    const state = fixture();
    assert.equal(describeEvent({ type: "turn", entryId: "i-owl", round: 3 }, state), "Round 3: Owlbear's turn.");
    assert.equal(describeEvent({ type: "turn", entryId: "gone", round: 3 }, state), "Round 3: another creature's turn.");
    assert.equal(describeEvent({ type: "turn", entryId: "i-owl", round: 3, back: true }, state), "Round 3: the DM took back Owlbear's turn.");
    assert.equal(describeEvent({ type: "encounter", action: "start" }, state), "Combat starts.");
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "a", title: "The map", to: "all", shownAt: "" };
    assert.equal(describeEvent({ type: "handout", handoutId: "h1" }, state), "The DM shows a handout: The map.");
    assert.equal(describeEvent({ type: "handout", handoutId: "h2" }, state), "The DM shows a handout.");
    assert.equal(describeEvent({ type: "member", memberId: vex, action: "dm" }, state), "Vex is now a DM.");
    assert.equal(describeEvent({ type: "member", memberId: "nobody", action: "join" }, state), "Someone joins the room.");
  });
});

describe("whispers", () => {
  const members: Record<string, Member> = {
    [dm]: member(dm, "DM", "dm"),
    co: member("co", "Ana", "dm"),
    [thorn]: member(thorn, "Thorn", "player"),
    [vex]: member(vex, "Vex", "player"),
  };

  test("a player can write to everyone, the DM, or one other player", () => {
    assert.deepEqual(
      chatTargets(members, thorn).map((t) => t.label),
      ["Everyone", "The DM (whisper)", "Vex (whisper)"],
    );
  });

  test("a sole DM is not offered a whisper to the DM", () => {
    const solo = { [dm]: members[dm], [thorn]: members[thorn] };
    assert.deepEqual(
      chatTargets(solo, dm).map((t) => t.label),
      ["Everyone", "Thorn (whisper)"],
    );
  });

  test("a whisper to the DM reaches every DM member, never the sender", () => {
    assert.deepEqual(messageOp({ kind: "dm" }, "psst", members, thorn), { t: "log.whisper", to: [dm, "co"], text: "psst" });
    assert.deepEqual(messageOp({ kind: "dm" }, "psst", members, dm), { t: "log.whisper", to: ["co"], text: "psst" });
    const solo = { [dm]: members[dm], [thorn]: members[thorn] };
    assert.equal(messageOp({ kind: "dm" }, "psst", solo, dm), null);
  });

  test("a whisper to one player, and chat to everyone", () => {
    assert.deepEqual(messageOp({ kind: "member", memberId: vex }, "hi", members, thorn), { t: "log.whisper", to: [vex], text: "hi" });
    assert.equal(messageOp({ kind: "member", memberId: thorn }, "hi", members, thorn), null);
    assert.equal(messageOp({ kind: "member", memberId: "gone" }, "hi", members, thorn), null);
    assert.deepEqual(messageOp({ kind: "all" }, "hi", members, thorn), { t: "log.chat", text: "hi" });
  });

  test("a whisper draft whose recipient leaves never turns into chat for everyone", () => {
    const solo = { [dm]: members[dm], [thorn]: members[thorn] };
    const before = composerTarget(chatTargets(members, dm), "dm", members);
    assert.equal(before.gone, false);
    // The only other DM was demoted while the draft waited.
    const after = composerTarget(chatTargets(solo, dm), "dm", solo);
    assert.deepEqual(after, { gone: true, label: "The DM (nobody else is DM now)" });
    const removed = composerTarget(chatTargets(solo, dm), `m:${vex}`, solo);
    assert.deepEqual(removed, { gone: true, label: "A player who left" });
    assert.deepEqual(composerTarget(chatTargets(solo, dm), "all", solo), { gone: false, target: { kind: "all" }, label: "Everyone" });
  });

  test("headings from each side", () => {
    assert.equal(whisperHeading({ from: thorn, to: [dm, "co"] }, members, thorn), "Whisper to the DM");
    assert.equal(whisperHeading({ from: thorn, to: [dm, "co"] }, members, dm), "Whisper to the DM");
    assert.equal(whisperHeading({ from: thorn, to: [vex] }, members, thorn), "Whisper to Vex");
    assert.equal(whisperHeading({ from: dm, to: [vex] }, members, vex), "Whisper to you");
    assert.equal(whisperHeading({ from: dm, to: [thorn, vex] }, members, vex), "Whisper to you and Thorn");
    assert.equal(whisperHeading({ from: "co", to: [thorn, vex, dm] }, members, dm), "Whisper to you, Thorn and Vex");
  });

  test("players never see a whisper between others, and the DM sees one only as a recipient", () => {
    const state = fixture();
    state.log.push({ id: "9:0", at: "", kind: "whisper", from: thorn, to: [vex], text: "secret" });
    const ids = (s: RoomState) => s.log.map((e) => e.id);
    assert.ok(ids(playerView(state, vex)).includes("9:0"));
    assert.ok(ids(playerView(state, thorn)).includes("9:0"));
    const dmView = projectState(state, { memberId: dm, role: "dm" }, { sceneId: FIXTURE_IDS.cave }) as unknown as RoomState;
    assert.ok(!ids(dmView).includes("9:0"));
    assert.ok(ids(dmView).includes("3:0"));
  });
});

describe("older pages", () => {
  const entry = (id: string): LogEntry => ({ id, at: "", kind: "chat", text: id });

  test("joins the archive to the live tail in id order without duplicates", () => {
    const merged = mergeLog([entry("8:0"), entry("10:1"), entry("10:0")], [entry("10:1"), entry("11:0")]);
    assert.deepEqual(
      merged.map((e) => e.id),
      ["8:0", "10:0", "10:1", "11:0"],
    );
  });
});
