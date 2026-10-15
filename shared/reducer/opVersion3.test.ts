import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Drawing, LogEvent, RoomState } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, character, drawing, entry, env, reveal, room, template, token } from "../testutil.ts";
import type { Env } from "./tx.ts";

/**
 * Ops stored before op version 4 replay with the rule they were applied
 * under (shared/migrate.ts, step 3 to 4): a creature revealed on its turn
 * (`fogExemptAuto`) counts as seen wherever it stands. Replay hands the
 * reducer the stored version, and a version 3 op must make the very state
 * it made then, or a later stored restore's guard stops the room's load.
 */
const at = (seq: number, opVersion?: number): Env => ({ ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });

function applied(state: RoomState, op: Op, opVersion?: number, who = DM) {
  const r = applyOp(state, op, who, at(2, opVersion));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r;
}

describe("each mark a version 3 op keeps", () => {
  /** Spirit Guardians around a cleric on revealed ground, and a goblin revealed on its turn in the fog east of her, whose turn it is. */
  function aura(): RoomState {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    reveal(state, "s1", { x: 0, y: 0, w: 8, h: 12 });
    state.tokens.cleric = token("cleric", { kind: "pc", name: "Ayla", x: 5, y: 5, ownerIds: ["p1"], disposition: "ally" });
    state.tokens.g1 = token("g1", { name: "Goblin", x: 12, y: 5, fogExemptAuto: true });
    state.templates.sg = template("sg", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, spell: "Spirit Guardians", ownerId: "p1", triggers: ["enter"] });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 }), entry("e-cleric", { tokenId: "cleric", value: 10, tieOrder: 1 })] };
    return state;
  }

  const reminder = (state: RoomState, op: Op, opVersion?: number): Extract<LogEvent, { type: "area" }> => {
    const data = applied(state, op, opVersion).log.find((e) => e.data?.type === "area")?.data;
    assert.ok(data?.type === "area");
    return data;
  };

  test("an area's reminder about a revealed creature in the fog, and one from an aura it carries there", () => {
    const walkIn: Op = { t: "token.move", tokenId: "g1", x: 8, y: 5 };
    assert.equal("seen" in reminder(aura(), walkIn), false, "today the goblin entering in the fog is unseen");
    assert.equal(reminder(aura(), walkIn, 3).seen, true, "version 3 marked it seen");

    const carried = aura();
    delete carried.templates.sg;
    carried.templates.stench = template("stench", { shape: "emanation", size: 15, attachedTo: "g1", includeOrigin: false, spell: "Stench", ownerId: "dm1", triggers: ["enter"] });
    const stepIn: Op = { t: "token.move", tokenId: "cleric", x: 9, y: 5 };
    const today = reminder(carried, stepIn);
    assert.deepEqual([today.seen, today.hidden], [true, true], "the cleric is seen, the aura's goblin is not");
    const then = reminder(carried, stepIn, 3);
    assert.deepEqual([then.seen, then.hidden], [true, undefined], "version 3 counted the goblin, and so its aura, as seen");
  });

  test("a duplicate's kept ruler on a revealed creature left behind in the fog", () => {
    const state = room({ characters: { c1: character("c1", { ownerIds: ["p1"] }) } });
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    state.tokens.pc1 = token("pc1", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 });
    state.tokens.gob1 = token("gob1", { x: 5, y: 5, fogExemptAuto: true });
    state.drawings.ruler = drawing("ruler", { kind: "ruler", points: [1, 1, 5, 5], anchors: ["pc1", "gob1"] });
    const op: Op = { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: true, drawings: true } };
    const copied = (opVersion?: number): Drawing => {
      const copy = Object.values(applied(state, op, opVersion).state.drawings).find((d) => d.sceneId === "s3");
      assert.ok(copy);
      return copy;
    };
    assert.equal(copied().visibility, "dm", "today its stop would show where an unseen creature stands");
    assert.equal(copied(3).visibility, "all", "version 3 counted the goblin as seen");
  });
});

/*
 * Random rooms and ops as the build before op version 4 (daa0716f) applied
 * them: that build's randomState and randomOp, seeds 312, 145 and 341, 30
 * ops each, with the rooms' custom monsters, saved encounters, handouts and
 * SRD images left out and their logs cut to the last 6 lines, to keep the
 * file small. Each room holds a creature revealed on its turn, and today's
 * rule applies some of its ops differently. Each step stores a hash of the
 * state and log that build made, or its refusal. A change that breaks this
 * must keep version 3 ops on the rule they were applied under, as
 * revealSeenAnywhere does, rather than record the file again.
 */
type Step = { who: "dm" | "player"; op: Op } & ({ after: string } | { refused: string });
type Fixture = { build: string; steps: number; rooms: { seed: number; state: RoomState; steps: Step[] }[] };

describe("random rooms the build before op version 4 played", () => {
  test("replay at version 3 to the bytes that build made, where today's rule would not", () => {
    const fixture = JSON.parse(readFileSync(new URL("./opVersion3.fixture.json", import.meta.url), "utf8")) as Fixture;
    assert.equal(fixture.rooms.length, 3);
    for (const room of fixture.rooms) {
      let state = room.state;
      let differs = 0;
      for (const [i, step] of room.steps.entries()) {
        const who = step.who === "dm" ? DM : P1;
        const envelope = { seq: 1000 + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() };
        const label = `seed ${room.seed} step ${i} (${step.op.t})`;
        const r = applyOp(state, step.op, who, { ...envelope, opVersion: 3 });
        const live = applyOp(state, step.op, who, envelope);
        if ("refused" in step) {
          assert.ok(!r.ok && r.message === step.refused, `${label}: refused then`);
          continue;
        }
        assert.ok(r.ok, `${label}: ${r.ok ? "" : r.message}`);
        assert.equal(hash128(stableStringify({ state: r.state, log: r.log })), step.after, label);
        if (!live.ok || hash128(stableStringify({ state: live.state, log: live.log })) !== step.after) differs++;
        state = r.state;
      }
      assert.ok(differs > 0, `seed ${room.seed}: no op applies differently today, so the room tests nothing`);
    }
  });
});
