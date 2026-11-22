import assert from "node:assert/strict";
import { resolveDiceOp, type DiceOp } from "#shared/dice/resolve.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op, OpType } from "#shared/protocol.ts";
import { actor, character, companionBlock, drawing, entry, room, template, token } from "#shared/testutil.ts";

/*
 * A table for the limits' tests of a player's own ops (D-261119-003,
 * D-261119-011): a room where P1 plays Hero with a companion, a creature
 * the DM lent them, an area, a line, a row and a door, and one op of each
 * kind the random rooms reach too seldom.
 */

const withoutRev = <T extends { rev: number }>(thing: T): Omit<T, "rev"> => {
  const { rev: _rev, ...rest } = thing;
  return rest;
};

/** A room where P1 plays Hero (c1) with a companion, a creature the DM lent them, an area, a line, a row and a door, every rev at 9. */
export function playerTable(): RoomState {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], rev: 9, actor: actor({ notes: "", dmNotes: "" }) });
  state.tokens.hero = token("hero", { kind: "pc", rev: 9, actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
  state.tokens.pet = token("pet", { rev: 9, companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 3, y: 2, actor: { inline: actor({ dmNotes: "" }) } });
  state.tokens.lent = token("lent", { rev: 9, ownerIds: ["p1"], x: 4, y: 2, actor: { inline: actor({ dmNotes: "" }) } });
  state.templates.a1 = template("a1", { rev: 9 });
  state.drawings.d1 = drawing("d1", { rev: 9 });
  state.members.p1 = { ...state.members.p1!, rev: 9 };
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("rhero", { tokenId: "hero" })] };
  state.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 9, cells: {}, edges: { "3,2,w": { kind: "door", state: "closed", secret: false, discovered: false } } } };
  return state;
}

/** A server's dice for a player's ask, each the die's highest face. */
export const rolled = (state: RoomState, op: DiceOp): Op => {
  const resolved = resolveDiceOp(op, state, { draw: (sides) => sides, batch: "AbCdEfGhIjKlMnOp" });
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.message);
  return resolved.op;
};

/**
 * One op of each kind a player may send that the random rooms reach too
 * seldom, on playerTable() after `room`: the limits' fixed tables
 * (sizeGuard.exact.test.ts, sizeGuard.widths.test.ts).
 */
export const PLAYER_OPS: Partial<Record<OpType, { op: (state: RoomState) => Op; room?: (state: RoomState) => void }>> = {
  "member.update": { op: () => ({ t: "member.update", memberId: "p1", name: "Pat the Bold" }) as Op },
  "character.create": { op: () => ({ t: "character.create", character: { id: "c9", name: "Cade", size: "medium", ownerIds: ["p1"], actor: actor({ notes: "A second hero", dmNotes: "" }) } }) as Op },
  "character.update": { op: () => ({ t: "character.update", characterId: "c1", patch: { actor: { notes: "n".repeat(400), sheetUrl: "https://example.com/sheet" } } }) as Op },
  "template.create": { op: () => ({ t: "template.create", template: { id: "a2", sceneId: "s1", shape: "sphere", size: 10, origin: { x: 2.5, y: 2.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "p1", visibility: "all", label: "Bless" } }) as Op },
  "template.update": { op: () => ({ t: "template.update", templateId: "a1", patch: { label: "Spirit Guardians", attachedTo: "hero" } }) as Op },
  "encounter.add": { op: () => ({ t: "encounter.add", entries: [{ id: "rpet", tokenId: "pet" }] }) as Op },
  "encounter.setValue": { op: () => ({ t: "encounter.setValue", entryId: "rhero", value: 100 }) as Op },
  "actor.effect.update": {
    room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, effects: [{ id: "e1", key: "custom", label: "short" }] } }),
    op: () => ({ t: "actor.effect.update", target: { characterId: "c1" }, effectId: "e1", patch: { label: "a much longer label for the effect" } }) as Op,
  },
  "actor.effect.remove": {
    room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, effects: [{ id: "e1", key: "custom", label: "short" }] } }),
    op: () => ({ t: "actor.effect.remove", target: { characterId: "c1" }, effectId: "e1" }) as Op,
  },
  "actor.deathSave": {
    room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, hp: { cur: 0, max: 20, temp: 0 }, life: "dying" } }),
    op: () => ({ t: "actor.deathSave", target: { characterId: "c1" }, ok: 1, fail: 2 }) as Op,
  },
  "actor.deathRoll": {
    room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, hp: { cur: 0, max: 20, temp: 0 }, life: "dying" } }),
    op: (s) => rolled(s, { t: "actor.deathRoll", tag: "t1", target: { characterId: "c1" } } as DiceOp),
  },
  "dice.roll": { op: (s) => rolled(s, { t: "dice.roll", tag: "t1", to: "all", rolls: [{ formula: "1d20", label: "Bite", creature: { tokenId: "pet" } }] } as DiceOp) },
  "token.moveMany": { op: () => ({ t: "token.moveMany", moves: [{ tokenId: "pet", x: 13, y: 12 }, { tokenId: "lent", x: 14, y: 12 }] }) as Op },
  "token.update": { op: () => ({ t: "token.update", tokenId: "lent", patch: { notes: "A borrowed wolf" } }) as Op },
  // A seat on the scene: the random rooms stand many tokens past their scene's edge, where a player's seat is refused (DROP-OFF-MAP).
  "token.attach": {
    room: (s) => (s.tokens.pet = { ...s.tokens.pet!, size: "large" }),
    op: () => ({ t: "token.attach", tokenId: "hero", to: "pet", kind: "ride", x: 3, y: 2, elevation: 0 }) as Op,
  },
  "door.set": { op: () => ({ t: "door.set", sceneId: "s1", door: { edge: "3,2,w" }, state: "open", by: "hero" }) as Op },
  // An HP change that drops their companion to 0, ending its concentrations, some hidden from players, into its line.
  "actor.hp": {
    room: (s) => {
      const conc = (id: string, hiddenFromPlayers?: true) => ({ id, key: "concentrating" as const, spell: `${id} `.repeat(60), ...(hiddenFromPlayers ? { hiddenFromPlayers } : {}) });
      const pet = s.tokens.pet!;
      if ("inline" in pet.actor) s.tokens.pet = { ...pet, actor: { inline: { ...pet.actor.inline, effects: [conc("c1"), conc("c2"), conc("c3"), conc("h1", true), conc("h2", true)] } } };
    },
    op: () => ({ t: "actor.hp", target: { tokenId: "pet" }, change: { kind: "damage", amount: 50 } }) as Op,
  },
  // A Long Rest stamps their character by the room's clock.
  "actor.rest": {
    room: (s) => (s.clock = { id: "k1", rev: 0, t: 86_400, shown: true, calendar: { kind: "days" } }),
    op: () => ({ t: "actor.rest", target: { characterId: "c1" }, kind: "long" }) as Op,
  },
  "token.create": { op: () => ({ t: "token.create", token: { id: "pet2", sceneId: "s1", kind: "npc", layer: "token", name: "Hoot", size: "small", x: 1, y: 2, companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], actor: { inline: actor({ hp: { cur: 5, max: 5, temp: 0 }, dmNotes: "" }) } } }) as Op },
  "actor.effect.add": { op: () => ({ t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "e2", key: "blessed" } }) as Op },
  "actor.effects": { op: () => ({ t: "actor.effects", add: [{ target: { tokenId: "pet" }, effect: { id: "e3", key: "prone" } }] }) as Op },
  "actor.use": { op: () => ({ t: "actor.use", target: { tokenId: "pet" }, use: { kind: "ability", key: "actions:bite", name: "Bite", limit: "day", max: 2 } }) as Op },
  "companionBlock.create": { op: () => ({ t: "companionBlock.create", block: withoutRev(companionBlock("b1", "c1")) }) as Op },
  "companionBlock.update": { room: (s) => (s.companionBlocks.b1 = companionBlock("b1", "c1", { rev: 9 })), op: () => ({ t: "companionBlock.update", blockId: "b1", patch: { ac: 17 } }) as Op },
  "cast.ask": { op: () => ({ t: "cast.ask", cast: { id: "k9", caster: "hero", sceneId: "s1", spell: "Hold Person", targets: ["pet"], roll: "spells:Hold Person" } }) as Op },
  // Whether Hero's last leg counts, on Hero's turn.
  "token.countLeg": {
    room: (s) => {
      s.encounter = { ...s.encounter!, activeEntryId: "rhero", turnStart: { entryId: "rhero", tokenId: "hero", sceneId: "s1", x: 1, y: 2, elevation: 0, seq: 7 } };
      s.tokens.hero = { ...s.tokens.hero!, path: { turn: 7, stops: [{ x: 1, y: 2, elevation: 0 }, { x: 2, y: 2, elevation: 0, moved: 5, cost: 5 }] } };
    },
    op: () => ({ t: "token.countLeg", tokenId: "hero", counts: false }) as Op,
  },
  // A player's Undo of their line's delete, as the server builds it from their own history (design 7.7).
  "sys.restore": { op: () => ({ t: "sys.restore", from: "undo", deps: true, entries: [{ key: "drawing:d2", value: drawing("d2", { points: [1, 1, 4, 4, 6, 2] }), expectRev: null }] }) as Op },
};
