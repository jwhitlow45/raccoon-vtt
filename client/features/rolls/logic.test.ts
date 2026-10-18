import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RollRequest, RollTarget, RoomState, Viewer } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { ABILITY_KEYS, SKILL_KEYS } from "#shared/model.ts";
import { SKILLS } from "#shared/rules/skills.ts";
import { NO_INPUTS } from "./card.ts";
import { actor, chance, character, DM, env, int, P1, pick as pickOne, rng, room, token } from "#shared/testutil.ts";
import { sheetOpen } from "../../state/types.ts";
import {
  allAnsweredIds,
  answeredCount,
  answerKey,
  askAnswer,
  cardAfterClose,
  askLine,
  askOp,
  draftOp,
  cameUp,
  cardFoldsUnderSheet,
  chipLine,
  chipName,
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
  keepFocusFor,
  lookAtRequests,
  newestFirst,
  askTarget,
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
  addChoice,
  askStatus,
  choose,
  draftTest,
  pickerView,
  pickRefusal,
  pickerSteps,
  removeChoice,
  samePick,
  testTitle as titleOf,
  answerFlow,
  answerOffers,
  foldsAfterSend,
  IDLE,
  landingOf,
  tallyText,
  dcChips,
  draftInput,
  fillDraft,
  parseRecent,
  recentLabel,
  recentOf,
  seenSummary,
  switchesOf,
  tapDc,
  withRecent,
  type RecentAsk,
  type AnswerDraft,
  type AskDraft,
  type RollPick,
} from "./logic.ts";

const P2: Viewer = { memberId: "p2", role: "player" };
const DEX_SAVE = { kind: "save" as const, choices: [{ ability: "dex" as const }] };
const DEX_PICK: RollPick = { kind: "save", ability: "dex" };
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
  // Every answer carries its tag, as the cards send it (docs/design-v1-roll-request.md 7.5).
  if (op.t === "roll.answer" && op.tag === undefined) op = { ...op, tag: `answer-${seq}` };
  assert.ok(clientOpSchema.safeParse(op).success, `${op.t} is a valid op`);
  const allowed = canApply(op, who, state, deps);
  assert.ok(allowed.ok, `${op.t}: ${allowed.ok ? "" : allowed.message}`);
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r.state;
}

function ask(state: RoomState, patch: Partial<ReturnType<typeof emptyDraft>> = {}, id = "r1"): RoomState {
  const draft = { ...emptyDraft([{ characterId: "ayla" }, { characterId: "bram" }]), choices: [DEX_PICK], ...patch };
  const check = draftOp(draft, id, Object.keys(state.rolls).length);
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
    const check = draftOp({ ...emptyDraft(targets.filter((t) => t.ticked).map((t) => t.ref)), choices: [DEX_PICK] }, "r1", 0);
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

  test("an object a player plays, such as a Spiritual Weapon, is no creature to ask, alone or in a group", () => {
    const state = setup();
    state.tokens.weapon = token("weapon", { kind: "object", name: "Spiritual Weapon", sceneId: "s1", ownerIds: ["p1"], actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0 }) } });
    assert.equal(askTarget(state, state.tokens.weapon!), null);
    assert.equal(offersRequest(state, [state.tokens.weapon!]), false, "the single bar");
    assert.equal(offersRequest(state, [state.tokens.weapon!, state.tokens.goblin!]), false, "the group bar, with nothing else to ask");
    assert.equal(offersRequest(state, [state.tokens.weapon!, state.tokens.b1!]), true, "a party character beside it still is");
  });
});

/**
 * The picker's randomized test (docs/design-v1-roll-request.md 11.1): 2,000
 * sequences of 40 random steps through the sheet's own handlers (a row
 * tap, a skill, "Choose a skill", another ability for a skill, Or, Remove,
 * a DC typed or a chip, "Against a spell", and a recent request or a fill),
 * disabled options included. After every step:
 * - Every picker shows exactly its pick, with at most one row holding a value.
 * - The status line names `draftTest`, and `askOp` sends exactly it.
 * - Two choices never differ in kind and never match.
 * - A skill's ability is its usual one unless "with" changed it since the skill was picked.
 * - A step a rule forbids (a disabled option) changes nothing.
 * - The DC chips show the field's value, and only while every pick is a check.
 * - "Against a spell" goes, and the fold's summary names it, only while every pick is a save.
 */
describe("the picker, at random", () => {
  type Step = { name: string; i: number; apply(d: AskDraft): AskDraft; forbidden(d: AskDraft): boolean; touches?: "pick" | "with" | "fill" };
  // Recent requests and doc 3's fills, as the sheet takes them: one choice or two, saves and checks, a skill with another ability.
  const FILLS: RecentAsk[] = [
    { test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 15, dcShown: false, resultShown: true },
    { test: { kind: "save", choices: [{ ability: "str" }, { ability: "con" }] }, dcShown: true, resultShown: false, spell: true, note: "against the web" },
    { test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, dc: 15, dcShown: true, resultShown: true },
    { test: { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] }, dc: 12, dcShown: true, resultShown: true },
    { test: { kind: "check", choices: [{ ability: "cha", skill: "perception" }] }, dcShown: false, resultShown: false },
  ];
  const randomStep = (r: () => number, d: AskDraft): Step => {
    const i = int(r, 0, d.choices.length - 1);
    const kind = int(r, 0, 9);
    const ability = pickOne(r, ABILITY_KEYS);
    const skill = pickOne(r, SKILL_KEYS);
    switch (kind) {
      case 0:
        return { name: `save ${ability} on ${i}`, i, apply: (x) => pickerSteps.save(x, i, ability), forbidden: (x) => pickerView(x, i).save.disabled.includes(ability), touches: "pick" };
      case 1:
        return { name: `check ${ability} on ${i}`, i, apply: (x) => pickerSteps.check(x, i, ability), forbidden: (x) => pickerView(x, i).check.disabled.includes(ability), touches: "pick" };
      case 2:
        return chance(r, 0.15)
          ? { name: `no skill on ${i}`, i, apply: (x) => pickerSteps.skill(x, i, null), forbidden: () => false, touches: "pick" }
          : { name: `skill ${skill} on ${i}`, i, apply: (x) => pickerSteps.skill(x, i, skill), forbidden: (x) => pickerView(x, i).skill.disabled.includes(skill), touches: "pick" };
      case 3:
        return { name: `with ${ability} on ${i}`, i, apply: (x) => pickerSteps.with(x, i, ability), forbidden: (x) => pickerView(x, i).with?.disabled.includes(ability) ?? false, touches: "with" };
      case 4:
        return { name: "or", i, apply: addChoice, forbidden: () => false };
      case 5:
        return { name: `remove ${i}`, i, apply: (x) => removeChoice(x, i), forbidden: () => false };
      case 6: {
        const dc = pickOne(r, ["", "15", "5", "30", "51", "x", " 12 "]);
        return { name: `dc "${dc}"`, i, apply: (x) => ({ ...x, dc }), forbidden: () => false };
      }
      case 7: {
        // A chip is drawn only while every pick is a check, so a tap needs one there.
        const dc = pickOne(r, [5, 10, 15, 20, 25, 30]);
        return { name: `chip ${dc}`, i, apply: (x) => (dcChips(x) ? tapDc(x, dc) : x), forbidden: () => false };
      }
      case 8:
        return { name: "spell", i, apply: (x) => ({ ...x, spell: !x.spell }), forbidden: () => false };
      default: {
        const entry = pickOne(r, FILLS);
        return { name: `fill ${recentLabel(entry)}`, i, apply: (x) => fillDraft(x, entry), forbidden: () => false, touches: "fill" };
      }
    }
  };

  test("2,000 sequences of 40 steps keep every invariant", () => {
    let forbiddenSeen = 0;
    let skillsSeen = 0;
    let withSeen = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      let draft: AskDraft = emptyDraft([{ characterId: "ayla" }]);
      // Whether "with" changed choice i's ability since its skill was picked.
      let withChanged: boolean[] = [false];
      const trail: string[] = [];
      for (let n = 0; n < 40; n++) {
        const step = randomStep(r, draft);
        trail.push(step.name);
        const where = `seed ${seed}: ${trail.join(", ")}`;
        const before = draft;
        const forbidden = step.forbidden(before);
        draft = step.apply(before);
        if (forbidden) {
          forbiddenSeen++;
          assert.equal(draft, before, `a forbidden step changes nothing, ${where}`);
        }
        if (step.name === "or" && draft !== before) withChanged = [...withChanged, false];
        if (step.name.startsWith("remove") && draft !== before) withChanged = withChanged.filter((_, j) => j !== step.i);
        if (draft !== before && step.touches === "pick") withChanged[step.i] = false;
        if (draft !== before && step.touches === "with") {
          withChanged[step.i] = true;
          withSeen++;
        }
        // A fill sets every choice, a skill perhaps with another ability, as it was sent.
        if (step.touches === "fill") withChanged = draft.choices.map((p) => p?.kind === "check" && p.skill !== undefined && p.ability !== SKILLS[p.skill].ability);
        assert.equal(withChanged.length, draft.choices.length, where);

        for (let i = 0; i < draft.choices.length; i++) {
          const p = draft.choices[i]!;
          const view = pickerView(draft, i);
          const shown = [view.save.value, view.check.value, view.skill.value].filter((v) => v !== null);
          assert.ok(shown.length <= 1, `at most one row holds a value, ${where}`);
          const skill = p?.kind === "check" ? p.skill : undefined;
          assert.equal(view.save.value, p?.kind === "save" ? p.ability : null, `the Save row shows its pick, ${where}`);
          assert.equal(view.check.value, p?.kind === "check" && skill === undefined ? p.ability : null, `the Check row shows its pick, ${where}`);
          assert.equal(view.skill.value, skill ?? null, `the Skill dropdown shows its pick, ${where}`);
          assert.deepEqual(view.with ? [view.with.skill, view.with.value] : null, skill !== undefined ? [skill, p!.ability] : null, `with shows the skill's ability, ${where}`);
          if (skill !== undefined) {
            skillsSeen++;
            if (!withChanged[i]) assert.equal(p!.ability, SKILLS[skill].ability, `a skill keeps its usual ability until with changes it, ${where}`);
          }
        }
        const [a, b] = draft.choices;
        if (a && b) {
          assert.equal(a.kind, b.kind, `two choices share a kind, ${where}`);
          assert.ok(!samePick(a, b), `two choices never match, ${where}`);
        }
        // The chips show the field's value, and only for checks.
        const chips = dcChips(draft);
        const picked = draft.choices.filter((p) => p !== null);
        assert.equal(chips !== null, picked.length > 0 && picked.every((p) => p.kind === "check"), `chips only while every pick is a check, ${where}`);
        if (chips) assert.deepEqual(chips.filter((c) => c.pressed).map((c) => String(c.dc)), chips.some((c) => String(c.dc) === draft.dc.trim()) ? [draft.dc.trim()] : [], `the chips show the field, ${where}`);
        const test = draftTest(draft);
        const status = askStatus(draft);
        const check = draftOp(draft, "r1", 0);
        if (check.ok) {
          const spell = draft.spell && test?.kind === "save";
          assert.equal(check.op.request.spell === true, spell, `Against a spell goes only while it applies, ${where}`);
          assert.equal(seenSummary(draft).includes("Against a spell."), spell, `and the summary says what goes, ${where}`);
        }
        if (test === null) {
          assert.match(status, /^Pick what to roll\./, where);
          assert.equal(check.ok, false, where);
        } else {
          assert.ok(status.startsWith(titleOf(test)), `the status line names the test, ${where}`);
          if (check.ok) assert.deepEqual(check.op.request.test, test, `Send sends exactly the test, ${where}`);
          else assert.match(check.error, /^A DC is/, `only a DC typed wrong stops a whole draft here, ${where}`);
        }
      }
    }
    assert.ok(forbiddenSeen > 500, `forbidden steps were tried: ${forbiddenSeen}`);
    assert.ok(skillsSeen > 1000 && withSeen > 100, `skills ${skillsSeen}, with ${withSeen}`);
  });
});

describe("the DM's sheet", () => {
  test("nothing is picked at open, and Send says what to pick first", () => {
    const draft = emptyDraft([{ characterId: "ayla" }]);
    assert.deepEqual(draft.choices, [null]);
    assert.equal(draftTest(draft), null);
    assert.equal(askStatus(draft), "Pick what to roll. 1 asked.");
    const view = pickerView(draft, 0);
    assert.deepEqual([view.save.value, view.check.value, view.skill.value, view.with], [null, null, null, null], "no row shows a value nobody picked");
    const refused = draftOp(draft, "r1", 0);
    assert.deepEqual(refused, { ok: false, error: "Pick what to roll first." });
    const second = addChoice(choose(draft, 0, DEX_PICK));
    assert.deepEqual(draftOp(second, "r1", 0), { ok: false, error: "Pick the second choice, or remove it." });
  });

  test("the reported bug: Perception, then Strength in the Check row, asks a Strength check", () => {
    let draft = emptyDraft([{ characterId: "ayla" }]);
    draft = choose(draft, 0, { kind: "check", ability: "wis", skill: "perception" });
    assert.equal(askStatus(draft), "Wisdom (Perception) check, no DC. 1 asked.");
    assert.deepEqual(pickerView(draft, 0).with, { skill: "perception", value: "wis", disabled: [] });
    draft = choose(draft, 0, { kind: "check", ability: "str" });
    const view = pickerView(draft, 0);
    assert.equal(view.check.value, "str");
    assert.equal(view.skill.value, null, "Perception's dropdown goes back to Choose a skill");
    assert.equal(view.with, null);
    assert.equal(askStatus(draft), "Strength check, no DC. 1 asked.");
    const check = draftOp(draft, "r1", 0);
    assert.ok(check.ok);
    assert.deepEqual(check.op.request.test, { kind: "check", choices: [{ ability: "str" }] });
    draft = choose(draft, 0, { kind: "save", ability: "dex" });
    assert.deepEqual([pickerView(draft, 0).save.value, pickerView(draft, 0).check.value], ["dex", null], "a save after a check shows in the Save row alone");
  });

  test("a skill starts at its usual ability, another goes with it, and a new pick starts again at the usual one", () => {
    let draft = choose(emptyDraft([]), 0, { kind: "check", ability: "wis", skill: "perception" });
    draft = choose(draft, 0, { kind: "check", ability: "cha", skill: "perception" });
    assert.equal(askStatus(draft), "Charisma (Perception) check, no DC. 0 asked.");
    draft = choose(draft, 0, { kind: "check", ability: "wis", skill: "insight" });
    assert.deepEqual(draftTest(draft), { kind: "check", choices: [{ ability: "wis", skill: "insight" }] }, "Insight with Wisdom, its usual");
    assert.equal(choose(draft, 0, null).choices[0], null, "Choose a skill clears the pick");
  });

  test("two choices share one kind and never match, and Remove on the first makes the second the first", () => {
    let draft = choose(addChoice(choose(emptyDraft([{ characterId: "ayla" }]), 0, { kind: "save", ability: "str" })), 1, { kind: "save", ability: "dex" });
    assert.equal(addChoice(draft), draft, "no third choice");
    const second = pickerView(draft, 1);
    assert.deepEqual(second.check.disabled, ["str", "dex", "con", "int", "wis", "cha"], "the Check row is disabled while the first is a save");
    assert.equal(second.skill.disabled.length, 18);
    assert.deepEqual(second.save.disabled, ["str"], "the first choice's own pick");
    assert.equal(second.why, "Both choices are saves. Str save is the first choice.");
    assert.equal(pickRefusal(draft, 1, { kind: "check", ability: "dex" }), "Both choices are saves.");
    assert.equal(pickRefusal(draft, 1, { kind: "save", ability: "str" }), "That is the first choice.");
    assert.equal(choose(draft, 1, { kind: "check", ability: "dex" }), draft, "a refused pick changes nothing");
    assert.equal(choose(draft, 1, { kind: "save", ability: "str" }), draft);
    assert.equal(askStatus(draft), "Strength or Dexterity saving throw, no DC. 1 asked.");
    const removed = removeChoice(draft, 0);
    assert.deepEqual(removed.choices, [{ kind: "save", ability: "dex" }]);
    assert.equal(removeChoice(removed, 0), removed, "the last choice stays");
    // With the second empty, the first may change kind freely.
    const open = choose(addChoice(choose(emptyDraft([]), 0, DEX_PICK)), 0, { kind: "check", ability: "str", skill: "athletics" });
    assert.ok(samePick(open.choices[0], { kind: "check", ability: "str", skill: "athletics" }));
    // A skill's other ability that would match the other choice is not offered.
    let skills = choose(addChoice(choose(emptyDraft([]), 0, { kind: "check", ability: "cha", skill: "perception" })), 1, { kind: "check", ability: "wis", skill: "perception" });
    assert.deepEqual(pickerView(skills, 1).with?.disabled, ["cha"]);
    skills = choose(skills, 1, { kind: "check", ability: "cha", skill: "perception" });
    assert.ok(samePick(skills.choices[1], { kind: "check", ability: "wis", skill: "perception" }), "refused, it stays");
  });

  test("both switches start on, the DC is optional, and what to fix is said in words", () => {
    const draft: AskDraft = { ...emptyDraft([{ characterId: "ayla" }]), choices: [DEX_PICK] };
    assert.equal(draft.dcShown, true);
    assert.equal(draft.resultShown, true);
    const none = draftOp(draft, "r1", 0);
    assert.ok(none.ok);
    assert.equal("dc" in none.op.request, false);
    const fifteen = draftOp({ ...draft, dc: "15", note: "  against   the poison " }, "r1", 0);
    assert.ok(fifteen.ok);
    assert.equal(fifteen.op.request.dc, 15);
    assert.equal(fifteen.op.request.note, "against the poison");
    assert.equal(draftOp({ ...draft, dc: "51" }, "r1", 0).ok, false);
    assert.equal(draftOp({ ...draft, dc: "1.5" }, "r1", 0).ok, false);
    assert.equal(draftOp({ ...draft, ticked: [] }, "r1", 0).ok, false);
    assert.equal(draftOp({ ...draft, note: "x".repeat(81) }, "r1", 0).ok, false);
    assert.equal(draftOp({ ...draft, choices: [{ kind: "save", ability: "str" }, { kind: "save", ability: "str" }] }, "r1", 0).ok, false);
    const full = draftOp(draft, "r1", 20);
    assert.equal(full.ok, false);
    assert.match(full.ok ? "" : full.error, /20 requests are open/);
  });

  test("Send's request: the DC row, Against a spell for saves alone, and the switches each caller passes", () => {
    const base: AskDraft = { ...emptyDraft([{ characterId: "ayla" }]), choices: [{ kind: "check", ability: "wis", skill: "perception" }] };
    const chip = tapDc(base, 15);
    assert.deepEqual(dcChips(chip)?.filter((c) => c.pressed).map((c) => c.dc), [15]);
    assert.equal(tapDc(chip, 15).dc, "", "a tap on the pressed chip empties the field");
    const save = choose(chip, 0, DEX_PICK);
    assert.equal(dcChips(save), null, "a save offers the field alone");
    assert.equal(save.dc, "15", "and the field keeps 15");
    assert.equal(dcChips(emptyDraft([])), null, "nothing picked, no chips");
    const spell = draftInput({ ...save, spell: true });
    assert.ok(spell.ok && spell.input.spell === true);
    const checkSpell = draftInput({ ...chip, spell: true });
    assert.ok(checkSpell.ok && checkSpell.input.spell === undefined, "a check is never against a spell");
    assert.deepEqual(draftInput({ ...save, dc: "1.5" }), { ok: false, error: "A DC is a whole number from 1 to 50, or empty for none." });
    // Doc 3's save-ends request passes its own switches and its link, whatever this device's sheet starts with.
    const ends = askOp({ test: DEX_SAVE, dc: 15, dcShown: false, resultShown: true, cause: "saveEnds", ends: { effect: "e1", occurrence: "o1" }, targets: [{ characterId: "ayla" }] }, "r9", 0);
    assert.ok(ends.ok);
    assert.deepEqual(ends.op.request, { id: "r9", test: DEX_SAVE, dc: 15, dcShown: false, resultShown: true, cause: "saveEnds", ends: { effect: "e1", occurrence: "o1" }, targets: [{ characterId: "ayla" }] });
    assert.deepEqual(askOp({ test: DEX_SAVE, dc: 51, dcShown: true, resultShown: true, targets: [{ characterId: "ayla" }] }, "r9", 0), { ok: false, error: "A DC is a whole number from 1 to 50, or empty for none." });
  });

  test("what players see folds into one line that says what Send sends", () => {
    const draft: AskDraft = { ...emptyDraft([]), choices: [DEX_PICK] };
    assert.equal(seenSummary(draft), "Pass or fail shown. No note.");
    assert.equal(seenSummary({ ...draft, dc: "15" }), "The DC and pass or fail. No note.");
    assert.equal(seenSummary({ ...draft, dc: "15", dcShown: false }), "DC hidden. Pass or fail shown. No note.");
    assert.equal(seenSummary({ ...draft, dc: "15", dcShown: false, resultShown: false }), "DC and pass or fail hidden. No note.");
    assert.equal(seenSummary({ ...draft, resultShown: false, spell: true, note: " against  the poison " }), "Pass or fail hidden. Against a spell. Note: against the poison.");
    assert.equal(seenSummary({ ...draft, dc: "15", dcShown: false, spell: true, choices: [{ kind: "check", ability: "str" }] }), "DC hidden. Pass or fail shown. No note.", "a DC typed then cleared, or a spell on a check, leaves the summary");
  });

  test("recent requests: newest first, one per test and DC, three at most, a bad entry dropped, and the switches follow the newest", () => {
    const dex: RecentAsk = { test: DEX_SAVE, dc: 15, dcShown: false, resultShown: true };
    const perception: RecentAsk = { test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, dcShown: true, resultShown: true };
    const two: RecentAsk = { test: { kind: "save", choices: [{ ability: "str" }, { ability: "dex" }] }, dc: 13, dcShown: true, resultShown: false, spell: true, note: "against the web" };
    let list = withRecent([], dex);
    list = withRecent(list, perception);
    list = withRecent(list, two);
    list = withRecent(list, { ...dex, note: "again" });
    assert.deepEqual(list.map(recentLabel), ["Dex save, DC 15", "Str or Dex save, DC 13", "Wis (Perception) check"]);
    assert.equal(list[0]!.note, "again", "sent again, it moves to the front with what it was sent with");
    assert.equal(withRecent(list, { ...perception, dc: 10 }).length, 3, "at most three");
    assert.deepEqual(parseRecent(null), [], "no storage, as in a private window");
    assert.deepEqual(switchesOf([]), { dcShown: true, resultShown: true }, "and both switches on");
    assert.deepEqual(switchesOf(list), { dcShown: false, resultShown: true }, "else as the newest request had them");
    const stored = JSON.stringify([{ test: { kind: "save", choices: [{ ability: "dex", skill: "stealth" }] }, dcShown: true, resultShown: true }, two, "junk", { ...dex, dc: 99 }, perception]);
    assert.deepEqual(parseRecent(stored).map(recentLabel), ["Str or Dex save, DC 13", "Wis (Perception) check"], "an entry that fails its check is dropped, the others shown");
    assert.deepEqual(parseRecent("{not json"), []);
    // A tap fills the choices, the DC, the switches, Against a spell and the note, and keeps who rolls.
    const ticked = [{ characterId: "ayla" }] as const;
    const filled = fillDraft({ ...emptyDraft(ticked), choices: [{ kind: "check", ability: "str" }, null] }, two);
    assert.deepEqual(filled.choices, [{ kind: "save", ability: "str" }, { kind: "save", ability: "dex" }]);
    assert.deepEqual([filled.dc, filled.dcShown, filled.resultShown, filled.spell, filled.note], ["13", true, false, true, "against the web"]);
    assert.equal(filled.ticked, ticked);
    const back = draftInput(filled);
    assert.ok(back.ok);
    assert.deepEqual(recentOf(back.input), two, "and Send keeps what it filled");
    // Doc 3's fill (4.8) sets the roll and leaves the sheet's switches alone.
    const fill = fillDraft({ ...emptyDraft(ticked, { dcShown: false, resultShown: false }) }, { test: { kind: "check", choices: [{ ability: "dex", skill: "stealth" }] }, dc: 12 });
    assert.deepEqual([fill.choices, fill.dc, fill.dcShown, fill.resultShown], [[{ kind: "check", ability: "dex", skill: "stealth" }], "12", false, false]);
  });

  test("the words a card reads", () => {
    const grapple = { test: { kind: "check" as const, choices: [{ ability: "str" as const, skill: "athletics" as const }, { ability: "dex" as const, skill: "acrobatics" as const }] }, dcShown: true, note: "to break free of the grapple" };
    assert.equal(askLine(grapple), "The DM asks for a Strength (Athletics) or Dexterity (Acrobatics) check: to break free of the grapple.");
    // The DC joins the question (docs/design-v1-roll-request.md 5.1), and a save against a spell says so.
    assert.equal(askLine({ ...grapple, dc: 12 }), "The DM asks for a Strength (Athletics) or Dexterity (Acrobatics) check, DC 12: to break free of the grapple.");
    assert.equal(askLine({ test: DEX_SAVE, dcShown: false, dcHidden: true, spell: true }), "The DM asks for a Dexterity saving throw against a spell, DC hidden.");
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
    assert.equal(dmAnswerText(target, state.rolls.r1!.test), "typed 17, changed from typed 12 (Fail)");
    assert.equal(dmAnswerText(state.rolls.r1!.targets[1]!, state.rolls.r1!.test), "waiting");
  });

  test("with no DC an answer wants the DM's mark, and a reopen waits again", () => {
    let state = ask(setup());
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 9 }, P1, 2);
    assert.equal(wantsMark(state.rolls.r1!, state.rolls.r1!.targets[0]!), true);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, result: "pass" }, DM, 3);
    assert.equal(wantsMark(state.rolls.r1!, state.rolls.r1!.targets[0]!), false);
    state = run(state, { t: "roll.reopen", rollId: "r1", target: { characterId: "ayla" } }, DM, 4);
    assert.equal(dmAnswerText(state.rolls.r1!.targets[0]!, state.rolls.r1!.test), "waiting again, was typed 9, marked Pass");
    assert.equal(dmAnswerText({ characterId: "x", result: "fail", noRoll: true }, state.rolls.r1!.test), "failed without rolling");
    assert.equal(dmAnswerText({ characterId: "x", result: "pass", noRoll: true }, state.rolls.r1!.test), "failed without rolling, marked Pass");
    assert.equal(dmAnswerText({ characterId: "x", result: "fail" }, state.rolls.r1!.test), "marked Fail", "a DM's bare mark");
  });

  test("two choices name the one rolled, and Close all answered closes only requests every target answered", () => {
    let state = ask(setup(), { choices: [{ kind: "check", ability: "str", skill: "athletics" }, { kind: "check", ability: "dex", skill: "acrobatics" }] });
    state = ask(state, {}, "r2");
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, choice: 1, total: 14 }, P1, 3);
    assert.equal(dmAnswerText(state.rolls.r1!.targets[0]!, state.rolls.r1!.test), "Dex (Acrobatics): typed 14");
    assert.deepEqual(allAnsweredIds(state.rolls), []);
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "bram" }, total: 3 }, P2, 4);
    assert.deepEqual(allAnsweredIds(state.rolls), ["r1"]);
    const asking = structuredClone(state);
    asking.rolls.r1!.targets[1]!.change = { id: "ask1", on: "answer-4", reason: "fix-total" };
    assert.deepEqual(allAnsweredIds(asking.rolls), [], "a request holding a player's ask waits for the DM");
    state = run(state, { t: "roll.close", rollIds: allAnsweredIds(state.rolls), ifSettled: true }, DM, 5);
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
    const covered = (local: { panel: string | null; panelList: boolean }) => desk(390, 844, sheetOpen({ ...local, sheetHidden: false })).folded;
    assert.equal(covered({ panel: null, panelList: true }), true, "the list of panels folds the stack");
    assert.equal(covered({ panel: "log", panelList: false }), true);
    assert.equal(covered({ panel: null, panelList: false }), false);
  });
});

describe("where focus goes as the DM closes cards (LPD-DMPHONE-7)", () => {
  test("a card's Close moves to the card after it, newest first", () => {
    assert.equal(cardAfterClose(["c", "b", "a"], ["c"], "card"), "b");
    assert.equal(cardAfterClose(["c", "b", "a"], ["b"], "card"), "a");
  });

  test("the last card closed leaves no card after it, so the column or the map takes focus", () => {
    assert.equal(cardAfterClose(["c", "b", "a"], ["a"], "card"), null);
    assert.equal(cardAfterClose(["a"], ["a"], "card"), null);
  });

  test("Close all answered, above the cards, moves to the first card left", () => {
    assert.equal(cardAfterClose(["c", "b", "a"], ["b"], "all"), "c");
    assert.equal(cardAfterClose(["c", "b", "a"], ["c", "a"], "all"), "b");
    assert.equal(cardAfterClose(["c", "b", "a"], ["b", "c"], "all"), "a");
    assert.equal(cardAfterClose(["b", "a"], ["b", "a"], "all"), null);
  });
});

describe("a player's chips on a phone (LP5-ROLLS-1)", () => {
  test("under a sheet in portrait they fold into one button that counts what was answered, so the sheet's header and Close stay clear", () => {
    let state = ask(setup(), { dc: "15" });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 17 }, P1, 2);
    const seen = projectState(state, P1, { sceneId: null }).rolls.r1!;
    const second: RollRequest = { ...seen, id: "r2", targets: seen.targets.map((t) => ({ characterId: t.characterId! })) };
    assert.deepEqual(foldedChips([second, seen]), { text: "Rolls 1/2", label: "Rolls 1/2: 2 roll requests, 1 of 2 answered. Close the sheet to see them." });
    assert.equal(foldedChips([seen]).label, "Rolls 1/1: 1 roll request, 1 of 1 answered. Close the sheet to see it.", "one request is it, not them (LPD-DMPHONE-8)");
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
    assert.equal(canApply({ t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 18, tag: "answer-3" }, P1, hidden, deps).ok, true);
    assert.equal(applyOp(hidden, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 18, tag: "answer-3" }, P1, env(3)).ok, false);
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
    assert.equal(dmAnswerText(state.rolls.r1!.targets[0]!, state.rolls.r1!.test), "waiting again, was failed without rolling");

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
    assert.equal(applyOp(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 9, tag: "answer-3" }, P1, env(3)).ok, false, "the reducer holds to it");
    assert.equal(finalAnswerText({ characterId: "ayla", total: 12, result: "fail" }, DEX_SAVE), "Sent 12. Fail", "with the result, as the chip says it (LP5-ROLLS-5)");
    assert.equal(finalAnswerText({ characterId: "ayla", noRoll: true, result: "fail" }, DEX_SAVE), "Failed without rolling");
    assert.equal(finalAnswerText({ characterId: "ayla", result: "fail" }, DEX_SAVE), "Marked Fail by the DM");
  });

  test("with two choices the chip and the final line say which one was rolled", () => {
    let state = ask(setup(), { choices: [{ kind: "save", ability: "str" }, { kind: "save", ability: "dex" }], dc: "15", dcShown: false });
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

  test("Roll asked names the request its tap opens: the mounted card, else the newest waiting (LPD-PLAYER-6)", () => {
    const wis = { kind: "check" as const, choices: [{ ability: "wis" as const }] };
    const requests = newestFirst({ a: request("a", 1), b: request("b", 2, wis) });
    const needs = new Map([["a", true], ["b", true]]);
    const opens = (folded: string[], opened: string | null) => requestToOpen(requests, needs, new Set(folded), opened)?.id ?? null;
    // Card A opened from its chip and typed into, B put off with Later: the tap opens A, so the summary names A.
    assert.equal(rollsSummary(requests, opens(["b"], "a")).name, "the DM asks for a Dexterity saving throw and 1 more roll");
    assert.equal(sheetSummary(requests, opens(["b"], "a")).label, "Roll asked: the DM asks for a Dexterity saving throw and 1 more roll. Close the sheet to answer.");
    // Both put off with Later: the newest waiting comes back, and the summary names it.
    assert.equal(rollsSummary(requests, opens(["a", "b"], null)).name, "the DM asks for a Wisdom check and 1 more roll");
    // An answered card opened to change it while another request waits: the tap opens the answered card, and the waiting one is the 1 more.
    const answeredA = { ...request("a", 1), targets: [{ characterId: "ayla", total: 15 }] };
    const mixed = newestFirst({ a: answeredA, b: request("b", 2, wis) });
    const tapOpens = requestToOpen(mixed, new Map([["a", false], ["b", true]]), new Set(["b"]), "a")?.id ?? null;
    assert.equal(tapOpens, "a");
    assert.equal(rollsSummary(mixed, tapOpens).name, "the DM asks for a Dexterity saving throw and 1 more roll");
  });

  test("a chip put off with Later is named by its lines alone, and offers a change only once it has an answer (LPD-PLAYER-6)", () => {
    const waiting = request("w", 1);
    assert.equal(chipName(waiting, [chipLine(waiting, waiting.targets[0]!)]), "Dex save: waiting for your roll.");
    const sent = { ...request("s", 2), targets: [{ characterId: "ayla", total: 15 }] };
    assert.equal(chipName(sent, [chipLine(sent, sent.targets[0]!)]), "Dex save: sent 15. Open to change it.");
    const half = { ...request("h", 3), targets: [{ characterId: "ayla", total: 9 }, { tokenId: "wolf" }] };
    assert.equal(chipName(half, ["Dex save (Ayla): sent 9.", "Dex save (Wolf): waiting for your roll."]), "Dex save (Ayla): sent 9. Dex save (Wolf): waiting for your roll. Open to change it.");
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
    assert.equal(sheetSummary([answeredOne]).label, "Rolls 1/1: 1 roll request, 1 of 1 answered. Close the sheet to see it.");
    assert.deepEqual(answeredCount([answeredOne, waiting]), { text: "Rolls 1/2", name: "rolls 1 of 2 answered" });
  });

  test("folded under a popover of the tool's options, the summary says its tap opens the card, since there is no sheet to close", () => {
    let state = ask(setup(), { dc: "15" });
    const waiting = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.deepEqual(sheetSummary([waiting], null, "popover"), { text: "Roll asked", label: "Roll asked: the DM asks for a Dexterity saving throw. Open it to answer." });
    state = run(state, { t: "roll.answer", rollId: "r1", target: { characterId: "ayla" }, total: 17 }, P1, 2);
    const answeredOne = projectState(state, P1, { sceneId: null }).rolls.r1!;
    assert.equal(sheetSummary([answeredOne], null, "popover").label, "Rolls 1/1: 1 roll request, 1 of 1 answered. Open to see it.");
    assert.equal(foldedChips([answeredOne, waiting], "sheet", "popover").label, "Rolls 1/2: 2 roll requests, 1 of 2 answered. Open to see them.");
    assert.equal(foldedChips([answeredOne], "more", "popover").label, "Rolls 1/1: 1 more roll request, 1 of 1 answered.", "showing more chips says nothing of the popover");
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
    assert.deepEqual(startingAnswer({}, draft), { text: "14", choice: 1, focused: false, inputs: NO_INPUTS });
    assert.deepEqual(startingAnswer({}, undefined), { text: "", choice: 0, focused: false, inputs: NO_INPUTS }, "with nothing typed the card starts empty");
  });

  test("gives way to an answer sent since it was typed, from this player's other device", () => {
    assert.deepEqual(startingAnswer({ total: 9, choice: 0 }, { text: "14", choice: 1, base: answerKey({}), focused: true, inputs: NO_INPUTS }), { text: "9", choice: 0, focused: false, inputs: NO_INPUTS });
    const sent = answerKey({ total: 9, choice: 0 });
    assert.deepEqual(startingAnswer({ total: 9, choice: 0 }, { text: "12", choice: 1, base: sent }), { text: "12", choice: 1, focused: false, inputs: NO_INPUTS }, "a change typed over a sent answer stays");
    assert.deepEqual(startingAnswer({ result: "fail", noRoll: true }, { text: "12", choice: 1, base: answerKey({}) }), { text: "", choice: 0, focused: false, inputs: NO_INPUTS }, "a save failed without rolling elsewhere wins too");
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
    assert.deepEqual(startingAnswer(reopened.targets[0]!, drafts.get(key)), { text: "", choice: 0, focused: false, inputs: NO_INPUTS });
  });

  test("gives focus back to the Total field when the card mounts again, if the field had it", () => {
    assert.equal(startingAnswer({}, { text: "14", choice: 0, base: answerKey({}), focused: true, inputs: NO_INPUTS }).focused, true);
    assert.equal(startingAnswer({}, { text: "", choice: 0, base: answerKey({}), focused: true, inputs: NO_INPUTS }).focused, true, "a field focused with nothing typed yet too");
  });

  test("keeps the focus mark only while its request's card shows, so a card folded or put aside never takes focus when it comes back", () => {
    const r1 = draftKey("r1", { characterId: "ayla" });
    const r2 = draftKey("r2", { characterId: "ayla" });
    const drafts = new Map<string, AnswerDraft>([
      [r1, { text: "14", choice: 0, base: answerKey({}), focused: true }],
      [r2, { text: "", choice: 0, base: answerKey({}), focused: true }],
    ]);
    keepFocusFor(drafts, "r1");
    assert.equal(drafts.get(r1)?.focused, true, "the card turning with the phone keeps it");
    assert.equal(drafts.get(r2)?.focused, false);
    keepFocusFor(drafts, undefined);
    assert.equal(drafts.get(r1)?.focused, false, "folded");
    assert.equal(drafts.get(r1)?.text, "14", "the typed total stays");
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

describe("the card's one answer path (docs/design-v1-roll-request.md 5.2, 5.6)", () => {
  const request = { test: DEX_SAVE, dc: 13, dcShown: true, resultShown: true, targets: [{ characterId: "ayla" }] };
  const rolled = { characterId: "ayla", total: 17, result: "pass" as const, tag: "t1", dice: { formula: "1d20+5", faces: [12], total: 17 } };
  const offers = (target: RollTarget, text = "", connected = true) => answerOffers({ holds: true, request, target, text, connected, bonusReady: true });

  test("Roll only while the creature waits, the field is empty and the socket is open", () => {
    assert.deepEqual(offers({ characterId: "ayla" }), { roll: true, send: false, fail: true, ask: false, withdraw: false });
    assert.equal(offers({ characterId: "ayla" }, "9").roll, false, "Clear the total to roll instead");
    assert.equal(offers({ characterId: "ayla" }, "", false).roll, false, "Rolling needs a connection");
    assert.equal(offers({ characterId: "ayla", total: 9, result: "fail", tag: "t0" }).roll, false, "a typed answer takes the roll row away");
    assert.equal(offers({ characterId: "ayla", retype: true }).roll, false, "an allowed retype types again and never rolls");
    assert.equal(answerOffers({ holds: false, request, target: { characterId: "ayla" }, text: "", connected: true, bonusReady: true }).fail, false, "a request gone offers nothing");
  });

  test("a rolled answer is final: no Send, no Fail, and an ask instead", () => {
    assert.equal(finalForPlayer(request, rolled), true);
    assert.deepEqual(offers(rolled, "12"), { roll: false, send: false, fail: false, ask: true, withdraw: false });
    assert.deepEqual(offers({ ...rolled, change: { id: "a1", on: "t1", reason: "lucky" } }), { roll: false, send: false, fail: false, ask: true, withdraw: true }, "a newer item replaces the ask");
    assert.equal(offers({ ...rolled, tag: undefined }).ask, false, "an answer from before tags cannot be named");
    const seen = { test: DEX_SAVE, dcShown: true, resultShown: true };
    assert.equal(chipLine(seen, rolled), "Dex save: rolled 17 (1d20+5: 12). Pass. Final.");
    assert.equal(chipLine(seen, { ...rolled, result: "fail", dice: { ...rolled.dice, fails: "stunned" } }), "Dex save: rolled 17 (1d20+5: 12). Fail (Stunned). Final.");
  });

  test("a chip opens to change an answer, or to ask the DM once it is final", () => {
    const seen = { test: DEX_SAVE, dcShown: true, resultShown: true, targets: [rolled] };
    assert.equal(chipName(seen, ["x"]), "x Open to ask the DM to change it.");
    const hidden = { test: DEX_SAVE, dcShown: false, dcHidden: true as const, resultShown: true, targets: [{ characterId: "ayla", total: 9, result: "fail" as const, tag: "t" }] };
    assert.equal(chipName(hidden, ["x"]), "x Open to ask the DM to fix it.");
    assert.equal(chipName(hidden, [chipLine(hidden, hidden.targets[0]!)]), "Dex save: sent 9. Fail. Final. Open to ask the DM to fix it.", "the ask said once (LP7-DICE-12)");
    assert.equal(chipName({ targets: hidden.targets, resultShown: true }, ["x"]), "x Open to change it.", "with the DC shown a typed answer may change");
  });

  test("one op at a time, ended only by its own answer, and a lost one settled by where it landed", () => {
    const all = offers({ characterId: "ayla" });
    let flow = answerFlow(IDLE, { t: "tap", op: "roll", tag: "a", offers: all });
    assert.deepEqual(flow, { busy: { op: "roll", tag: "a" }, error: null });
    assert.equal(answerFlow(flow, { t: "tap", op: "fail", tag: "b", offers: all }), flow, "a second tap while busy is not taken");
    assert.equal(answerFlow(flow, { t: "answer", tag: "b", answer: "taken" }), flow, "another op's answer does not end it");
    assert.deepEqual(answerFlow(flow, { t: "answer", tag: "a", answer: "refused", text: "You are going too fast. Wait a few seconds." }), { busy: null, error: "You are going too fast. Wait a few seconds." });
    assert.deepEqual(answerFlow(flow, { t: "answer", tag: "a", answer: "unknown", landing: "other" }), { busy: null, error: "Another answer came first." });
    assert.deepEqual(answerFlow(flow, { t: "answer", tag: "a", answer: "unknown", landing: "none" }), IDLE, "never landed: Roll comes back, nothing is sent again");
    flow = answerFlow(IDLE, { t: "tap", op: "send", tag: "c", offers: { ...all, send: false } });
    assert.equal(flow, IDLE, "an op not offered is not taken");
    assert.equal(landingOf({ characterId: "ayla", total: 9, tag: "c" }, "c"), "mine");
    assert.equal(landingOf({ characterId: "ayla", total: 9, tag: "x" }, "c"), "other");
    assert.equal(landingOf({ characterId: "ayla" }, "c"), "none");
  });

  test("a typed answer folds the card once all have answered, unless it shows a roll that landed while it was up", () => {
    const two = { targets: [{ characterId: "ayla", total: 9 }, { characterId: "bram" }] };
    assert.equal(foldsAfterSend(two, "c:bram", new Set()), true);
    assert.equal(foldsAfterSend(two, "c:bram", new Set(["c:ayla"])), false, "waits for Done");
    assert.equal(foldsAfterSend({ targets: [{ characterId: "ayla" }, { characterId: "bram" }] }, "c:bram", new Set()), false, "Ayla still waits");
  });

  test("a draft keeps the player's own mode, extra and bonus, and an answer or an ask from another device forgets it", () => {
    const target: RollTarget = { characterId: "ayla" };
    const draft: AnswerDraft = { text: "", choice: 1, base: answerKey(target), inputs: { pressed: "adv", extra: "+1d4", bonus: "5" } };
    assert.deepEqual(startingAnswer(target, draft).inputs, { pressed: "adv", extra: "+1d4", bonus: "5" });
    assert.notEqual(answerKey({ ...target, change: { id: "a", on: "t", reason: "lucky" } }), draft.base, "an ask changes the key");
    assert.notEqual(answerKey({ ...target, total: 12, tag: "t", dice: { formula: "1d20", faces: [12], total: 12 } }), draft.base);
    assert.deepEqual(startingAnswer({ ...target, total: 12, tag: "t", dice: { formula: "1d20", faces: [12], total: 12 } }, draft).text, "", "a rolled total is never typed again");
    assert.equal(startingAnswer(target, undefined, 1).choice, 1, "two choices start at the higher bonus");
  });
});

describe("the DM's live card (docs/design-v1-roll-request.md 6)", () => {
  const dice = (formula: string, faces: number[], total: number, extra: object = {}) => ({ formula, faces, total, ...extra });
  test("an answer tells how it came: rolled with its dice, typed, marked, failed by a condition, changed", () => {
    assert.equal(dmAnswerText({ characterId: "a", total: 17, result: "pass", tag: "t", dice: dice("1d20+5", [12], 17) }, DEX_SAVE), "rolled 17 (1d20+5: 12)");
    assert.equal(dmAnswerText({ characterId: "a", total: 25, result: "pass", tag: "t", dice: dice("1d20+5", [20], 25) }, DEX_SAVE), "rolled 25 (1d20+5: 20), natural 20");
    assert.equal(dmAnswerText({ characterId: "a", total: 17, result: "fail", tag: "t", dice: dice("1d20+5", [12], 17, { fails: "stunned" }) }, DEX_SAVE), "rolled 17 (1d20+5: 12), fails (Stunned)");
    assert.equal(dmAnswerText({ characterId: "a", total: 17, result: "pass", mark: "pass", tag: "t", dice: dice("1d20+5", [12], 17, { fails: "stunned" }) }, DEX_SAVE), "rolled 17 (1d20+5: 12), marked Pass", "the DM's Pass over a condition's fail");
    assert.equal(dmAnswerText({ characterId: "a", total: 9, tag: "t", typedBonus: true, dice: dice("1d20+5", [4], 9) }, DEX_SAVE), "rolled 9 (1d20+5, their bonus: 4)", "the DM reads the player's typed bonus as theirs (LP7-DICE-11)");
    assert.equal(dmAnswerText({ characterId: "a", total: 3, result: "pass", mark: "pass", tag: "t" }, DEX_SAVE), "typed 3, marked Pass");
    assert.equal(dmAnswerText({ characterId: "a", result: "fail", mark: "fail", tag: "t" }, DEX_SAVE), "marked Fail");
    const two = { kind: "save" as const, choices: [{ ability: "str" as const }, { ability: "dex" as const }] };
    assert.equal(dmAnswerText({ characterId: "a", choice: 1, total: 17, tag: "t", dice: dice("1d20+5", [12], 17) }, two), "Dex: rolled 17 (1d20+5: 12)");
    assert.equal(
      dmAnswerText({ characterId: "a", total: 15, result: "pass", tag: "u", previous: { total: 12, result: "fail", tag: "t", dice: dice("1d20+5", [7], 12) } }, DEX_SAVE),
      "typed 15, changed from rolled 12 (1d20+5: 7) (Fail)",
    );
    assert.equal(
      dmAnswerText(
        { characterId: "a", total: 19, result: "pass", tag: "u", dice: dice("1d20+5", [14], 19), changed: { id: "k", on: "t", reason: "heroic-inspiration", face: 0 }, previous: { total: 9, tag: "t", dice: dice("1d20+5", [4], 9) } },
        DEX_SAVE,
      ),
      "rerolled 19 (Heroic Inspiration), was 9",
    );
  });

  test("Lucky reads as the roll it made: advantage on a normal roll, a normal roll on a disadvantage one (LP7-DICE-4)", () => {
    const lucky = { id: "k", on: "t", reason: "lucky" as const };
    assert.equal(
      dmAnswerText({ characterId: "a", total: 19, tag: "u", dice: dice("2d20kh1+5", [4, 14], 19, { mode: "adv" }), changed: lucky, previous: { total: 9, tag: "t", dice: dice("1d20+5", [4], 9) } }, DEX_SAVE),
      "used Lucky: 19 (1d20+5 with advantage: 4 dropped, 14), was 9",
    );
    assert.equal(
      dmAnswerText({ characterId: "a", total: 10, tag: "u", dice: dice("1d20+3", [7], 10, { cancelled: true }), changed: lucky, previous: { total: 10, tag: "t", dice: dice("2d20kl1+3", [7, 13], 10, { mode: "dis" }) } }, DEX_SAVE),
      "used Lucky: 10 (1d20+3: 7), was 10",
    );
  });

  test("the title row counts passes and fails, and the asks waiting for the DM", () => {
    const request = { targets: [{ characterId: "a", total: 17, result: "pass" as const }, { characterId: "b", total: 9, result: "fail" as const, change: { id: "k", on: "t", reason: "lucky" as const } }, { characterId: "c" }] };
    assert.deepEqual(tallyText(request), { answered: "2 of 3 answered: 1 pass, 1 fail", asks: "1 asks to change a roll" });
    assert.deepEqual(tallyText({ targets: [{ characterId: "a", total: 9 }, { characterId: "c" }] }), { answered: "1 of 2 answered", asks: null });
  });
});
