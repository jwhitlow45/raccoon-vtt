import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR_TREATMENT } from "#shared/farLine.ts";
import { parseKey, readEntity, type EntityKey } from "#shared/keys.ts";
import { lineAudience } from "#shared/logRings.ts";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op, OpType } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, drawing, entry, env, P1, randomOp, randomState, rng, room, template, token } from "#shared/testutil.ts";
import { exactCopies } from "./sizeGuard.ts";

/*
 * LP44-PRIV-1 (D-261116-026): everything a player's own ops grow is in that
 * player's exact part (sizeGuard.ts exactCopies), as their copy holds it,
 * so what their adds grow counts there. Each op kind a player may
 * send that can grow the room is checked here: by random rooms and ops, and
 * by a fixed room for the kinds the random ops never reach a player with.
 * What the copy leaves out of a thing stays stepped by design (D-261116-015).
 */

const DEPS = { canUseAsset: () => true, canRestoreAsset: () => true } as never;

/**
 * What a player's op may grow outside their exact part, by op kind. Each is
 * another member's thing or reserved ahead: a creature not theirs whose HP
 * they change under Players apply damage, the turn's end (the fight's
 * history for the DM's Undo, every row's turn marks and the effects it ends
 * on others' creatures), and a trap the step springs (design 6.7).
 */
const OUTSIDE: Partial<Record<OpType, ReadonlySet<string>>> = {
  "actor.hp": new Set(["token", "character"]),
  "encounter.next": new Set(["encounterHistory", "encounter", "token", "character"]),
  "token.move": new Set(["trap", "trapLog", "trapSeen", "chunk"]),
};

/** The keys an op wrote that grew and that the room's measures count: a log line only when it is shared (shared/logRings.ts). */
function grown(before: RoomState, after: RoomState, touched: readonly EntityKey[]): EntityKey[] {
  return touched.filter((key) => {
    const was = readEntity(before, key);
    const now = readEntity(after, key);
    if (JSON.stringify(now ?? null).length <= JSON.stringify(was ?? null).length) return false;
    return parseKey(key)?.kind !== "log" || lineAudience(now as LogEntry) === "shared";
  });
}

/** The keys an op grew outside P1's exact part, less what OUTSIDE allows its kind. The fight's own fields hold P1's rows, which go by `row:`. */
function strays(op: Op, before: RoomState, after: RoomState, touched: readonly EntityKey[]): string[] {
  const exact = exactCopies(after, "p1");
  const allowed = OUTSIDE[op.t] ?? new Set();
  const out: string[] = [];
  for (const key of grown(before, after, touched)) {
    const kind = parseKey(key)?.kind ?? key;
    if (kind === "encounter") {
      const rows = (after.encounter?.entries ?? []).filter((e) => !before.encounter?.entries.some((b) => b.id === e.id && JSON.stringify(b) === JSON.stringify(e)));
      for (const row of rows) if (!exact.has(`row:${row.id}`) && !allowed.has("encounter")) out.push(`row:${row.id}`);
      continue;
    }
    if (!exact.has(key) && !allowed.has(kind)) out.push(key);
  }
  return out;
}

/** The op kinds the random runs reach a player with, and those they never do, which the fixed room below checks. */
const RANDOM_KINDS = new Set<OpType>();

describe("LP44-PRIV-1: what a player's own ops grow is in their exact part", () => {
  test("random rooms: every op a player may send grows only things their exact part holds", () => {
    const apart: string[] = [];
    for (let seed = 1; seed <= 1_500; seed++) {
      const r = rng(seed);
      const state = randomState(r);
      // A random room's asks may name creatures no one owns, which any op then settles away.
      state.casts = {};
      for (let k = 0; k < 8; k++) {
        const op = randomOp(r, state, P1);
        if (FAR_TREATMENT[op.t] === "deletion" || FAR_TREATMENT[op.t] === "server" || !canApply(op, P1, state, DEPS).ok) continue;
        // Late line ids, so the op's lines are the newest, as a live op's are.
        const result = applyOp(state, op, P1, env(1_000_000 + seed * 10 + k));
        if (!result.ok) continue;
        RANDOM_KINDS.add(op.t);
        for (const key of strays(op, state, result.state, result.touched)) apart.push(`${op.t} (seed ${seed}): ${key}`);
      }
    }
    assert.deepEqual(apart.slice(0, 10), [], `${apart.length} writes outside P1's exact part`);
  });

  /** A room where P1 plays Hero (c1) with a companion, a creature the DM lent them, an area, a line and a row. */
  function table(): RoomState {
    const state = room();
    state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ notes: "", dmNotes: "" }) });
    state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
    state.tokens.pet = token("pet", { companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 3, y: 2, actor: { inline: actor({ dmNotes: "" }) } });
    state.tokens.lent = token("lent", { ownerIds: ["p1"], x: 4, y: 2, actor: { inline: actor({ dmNotes: "" }) } });
    state.templates.a1 = template("a1");
    state.drawings.d1 = drawing("d1");
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("rhero", { tokenId: "hero" })] };
    return state;
  }

  const FIXED: Partial<Record<OpType, Op>> = {
    "member.update": { t: "member.update", memberId: "p1", name: "Pat the Bold" } as Op,
    "character.create": { t: "character.create", character: { id: "c9", name: "Cade", size: "medium", ownerIds: ["p1"], actor: actor({ notes: "A second hero", dmNotes: "" }) } } as Op,
    "character.update": { t: "character.update", characterId: "c1", patch: { actor: { notes: "n".repeat(400), sheetUrl: "https://example.com/sheet" } } } as Op,
    "template.create": { t: "template.create", template: { id: "a2", sceneId: "s1", shape: "sphere", size: 10, origin: { x: 2.5, y: 2.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "p1", visibility: "all", label: "Bless" } } as Op,
    "template.update": { t: "template.update", templateId: "a1", patch: { label: "Spirit Guardians", attachedTo: "hero" } } as Op,
    "encounter.add": { t: "encounter.add", entries: [{ id: "rpet", tokenId: "pet" }] } as Op,
    "encounter.setValue": { t: "encounter.setValue", entryId: "rhero", value: 100 } as Op,
    "actor.effect.update": { t: "actor.effect.update", target: { characterId: "c1" }, effectId: "e1", patch: { label: "a much longer label for the effect" } } as Op,
    "actor.deathSave": { t: "actor.deathSave", target: { characterId: "c1" }, ok: 1, fail: 2 } as Op,
    "token.moveMany": { t: "token.moveMany", moves: [{ tokenId: "pet", x: 13, y: 12 }, { tokenId: "lent", x: 14, y: 12 }] } as Op,
    "token.update": { t: "token.update", tokenId: "lent", patch: { notes: "A borrowed wolf" } } as Op,
    // A player's Undo of their line's delete, as the server builds it from their own history (design 7.7).
    "sys.restore": { t: "sys.restore", from: "undo", deps: true, entries: [{ key: "drawing:d2", value: drawing("d2", { points: [1, 1, 4, 4, 6, 2] }), expectRev: null }] } as Op,
  };

  for (const [kind, op] of Object.entries(FIXED)) {
    test(`${kind}: grows only what P1's exact part holds`, () => {
      const state = table();
      if (kind === "actor.effect.update") state.characters.c1 = { ...state.characters.c1!, actor: { ...state.characters.c1!.actor, effects: [{ id: "e1", key: "custom", label: "short" }] } };
      if (kind === "actor.deathSave") state.characters.c1 = { ...state.characters.c1!, actor: { ...state.characters.c1!.actor, hp: { cur: 0, max: 20, temp: 0 }, life: "dying" } };
      const decision = canApply(op!, P1, state, DEPS);
      assert.ok(decision.ok, `P1 may send it: ${JSON.stringify(decision)}`);
      const result = applyOp(state, op!, P1, env(1_000_000));
      assert.ok(result.ok, result.ok ? "" : result.message);
      assert.ok(grown(state, result.state, result.touched).length > 0, "it grows the room");
      assert.deepEqual(strays(op!, state, result.state, result.touched), []);
    });
  }

  /**
   * Kinds the room above stands for: a dice ask the server rolls is a
   * shared line as a chat line is, a death roll, recharge roll or turn
   * prompt writes the actor of the player's creature as a death save or a
   * use does, an effect's removal writes it as an effect's change does, a
   * change ask writes their target of a roll request as an answer does, a climb or a detach poses their creature as a move does,
   * and their Undo and Redo put back their own lines and poses as a restore
   * does (design 7.7).
   */
  const SAME_AS: Partial<Record<OpType, OpType>> = {
    "dice.roll": "log.chat",
    "roll.dice": "log.chat",
    "sys.dice": "log.chat",
    "actor.deathRoll": "actor.deathSave",
    "actor.rechargeRoll": "actor.use",
    "actor.prompt": "actor.use",
    "actor.effect.remove": "actor.effect.update",
    "roll.change": "roll.answer",
    "token.climb": "token.move",
    "token.detach": "token.move",
    undo: "sys.restore",
    redo: "sys.restore",
  };

  /** A door's state in its chunk, the DM's build: fixed width, but for an open door's 2 bytes fewer, set only on a door a creature of theirs reaches. */
  const STEPPED: ReadonlySet<OpType> = new Set<OpType>(["door.set"]);

  test("every op kind a player may send that can grow the room is checked, or the DM's alone", () => {
    const state = table();
    const unchecked: string[] = [];
    for (const kind of Object.keys(FAR_TREATMENT) as OpType[]) {
      if (FAR_TREATMENT[kind] === "deletion" || FAR_TREATMENT[kind] === "server") continue;
      if (RANDOM_KINDS.has(kind) || kind in FIXED || STEPPED.has(kind)) continue;
      const same = SAME_AS[kind];
      if (same !== undefined && (RANDOM_KINDS.has(same) || same in FIXED)) continue;
      // The DM's alone: a player's op of the kind is forbidden before any of its fields is read.
      let decision: ReturnType<typeof canApply> | null = null;
      try {
        decision = canApply({ t: kind } as Op, P1, state, DEPS);
      } catch {
        decision = null;
      }
      if (decision?.ok === false && decision.code === "forbidden") continue;
      unchecked.push(kind);
    }
    assert.deepEqual(unchecked, []);
  });
});
