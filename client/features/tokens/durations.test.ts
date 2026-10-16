import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { resolveDuration } from "#shared/rules/durations.ts";
import { apply, character, entry, room, token } from "#shared/testutil.ts";
import {
  SELF_KEY,
  anchorOptions,
  defaultAnchorKey,
  describeDuration,
  durationInput,
  emptyForm,
  type DurationForm,
} from "./durations.ts";

function fixture(withEncounter: boolean): RoomState {
  const state = room();
  state.characters.hero = character("hero", { name: "Thorn" });
  state.tokens.pc = token("pc", { kind: "pc", name: "Thorn", actor: { ref: "hero" } });
  state.tokens.g1 = token("g1", { name: "Goblin", number: 1 });
  state.tokens.g2 = token("g2", { name: "Goblin", number: 2 });
  if (withEncounter) {
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "e-g1",
      entries: [
        entry("e-pc", { characterId: "hero", value: 18 }),
        entry("e-g1", { tokenId: "g1", value: 15 }),
        entry("e-g2", { tokenId: "g2", value: 9 }),
      ],
    };
  }
  return state;
}

describe("duration form options", () => {
  test("outside combat only the creature itself is offered", () => {
    const state = fixture(false);
    const options = anchorOptions(state, { tokenId: "g1" }, "Goblin 1");
    assert.deepEqual(options, [{ key: SELF_KEY, label: "Goblin 1 (this creature)", anchor: { tokenId: "g1" } }]);
    assert.equal(defaultAnchorKey(state, options), SELF_KEY);
  });

  test("a companion that acts on its character's turn reads as on that character's turn, and its durations count that row (docs/design-v1-combat-flow.md 3.6.8)", () => {
    const state = fixture(true);
    state.tokens.ws = token("ws", { kind: "npc", name: "Wildfire Spirit", companion: { of: "hero", turn: "shared" } });
    const options = anchorOptions(state, { tokenId: "ws" }, "Wildfire Spirit");
    assert.equal(options[0]!.label, "Wildfire Spirit (on Thorn's turn)");
    const input = durationInput({ mode: "turnEnd", rounds: 1, anchorKey: SELF_KEY }, options)!;
    assert.deepEqual(resolveDuration(state, input).anchor, { entryId: "e-pc" });
    state.tokens.ws = { ...state.tokens.ws!, companion: { of: "hero", turn: "own" } };
    assert.equal(anchorOptions(state, { tokenId: "ws" }, "Wildfire Spirit")[0]!.label, "Wildfire Spirit (this creature)");
  });

  test("in combat the other rows follow, and the creature's own row folds into the first option", () => {
    const state = fixture(true);
    const options = anchorOptions(state, { tokenId: "g2" }, "Goblin 2");
    assert.deepEqual(
      options.map((o) => o.key),
      [SELF_KEY, "entry:e-pc", "entry:e-g1"],
    );
    assert.equal(options[1]!.label, "Thorn");
    assert.equal(options[2]!.label, "Goblin 1");
  });

  test("a PC's own row is found through its character, from the token or the character card", () => {
    const state = fixture(true);
    assert.deepEqual(
      anchorOptions(state, { tokenId: "pc" }, "Thorn").map((o) => o.key),
      [SELF_KEY, "entry:e-g1", "entry:e-g2"],
    );
    assert.deepEqual(
      anchorOptions(state, { characterId: "hero" }, "Thorn").map((o) => o.key),
      [SELF_KEY, "entry:e-g1", "entry:e-g2"],
    );
  });

  test("a new duration counts on whoever is acting", () => {
    const state = fixture(true);
    const forPc = anchorOptions(state, { tokenId: "pc" }, "Thorn");
    assert.equal(defaultAnchorKey(state, forPc), "entry:e-g1");
    const forG1 = anchorOptions(state, { tokenId: "g1" }, "Goblin 1");
    assert.equal(defaultAnchorKey(state, forG1), SELF_KEY);
    assert.deepEqual(emptyForm(state, forPc), { mode: "none", rounds: 10, anchorKey: "entry:e-g1" });
  });
});

describe("duration form to op input", () => {
  const state = fixture(true);
  const options = anchorOptions(state, { tokenId: "pc" }, "Thorn");
  const form = (patch: Partial<DurationForm>): DurationForm => ({ mode: "none", rounds: 10, anchorKey: SELF_KEY, ...patch });

  test("each mode", () => {
    assert.equal(durationInput(form({}), options), null);
    assert.deepEqual(durationInput(form({ mode: "turnStart", anchorKey: "entry:e-g1" }), options), {
      mode: "turnStart",
      of: { entryId: "e-g1" },
    });
    assert.deepEqual(durationInput(form({ mode: "turnEnd" }), options), { mode: "turnEnd", of: { tokenId: "pc" } });
    assert.deepEqual(durationInput(form({ mode: "rounds", rounds: 3 }), options), {
      mode: "rounds",
      rounds: 3,
      of: { tokenId: "pc" },
    });
  });

  test("rounds are whole and bounded, and a stale anchor falls back to the creature", () => {
    assert.deepEqual(durationInput(form({ mode: "rounds", rounds: 0 }), options), { mode: "rounds", rounds: 1, of: { tokenId: "pc" } });
    assert.deepEqual(durationInput(form({ mode: "rounds", rounds: 2.7 }), options), { mode: "rounds", rounds: 2, of: { tokenId: "pc" } });
    assert.deepEqual(durationInput(form({ mode: "rounds", rounds: 5000 }), options), {
      mode: "rounds",
      rounds: 1000,
      of: { tokenId: "pc" },
    });
    assert.deepEqual(durationInput(form({ mode: "turnStart", anchorKey: "entry:gone" }), options), {
      mode: "turnStart",
      of: { tokenId: "pc" },
    });
  });

  test("every input is a valid op, and the reducer resolves it as design 9.5 says", () => {
    for (const mode of ["turnStart", "turnEnd", "rounds"] as const) {
      for (const anchorKey of options.map((o) => o.key)) {
        const duration = durationInput(form({ mode, anchorKey, rounds: 4 }), options)!;
        const op = { t: "actor.effect.add", target: { tokenId: "pc" }, effect: { id: "x", key: "blessed", duration } };
        assert.ok(clientOpSchema.safeParse(op).success, `${mode} ${anchorKey}`);
      }
    }
    // "End of X's next turn" during X's own turn needs two crossings.
    const duringOwnTurn = resolveDuration(state, durationInput(form({ mode: "turnEnd", anchorKey: "entry:e-g1" }), options)!);
    assert.deepEqual(duringOwnTurn, { remaining: 2, boundary: "turnEnd", anchor: { entryId: "e-g1" } });
    // The PC's own row is found through the token.
    const self = resolveDuration(state, durationInput(form({ mode: "rounds", rounds: 3 }), options)!);
    assert.deepEqual(self, { remaining: 3, boundary: "turnStart", anchor: { entryId: "e-pc" } });
  });
});

describe("describing a stored duration", () => {
  test("words for each shape, from the viewer's own names", () => {
    const state = fixture(true);
    assert.equal(
      describeDuration(state, { remaining: 1, boundary: "turnStart", anchor: { entryId: "e-g2" } }),
      "Until the start of Goblin 2’s next turn",
    );
    assert.equal(
      describeDuration(state, { remaining: 4, boundary: "turnStart", anchor: { entryId: "e-pc" } }),
      "4 rounds left, ending at the start of Thorn’s turn",
    );
    assert.equal(
      describeDuration(state, { remaining: 2, boundary: "turnEnd", anchor: { entryId: "e-g1" } }),
      "Until the end of Goblin 1’s next turn",
    );
    assert.equal(
      describeDuration(state, { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-g1" } }),
      "Until the end of Goblin 1’s current turn",
    );
    assert.equal(
      describeDuration(state, { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-g2" } }),
      "Until the end of Goblin 2’s next turn",
    );
  });

  test("a duration outside combat says it is paused", () => {
    const state = fixture(false);
    assert.equal(
      describeDuration(state, { remaining: 10, boundary: "turnStart", anchor: { tokenId: "g1" } }),
      "10 rounds left, ending at the start of Goblin 1’s turn, paused (outside combat)",
    );
    assert.equal(
      describeDuration(state, { remaining: 1, boundary: "turnEnd", anchor: { characterId: "hero" } }),
      "Until the end of Thorn’s next turn, paused (outside combat)",
    );
  });

  test("a row this viewer cannot see stays anonymous", () => {
    const state = fixture(true);
    assert.equal(
      describeDuration(state, { remaining: 1, boundary: "turnStart", anchor: { entryId: "hidden-row" } }),
      "Until the start of another creature’s next turn",
    );
  });

  test("a paused duration from the reducer reads as paused", () => {
    let state = fixture(false);
    state = apply(state, {
      t: "actor.effect.add",
      target: { tokenId: "g1" },
      effect: { id: "bless", key: "blessed", duration: { mode: "rounds", rounds: 10, of: { tokenId: "g1" } } },
    });
    const effect = (state.tokens.g1!.actor as { inline: { effects: { duration?: unknown }[] } }).inline.effects[0]!;
    assert.match(describeDuration(state, effect.duration as never), /paused \(outside combat\)$/);
  });
});
