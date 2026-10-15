import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RollRequest, RoomState, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, env, P1, room, token } from "#shared/testutil.ts";
import { sheetOpen } from "../../state/types.ts";
import {
  allAnsweredIds,
  answeredCount,
  answerKey,
  askAnswer,
  askLine,
  askOp,
  cameUp,
  cardFoldsUnderSheet,
  chipLine,
  deskLayout,
  finalAnswerText,
  dcText,
  defaultTargets,
  dmAnswerText,
  draftKey,
  emptyDraft,
  finalForPlayer,
  chipStack,
  chipsStayShown,
  foldedChips,
  forgetStaleDrafts,
  lookAtRequests,
  newestFirst,
  offersRequest,
  parseTotal,
  partyCharacters,
  playerNeedsAnswer,
  requestToOpen,
  rollsSummary,
  sheetSummary,
  shownRequest,
  startingAnswer,
  targetName,
  testTitle,
  wantsMark,
  withKind,
  withSkill,
  type AnswerDraft,
} from "./logic.ts";

const P2: Viewer = { memberId: "p2", role: "player" };
const DEX_SAVE = { kind: "save" as const, choices: [{ ability: "dex" as const }] };
const deps = { canUseAsset: () => true };

/** Ayla (p1) on the players' scene, Bram (p2) on another, a DM-owned NPC character, and p1's wolf. */
function setup(): RoomState {
  const state = room({
    characters: {
      ayla: character("ayla", { name: "Ayla", ownerIds: ["p1"], actor: actor({ effects: [{ id: "e1", key: "restrained" }] }) }),
      bram: character("bram", { name: "Bram", ownerIds: ["p2"] }),
      npc: character("npc", { name: "Captain", ownerIds: ["dm1"] }),
    },
    tokens: {
      a1: token("a1", { kind: "pc", name: "Ayla", sceneId: "s1", actor: { ref: "ayla" } }),
      b1: token("b1", { kind: "pc", name: "Bram", sceneId: "s2", actor: { ref: "bram" } }),
      wolf: token("wolf", { name: "Wolf", sceneId: "s1", ownerIds: ["p1"], actor: { inline: actor() } }),
      far: token("far", { name: "Owl", sceneId: "s2", ownerIds: ["p1"], actor: { inline: actor() } }),
      goblin: token("goblin", { name: "Goblin", sceneId: "s1", actor: { inline: actor() } }),
    },
  });
  state.members.p1!.name = "Pat";
  state.members.p2!.name = "Alex";
  return state;
}

function run(state: RoomState, op: ClientOp, who: Viewer = DM, seq = 1): RoomState {
  assert.ok(clientOpSchema.safeParse(op).success, `${op.t} is a valid op`);
  const allowed = canApply(op, who, state, deps);
  assert.ok(allowed.ok, `${op.t}: ${allowed.ok ? "" : allowed.message}`);
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r.state;
}

function ask(state: RoomState, patch: Partial<ReturnType<typeof emptyDraft>> = {}, id = "r1"): RoomState {
  const draft = { ...emptyDraft([{ characterId: "ayla" }, { characterId: "bram" }]), ...patch };
  const check = askOp(draft, id, Object.keys(state.rolls).length);
  assert.ok(check.ok, check.ok ? "" : check.error);
  return run(state, check.op);
}

describe("who a request asks", () => {
  test("the party is every character a player owns, in roster order, and no one else", () => {
    const state = setup();
    assert.deepEqual(partyCharacters(state).map((c) => c.name), ["Bram", "Ayla"], "Alex's before Pat's, as the roster lists them");
  });

  test("Ask the party ticks those on the players' scene and lists the rest unticked, on another scene", () => {
    const targets = defaultTargets(setup(), { kind: "party" });
    assert.deepEqual(
      targets.map((t) => [t.name, t.ticked, t.why ?? ""]),
      [
        ["Bram", false, "on another scene"],
        ["Ayla", true, ""],
      ],
    );
    assert.deepEqual(targets[1]!.ref, { characterId: "ayla" });
  });

  test("from a scene other than the players', Ask the party ticks every party character and calls none of them elsewhere (LP5-ROLLS-2)", () => {
    // The DM looks at s2: their view holds that scene's tokens only.
    const state = setup();
    for (const [id, t] of Object.entries(state.tokens)) if (t?.sceneId !== "s2") delete state.tokens[id];
    assert.deepEqual(
      defaultTargets(state, { kind: "party" }, "s2").map((t) => [t.name, t.ticked, t.why ?? ""]),
      [
        ["Bram", true, ""],
        ["Ayla", true, ""],
      ],
    );
    // From the players' scene the rule of who stands there holds as before.
    assert.deepEqual(
      defaultTargets(setup(), { kind: "party" }, "s1").map((t) => [t.name, t.ticked, t.why ?? ""]),
      [
        ["Bram", false, "on another scene"],
        ["Ayla", true, ""],
      ],
    );
    // A selected token is in view, so a familiar there still cannot be asked off the players' scene, and the rest of the party starts unticked.
    assert.deepEqual(
      defaultTargets(state, { kind: "selection", tokenIds: ["far"] }, "s2").map((t) => [t.name, t.ticked, t.blocked ?? false, t.why ?? ""]),
      [
        ["Owl", false, true, "not on the players’ scene"],
        ["Bram", false, false, ""],
        ["Ayla", false, false, ""],
      ],
    );
  });

  test("from the action bar the selected creatures start ticked, a familiar included, then the rest of the party", () => {
    const state = setup();
    const targets = defaultTargets(state, { kind: "selection", tokenIds: ["wolf", "a1", "goblin", "far"] });
    assert.deepEqual(
      targets.map((t) => [t.name, t.ticked, t.blocked ?? false]),
      [
        ["Wolf", true, false],
        ["Ayla", true, false],
        ["Owl", false, true],
        ["Bram", false, false],
      ],
      "the goblin no player plays is left out, and the owl off the players' scene cannot be asked",
    );
    assert.deepEqual(targets[0]!.ref, { tokenId: "wolf" });
  });

  test("a token a player owns that points at a character only the DM owns is asked by its token, and the request goes through", () => {
    let state = setup();
    // The DM's NPC lent to Pip for a scene, and one lent on another scene.
    state.tokens.cap = token("cap", { kind: "npc", name: "Captain", sceneId: "s1", ownerIds: ["p1"], actor: { ref: "npc" } });
    state.tokens.capFar = token("capFar", { kind: "npc", name: "Captain", sceneId: "s2", ownerIds: ["p1"], actor: { ref: "npc" } });
    const targets = defaultTargets(state, { kind: "selection", tokenIds: ["cap", "capFar", "a1"] });
    assert.deepEqual(
      targets.map((t) => [t.ref, t.ticked, t.blocked ?? false]),
      [
        [{ tokenId: "cap" }, true, false],
        [{ tokenId: "capFar" }, false, true],
        [{ characterId: "ayla" }, true, false],
        [{ characterId: "bram" }, false, false],
      ],
      "only a party character is asked as itself",
    );
    const check = askOp(emptyDraft(targets.filter((t) => t.ticked).map((t) => t.ref)), "r1", 0);
    assert.ok(check.ok);
    state = run(state, check.op);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { tokenId: "cap" }, total: 14 }, P1, 2);
    assert.equal(state.rolls.r1!.targets[0]!.total, 14, "its player answers for it");
  });

  test("a token bar offers Request a roll by the same rule the sheet ticks by", () => {
    const state = setup();
    state.tokens.cap = token("cap", { kind: "npc", name: "Captain", sceneId: "s1", ownerIds: ["p1"], actor: { ref: "npc" } });
    state.tokens.capFar = token("capFar", { kind: "npc", name: "Captain", sceneId: "s2", ownerIds: ["p1"], actor: { ref: "npc" } });
    state.tokens.npcDm = token("npcDm", { kind: "npc", name: "Captain", sceneId: "s1", actor: { ref: "npc" } });
    const offered = (...ids: string[]) => offersRequest(state, ids.map((id) => state.tokens[id]!));
    assert.equal(offered("cap"), true, "the DM's NPC lent to Pip, asked by its token");
    assert.equal(offered("capFar"), false, "the same off the players' scene cannot be asked");
    assert.equal(offered("far"), false, "nor can a familiar there");
    assert.equal(offered("b1"), true, "a party character is asked as itself, wherever its token stands");
    assert.equal(offered("npcDm", "goblin"), false, "no player plays either");
    assert.equal(offered("goblin", "cap"), true, "one askable creature in a group is enough");
  });
});

describe("the DM's sheet", () => {
  test("a skill fills in its usual ability, which the DM can still change, and a save drops skills", () => {
    const athletics = withSkill({ ability: "dex" }, "athletics");
    assert.deepEqual(athletics, { ability: "str", skill: "athletics" });
    assert.deepEqual(withSkill(athletics, "athletics"), { ability: "str" }, "picked again, it clears");
    const draft = { ...emptyDraft([{ characterId: "ayla" }]), kind: "check" as const, choices: [{ ability: "dex" as const, skill: "athletics" as const }, { ability: "dex" as const, skill: "acrobatics" as const }] };
    const save = withKind(draft, "save");
    assert.deepEqual(save.choices, [{ ability: "dex" }], "two choices that become the same keep one");
    const check = askOp(draft, "r1", 0);
    assert.ok(check.ok);
    assert.deepEqual(check.op.request.test.choices, draft.choices);
  });

  test("both switches start on, the DC is optional, and what to fix is said in words", () => {
    const draft = emptyDraft([{ characterId: "ayla" }]);
    assert.equal(draft.dcShown, true);
    assert.equal(draft.resultShown, true);
    const none = askOp(draft, "r1", 0);
    assert.ok(none.ok);
    assert.equal("dc" in none.op.request, false);
    const fifteen = askOp({ ...draft, dc: "15", note: "  against   the poison " }, "r1", 0);
    assert.ok(fifteen.ok);
    assert.equal(fifteen.op.request.dc, 15);
    assert.equal(fifteen.op.request.note, "against the poison");
    assert.equal(askOp({ ...draft, dc: "51" }, "r1", 0).ok, false);
    assert.equal(askOp({ ...draft, dc: "1.5" }, "r1", 0).ok, false);
    assert.equal(askOp({ ...draft, ticked: [] }, "r1", 0).ok, false);
    assert.equal(askOp({ ...draft, note: "x".repeat(81) }, "r1", 0).ok, false);
    assert.equal(askOp({ ...draft, choices: [{ ability: "str" }, { ability: "str" }] }, "r1", 0).ok, false);
    const full = askOp(draft, "r1", 20);
    assert.equal(full.ok, false);
    assert.match(full.ok ? "" : full.error, /20 requests are open/);
  });

  test("the words a card reads", () => {
    const grapple = { test: { kind: "check" as const, choices: [{ ability: "str" as const, skill: "athletics" as const }, { ability: "dex" as const, skill: "acrobatics" as const }] }, note: "to break free of the grapple" };
    assert.equal(askLine(grapple), "The DM asks for a Strength (Athletics) or Dexterity (Acrobatics) check: to break free of the grapple.");
    assert.equal(testTitle({ kind: "save", choices: [{ ability: "str" }, { ability: "dex" }] }), "Strength or Dexterity saving throw");
    assert.equal(dcText({ dc: 15, dcShown: false }, "dm"), "DC 15, hidden from players");
    assert.equal(dcText({ dcShown: false, dcHidden: true }, "player"), "DC hidden");
    assert.equal(dcText({ dcShown: true }, "player"), null);
  });
});

describe("sending the DM's request", () => {
  test("the sheet closes only once the server takes the request, and keeps the reason otherwise", () => {
    assert.deepEqual(askAnswer("taken"), { kind: "sent" });
    const full = { code: "invalid" as const, message: "at most 20 roll requests can be open at once. Close one first", text: "At most 20 roll requests can be open at once. Close one first." };
    assert.deepEqual(askAnswer("refused", full), { kind: "kept", problem: full.text }, "a request counted from a stale view, refused by the server");
    assert.equal(askAnswer("refused").kind, "kept");
    assert.match(askAnswer("unknown").kind === "kept" ? (askAnswer("unknown") as { problem: string }).problem : "", /may not have gone out/);
  });
});

describe("answers on the DM's card", () => {
  test("a total sets pass or fail at the DC, and a changed answer names the one it replaced", () => {
    let state = ask(setup(), { dc: "15", dcShown: true });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 12 }, P1, 2);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 17 }, P1, 3);
    const target = state.rolls.r1!.targets[0]!;
    assert.equal(target.result, "pass");
    assert.equal(dmAnswerText(target, state.rolls.r1!.test), "17, changed from 12 (Fail)");
    assert.equal(dmAnswerText(state.rolls.r1!.targets[1]!, state.rolls.r1!.test), "waiting");
  });

  test("with no DC an answer wants the DM's mark, and a reopen waits again", () => {
    let state = ask(setup());
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 9 }, P1, 2);
    assert.equal(wantsMark(state.rolls.r1!, state.rolls.r1!.targets[0]!), true);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, result: "pass" }, DM, 3);
    assert.equal(wantsMark(state.rolls.r1!, state.rolls.r1!.targets[0]!), false);
    state = run(state, { t: "roll.reopen", rollId: "r1", target: { characterId: "ayla" } }, DM, 4);
    assert.equal(dmAnswerText(state.rolls.r1!.targets[0]!, state.rolls.r1!.test), "waiting again, was 9 (Pass)");
    assert.equal(dmAnswerText({ characterId: "x", result: "fail", noRoll: true }, state.rolls.r1!.test), "failed without rolling");
    assert.equal(dmAnswerText({ characterId: "x", result: "pass", noRoll: true }, state.rolls.r1!.test), "failed without rolling, marked Pass");
    assert.equal(dmAnswerText({ characterId: "x", result: "fail" }, state.rolls.r1!.test), "marked Fail", "a DM's bare mark");
  });

  test("two choices name the one rolled, and Close all answered closes only requests every target answered", () => {
    let state = ask(setup(), { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] });
    state = ask(state, {}, "r2");
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, choice: 1, total: 14 }, P1, 3);
    assert.equal(dmAnswerText(state.rolls.r1!.targets[0]!, state.rolls.r1!.test), "Dex (Acrobatics) 14");
    assert.deepEqual(allAnsweredIds(state.rolls), []);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "bram" }, total: 3 }, P2, 4);
    assert.deepEqual(allAnsweredIds(state.rolls), ["r1"]);
    state = run(state, { t: "roll.close", rollIds: allAnsweredIds(state.rolls) }, DM, 5);
    assert.deepEqual(Object.keys(state.rolls), ["r2"]);
  });

  test("cards stack newest first, and a deleted creature stays a target, named for what it was", () => {
    const rolls: Record<string, RollRequest> = {
      old: { id: "old", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, at: "2026-10-14T19:00:00.000Z", targets: [{ tokenId: "gone" }] },
      new: { id: "new", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, at: "2026-10-14T19:05:00.000Z", targets: [{ characterId: "ayla" }] },
    };
    assert.deepEqual(newestFirst(rolls).map((r) => r.id), ["new", "old"]);
    assert.equal(targetName(setup(), { tokenId: "gone" }), "A removed token");
  });

  test("a token target the DM's view lacks only because the DM looks at another scene is not called removed (LP5-ROLLS-10)", () => {
    const view = setup();
    const players = view.meta.playerSceneId;
    assert.equal(targetName(view, { tokenId: "gone" }, players), "A removed token", "on the players' scene, a missing token is gone");
    assert.equal(targetName(view, { tokenId: "gone" }, "elsewhere"), "A token not on this scene");
    assert.equal(targetName(view, { characterId: "ayla" }, "elsewhere"), "Ayla", "characters are in every DM view");
  });
});

describe("the DM's cards on a phone", () => {
  test("they start folded on a phone and fold into one button under a panel's sheet in portrait", () => {
    const desk = (width: number, height: number, open: boolean) => deskLayout({ width, height, wideMinWidth: 900, sheetOpen: open });
    assert.equal(desk(1280, 800, false).startsOpen(0), true, "the newest starts open from 900 px up");
    assert.equal(desk(1280, 800, false).startsOpen(1), false);
    assert.equal(desk(390, 844, false).startsOpen(0), false, "a phone starts every card folded");
    assert.equal(desk(300, 649, false).startsOpen(0), false, "390 px at 130% lays out as 300 px");
    assert.equal(desk(390, 844, true).folded, true, "a panel's sheet open in portrait folds the stack");
    assert.equal(desk(390, 844, false).folded, false);
    assert.equal(desk(844, 390, true).folded, false, "in landscape the column steps left of the docked sheet");
    assert.equal(desk(1280, 800, true).folded, false, "the side panel covers nothing");
    // The phone's list of panels is a sheet too (state/types.ts sheetOpen), and the DM's desk reads that signal.
    const covered = (local: { panel: string | null; panelList: boolean }) => desk(390, 844, sheetOpen(local)).folded;
    assert.equal(covered({ panel: null, panelList: true }), true, "the list of panels folds the stack");
    assert.equal(covered({ panel: "log", panelList: false }), true);
    assert.equal(covered({ panel: null, panelList: false }), false);
  });
});

describe("a player's chips on a phone (LP5-ROLLS-1)", () => {
  test("under a sheet in portrait they fold into one button that counts what was answered, so the sheet's header and Close stay clear", () => {
    let state = ask(setup(), { dc: "15" });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 17 }, P1, 2);
    const seen = projectState(state, P1, { sceneId: null }).rolls.r1!;
    const second: RollRequest = { ...seen, id: "r2", targets: seen.targets.map((t) => ({ characterId: t.characterId! })) };
    assert.deepEqual(foldedChips([second, seen]), { text: "Rolls 1/2", label: "Rolls 1/2: 2 roll requests, 1 of 2 answered. Close the sheet to see them." });
    assert.equal(foldedChips([seen]).label, "Rolls 1/1: 1 roll request, 1 of 1 answered. Close the sheet to see them.");
    // The same rule as the DM's cards: only a phone in portrait with a sheet open folds them.
    const folds = (width: number, height: number, open: boolean) => deskLayout({ width, height, wideMinWidth: 900, sheetOpen: open }).folded;
    assert.equal(folds(390, 844, true), true);
    assert.equal(folds(390, 844, false), false);
    assert.equal(folds(844, 390, true), false);
  });
});

describe("a player's chips on a phone with no sheet open (LP5-ROLLS-8)", () => {
  test("the newest two show and the rest fold into the button, which shows them and folds them again", () => {
    const phone = (count: number, expanded = false) => chipStack({ count, phone: true, underSheet: false, expanded });
    assert.deepEqual(phone(0), { shown: 0, button: null });
    assert.deepEqual(phone(2), { shown: 2, button: null }, "two fit");
    assert.deepEqual(phone(5), { shown: 2, button: "more" });
    assert.deepEqual(phone(5, true), { shown: 5, button: "less" }, "a tap shows them all");
    assert.deepEqual(chipStack({ count: 5, phone: true, underSheet: true, expanded: true }), { shown: 0, button: "sheet" }, "under a sheet they fold whatever");
    assert.deepEqual(chipStack({ count: 5, phone: false, underSheet: false, expanded: false }), { shown: 5, button: null }, "from 900 px up all show");
    let state = ask(setup(), { dc: "15" });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 17 }, P1, 2);
    const seen = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.deepEqual(foldedChips([seen], "more"), { text: "Rolls 1/1", label: "Rolls 1/1: 1 more roll request, 1 of 1 answered." });
    assert.equal(foldedChips([seen, seen], "less").label, "Rolls 2/2: 2 more roll requests, 2 of 2 answered.", "showing or folding keeps the name");
  });

  // POSTW5-OPUS-7: opening the third of three shown chips left two chips beside its card, and the stack folded under the player.
  test("shown chips stay shown while a chip past the first two is open, and fold once two or fewer requests are left", () => {
    assert.equal(chipsStayShown(3), true, "three requests, one open as a card and two as chips");
    assert.equal(chipsStayShown(2), false);
    assert.equal(chipsStayShown(0), false);
  });
});

describe("a player's page opening with requests already open (LP5-ROLLS-3)", () => {
  test("a reload brings the waiting cards up without a chime, and a request that arrives after still chimes", () => {
    const empty = new Map<string, boolean>();
    // The room mounts before its snapshot: the view is empty and not loaded yet, so that is no look at all.
    const mounted = lookAtRequests(null, empty, false);
    assert.deepEqual(mounted, { seen: null, unfold: [], chime: false });
    const snapshot = lookAtRequests(mounted.seen, new Map([["r1", true], ["r2", false]]), true);
    assert.deepEqual(snapshot.unfold, ["r1"], "the waiting card comes up");
    assert.equal(snapshot.chime, false, "a reload never buzzes for requests already open");
    const fresh = lookAtRequests(snapshot.seen, new Map([["r1", true], ["r2", false], ["r3", true]]), true);
    assert.deepEqual(fresh, { seen: new Map([["r1", true], ["r2", false], ["r3", true]]), unfold: ["r3"], chime: true });
  });
});

describe("the player's card and chip", () => {
  test("a hidden DC 15 and no DC are told apart through the projection, never by the number", () => {
    let hidden = ask(setup(), { dc: "15", dcShown: false });
    let none = ask(setup());
    hidden = run(hidden, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 12 }, P1, 2);
    none = run(none, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 12 }, P1, 2);
    const seenHidden = projectState(hidden, P1, { sceneId: null }).rolls.r1!;
    const seenNone = projectState(none, P1, { sceneId: null }).rolls.r1!;
    assert.equal(JSON.stringify(seenHidden).includes("15"), false, "the hidden DC never reaches the player");
    assert.equal(dcText(seenHidden, "player"), "DC hidden");
    assert.equal(dcText(seenNone, "player"), null);
    assert.equal(chipLine(seenHidden, seenHidden.targets[0]!), "Dex save: sent 12. Fail. Final. Ask the DM to change it.");
    assert.equal(finalForPlayer(seenHidden, seenHidden.targets[0]!), true);
    assert.equal(chipLine(seenNone, seenNone.targets[0]!), "Dex save: sent 12.");
    assert.equal(finalForPlayer(seenNone, seenNone.targets[0]!), false);
    // The reducer holds to it whatever a device shows.
    assert.equal(canApply({ t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 18 }, P1, hidden, deps).ok, true);
    assert.equal(applyOp(hidden, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 18 }, P1, env(3)).ok, false);
  });

  test("with pass or fail hidden the chip says only what was sent, and a player holds only their own target", () => {
    let state = ask(setup(), { dc: "15", resultShown: false });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 17 }, P1, 2);
    const seen = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.equal(seen.targets.length, 1);
    assert.equal(chipLine(seen, seen.targets[0]!), "Dex save: sent 17.");
    const bram = projectState(state, P2, { sceneId: null }).rolls.r1!;
    assert.equal(playerNeedsAnswer(bram), true);
  });

  test("a save failed without rolling reaches every device of its player, a reopen asks again, and a new total replaces it", () => {
    let state = ask(setup(), { resultShown: false });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, result: "fail" }, P1, 2);
    // What any of Pip's devices holds, a second one and a reload included: their projection, nothing this page remembers.
    const seen = () => projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.equal(seen().targets[0]!.result, undefined, "the result stays hidden");
    assert.equal(playerNeedsAnswer(seen()), false, "answered, so the card stays folded");
    assert.equal(chipLine(seen(), seen().targets[0]!), "Dex save: failed without rolling.");
    assert.equal(dmAnswerText(state.rolls.r1!.targets[0]!, state.rolls.r1!.test), "failed without rolling");

    const before = new Map([["r1", playerNeedsAnswer(seen())]]);
    state = run(state, { t: "roll.reopen", rollId: "r1", target: { characterId: "ayla" } }, DM, 3);
    assert.equal(playerNeedsAnswer(seen()), true, "the reopen reaches the player");
    assert.deepEqual(cameUp(before, new Map([["r1", playerNeedsAnswer(seen())]])), { unfold: ["r1"], chime: false }, "and the card comes up again");
    assert.equal(dmAnswerText(state.rolls.r1!.targets[0]!, state.rolls.r1!.test), "waiting again, was a fail without rolling");

    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, result: "fail" }, P1, 4);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 11 }, P1, 5);
    assert.equal(seen().targets[0]!.noRoll, undefined, "a total replaces it");
    assert.equal(chipLine(seen(), seen().targets[0]!), "Dex save: sent 11.");
  });

  test("a fail without rolling the DM overrules reads as the DM's pass, and a DM's own fail is no player's fail", () => {
    let state = ask(setup(), { dc: "12" });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, result: "fail" }, P1, 2);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, result: "pass" }, DM, 3);
    const seen = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.equal(seen.targets[0]!.noRoll, true);
    assert.equal(chipLine(seen, seen.targets[0]!), "Dex save: marked Pass by the DM.");
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "bram" }, result: "fail" }, DM, 4);
    const bram = projectState(state, P2, { sceneId: null }).rolls.r1!;
    assert.equal(chipLine(bram, bram.targets[0]!), "Dex save: marked Fail by the DM.");
    assert.equal(dmAnswerText(state.rolls.r1!.targets[1]!, state.rolls.r1!.test), "marked Fail");
  });

  test("a DM's mark on a request with a hidden DC is final for the player, and the card says it was the DM's mark", () => {
    let state = ask(setup(), { dc: "15", dcShown: false });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, result: "pass" }, DM, 2);
    const seen = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.equal(finalForPlayer(seen, seen.targets[0]!), true);
    assert.equal(chipLine(seen, seen.targets[0]!), "Dex save: marked Pass by the DM. Final. Ask the DM to change it.");
    assert.equal(finalAnswerText(seen.targets[0]!, DEX_SAVE), "Marked Pass by the DM", "never a fail without rolling the player did not send");
    assert.equal(applyOp(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 9 }, P1, env(3)).ok, false, "the reducer holds to it");
    assert.equal(finalAnswerText({ characterId: "ayla", total: 12, result: "fail" }, DEX_SAVE), "Sent 12. Fail", "with the result, as the chip says it (LP5-ROLLS-5)");
    assert.equal(finalAnswerText({ characterId: "ayla", noRoll: true, result: "fail" }, DEX_SAVE), "Failed without rolling");
    assert.equal(finalAnswerText({ characterId: "ayla", result: "fail" }, DEX_SAVE), "Marked Fail by the DM");
  });

  test("with two choices the chip and the final line say which one was rolled", () => {
    let state = ask(setup(), { choices: [{ ability: "str" }, { ability: "dex" }], dc: "15", dcShown: false });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, choice: 1, total: 12 }, P1, 2);
    const seen = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.equal(chipLine(seen, seen.targets[0]!), "Str or Dex save: sent Dex 12. Fail. Final. Ask the DM to change it.");
    assert.equal(finalAnswerText(seen.targets[0]!, seen.test), "Sent Dex 12. Fail");
  });

  test("a typed total is a whole number from -50 to 100", () => {
    assert.deepEqual(parseTotal(" 17 "), { ok: true, total: 17 });
    assert.deepEqual(parseTotal("−3"), { ok: true, total: -3 });
    assert.equal(parseTotal("101").ok, false);
    assert.equal(parseTotal("12.5").ok, false);
    assert.equal(parseTotal("").ok, false);
  });

  test("the card shows the newest request needing an answer, folds into a chip after Send or Later, and comes up again when reopened", () => {
    const at = (min: number) => `2026-10-14T19:0${min}:00.000Z`;
    const request = (id: string, min: number): RollRequest => ({ id, rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, at: at(min), targets: [{ characterId: "ayla" }] });
    const requests = newestFirst({ old: request("old", 1), new: request("new", 2) });
    const needs = new Map([["old", true], ["new", true]]);
    assert.equal(shownRequest(requests, needs, new Set(), null)?.id, "new", "newest first");
    assert.equal(shownRequest(requests, needs, new Set(["new"]), null)?.id, "old", "the folded one is a chip, and the next comes up");
    assert.equal(shownRequest(requests, new Map([["old", false], ["new", false]]), new Set(["new", "old"]), "old")?.id, "old", "a tapped chip opens its card to change the answer");
    assert.equal(shownRequest(requests, new Map([["old", false], ["new", false]]), new Set(), null), undefined, "all answered: only chips, the map clear");

    assert.deepEqual(cameUp(null, needs), { unfold: ["old", "new"], chime: false }, "the first look shows them without the chime");
    assert.deepEqual(cameUp(new Map([["old", true]]), needs), { unfold: ["new"], chime: true }, "a new request chimes");
    assert.deepEqual(cameUp(new Map([["old", true], ["new", false]]), needs), { unfold: ["new"], chime: false }, "a reopened one comes up quietly");
    assert.deepEqual(cameUp(needs, needs), { unfold: [], chime: false });
  });
});

describe("the player's card under a sheet (docs/design-v1-visual.md 3.3.1)", () => {
  const at = (min: number) => `2026-10-14T19:0${min}:00.000Z`;
  const request = (id: string, min: number, test: RollRequest["test"] = DEX_SAVE): RollRequest => ({
    id,
    rev: 0,
    test,
    dcShown: true,
    resultShown: true,
    at: at(min),
    targets: [{ characterId: "ayla" }],
  });

  test("it folds whenever it would cover an open sheet: across the screen under 600 px, or in portrait", () => {
    const folds = (width: number, height: number) => cardFoldsUnderSheet({ width, height, wideMinWidth: 900 });
    assert.equal(folds(390, 844), true, "a phone in portrait");
    assert.equal(folds(300, 649), true, "390 px at 130% lays out as 300 px");
    assert.equal(folds(580, 326), true, "667 x 375 at 115%: the card across the screen would cover the right-hand sheet");
    assert.equal(folds(768, 1024), true, "a portrait tablet: the column's card would cover the sheet's header");
    assert.equal(folds(844, 390), false, "a landscape phone from 600 px: the column steps left of the sheet");
    assert.equal(folds(1280, 800), false, "the side panel covers nothing");
  });

  test("the summary opens a mounted card first, else the newest request put off with Later, else nothing", () => {
    const requests = newestFirst({ a: request("a", 1), b: request("b", 2), c: request("c", 3) });
    const needs = new Map([["a", true], ["b", true], ["c", true]]);
    // A mounted card A, opened from its chip, with a deferred B: A, so a total typed into it is never dropped.
    assert.deepEqual(requestToOpen(requests, needs, new Set(["b", "c"]), "a"), { id: "a", mounted: true });
    // No chip opened: the card mounted is the newest not put off.
    assert.deepEqual(requestToOpen(requests, needs, new Set(["c"]), null), { id: "b", mounted: true });
    // Only deferred: the newest waiting, whose Later is to be undone.
    assert.deepEqual(requestToOpen(requests, needs, new Set(["a", "b", "c"]), null), { id: "c", mounted: false });
    // Nothing waits and no card is up: nothing to open.
    const done = new Map([["a", false], ["b", false], ["c", false]]);
    assert.equal(requestToOpen(requests, done, new Set(), null), null);
    // A card opened to change an answer is still the one to show.
    assert.deepEqual(requestToOpen(requests, done, new Set(), "b"), { id: "b", mounted: true });
  });

  test("a card being answered holds its place when a newer request arrives, which becomes a chip", () => {
    const old = request("old", 1);
    const needs1 = new Map([["old", true]]);
    assert.equal(shownRequest([old], needs1, new Set(), null)?.id, "old", "it came up on its own");
    // The first keystroke or roll choice sets `opened` to the card's request (PlayerRolls).
    const opened = "old";
    const fresh = request("new", 2);
    const both = newestFirst({ old, new: fresh });
    const needs2 = new Map([["old", true], ["new", true]]);
    assert.deepEqual(cameUp(needs1, needs2), { unfold: ["new"], chime: true }, "it still chimes, under a sheet too");
    assert.equal(shownRequest(both, needs2, new Set(), opened)?.id, "old", "the card being typed in stays");
    assert.equal(shownRequest(both, needs2, new Set(), null)?.id, "new", "without it the newer request would replace the card");
  });

  test("the summary reads Roll asked while a request waits, and Rolls d/a otherwise, for the dock and the column alike", () => {
    let state = ask(setup(), { dc: "15" });
    const waiting = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.deepEqual(rollsSummary([waiting]), { text: "Roll asked", name: "the DM asks for a Dexterity saving throw", waiting: true });
    assert.equal(sheetSummary([waiting]).label, "Roll asked: the DM asks for a Dexterity saving throw. Close the sheet to answer.");
    const wis = request("w", 5, { kind: "check", choices: [{ ability: "wis" }] });
    assert.equal(rollsSummary([wis, waiting]).name, "the DM asks for a Wisdom check and 1 more roll", "the newest waiting leads");
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 17 }, P1, 2);
    const answeredOne = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.deepEqual(rollsSummary([answeredOne]), { text: "Rolls 1/1", name: "rolls 1 of 1 answered", waiting: false });
    assert.equal(sheetSummary([answeredOne]).label, "Rolls 1/1: 1 roll request, 1 of 1 answered. Close the sheet to see them.");
    assert.deepEqual(answeredCount([answeredOne, waiting]), { text: "Rolls 1/2", name: "rolls 1 of 2 answered" });
  });
});

describe("the DM's cards on a phone with no sheet open (docs/design-v1-visual.md 3.3.1)", () => {
  test("the newest two show, then one Rolls d/a disclosure for the rest, the player's rule", () => {
    const desk = (count: number, expanded = false) => chipStack({ count, phone: true, underSheet: false, expanded });
    assert.deepEqual(desk(2), { shown: 2, button: null });
    assert.deepEqual(desk(6), { shown: 2, button: "more" }, "six cards no longer cover the map");
    assert.deepEqual(desk(6, true), { shown: 6, button: "less" });
    assert.deepEqual(chipStack({ count: 6, phone: true, underSheet: true, expanded: false }), { shown: 0, button: "sheet" }, "under a portrait sheet the whole stack folds");
    assert.deepEqual(chipStack({ count: 6, phone: false, underSheet: false, expanded: false }), { shown: 6, button: null }, "from 900 px up every card shows");
  });
});

describe("a total typed into a card and not sent (LPD-PLAYER-1)", () => {
  test("comes back when the card mounts again, as turning the phone does", () => {
    const draft = { text: "14", choice: 1 as const, base: answerKey({}) };
    assert.deepEqual(startingAnswer({}, draft), { text: "14", choice: 1 });
    assert.deepEqual(startingAnswer({}, undefined), { text: "", choice: 0 }, "with nothing typed the card starts empty");
  });

  test("gives way to an answer sent since it was typed, from this player's other device", () => {
    assert.deepEqual(startingAnswer({ total: 9, choice: 0 }, { text: "14", choice: 1, base: answerKey({}) }), { text: "9", choice: 0 });
    const sent = answerKey({ total: 9, choice: 0 });
    assert.deepEqual(startingAnswer({ total: 9, choice: 0 }, { text: "12", choice: 1, base: sent }), { text: "12", choice: 1 }, "a change typed over a sent answer stays");
    assert.deepEqual(startingAnswer({ result: "fail", noRoll: true }, { text: "12", choice: 1, base: answerKey({}) }), { text: "", choice: 0 }, "a save failed without rolling elsewhere wins too");
  });

  test("is forgotten once the answer changes, so a reopen after an answer from another device starts the card empty", () => {
    let state = ask(setup());
    const view = () => projectState(state, P1, { sceneId: null }).rolls.r1!;
    const target = view().targets[0]!;
    const key = draftKey("r1", target);
    // Pat types 16 on the phone and does not send it.
    const drafts = new Map<string, AnswerDraft>([[key, { text: "16", choice: 0, base: answerKey(target) }]]);
    forgetStaleDrafts(drafts, [view()]);
    assert.equal(drafts.get(key)?.text, "16", "a draft over an unchanged answer stays");

    // Pat answers 9 from the laptop. The card on the phone is folded, or shows the 9.
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 9 }, P1, 2);
    forgetStaleDrafts(drafts, [view()]);
    assert.equal(drafts.has(key), false, "the answer from the other device drops the draft for good");

    // The DM reopens it: the answer is back where it stood when 16 was typed, and the card starts empty.
    state = run(state, { t: "roll.reopen", rollId: "r1", target: { characterId: "ayla" } }, DM, 3);
    const reopened = view();
    forgetStaleDrafts(drafts, [reopened]);
    assert.deepEqual(startingAnswer(reopened.targets[0]!, drafts.get(key)), { text: "", choice: 0 });
  });

  test("is forgotten when its request closes", () => {
    const drafts = new Map<string, AnswerDraft>([[draftKey("r1", { characterId: "ayla" }), { text: "16", choice: 0, base: answerKey({}) }]]);
    forgetStaleDrafts(drafts, []);
    assert.equal(drafts.size, 0);
  });

  test("is kept per request and per creature", () => {
    assert.notEqual(draftKey("r1", { characterId: "ayla" }), draftKey("r1", { tokenId: "ayla" }));
    assert.notEqual(draftKey("r1", { characterId: "ayla" }), draftKey("r2", { characterId: "ayla" }));
  });
});
