import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { farRule } from "#shared/farLine.ts";
import { EXACT_WIDTH } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { movesAnyToken } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { seatView } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { character, DM, entry, env, room, scene, template, token } from "#shared/testutil.ts";
import { exactCopies, farReadings, farWidths, growthBound, linesHeld, measuredStateBytes, readingAt, type ExactCopy } from "./sizeGuard.ts";

/*
 * LP47A-SHOW-1 (D-261122-041, 042, 043, 050): a hide, a show, a lock, an
 * unlock and a name shown or hidden are bookkeeping (shared/farLine.ts
 * TOGGLE_FIELDS), as is a fight row's hide or show, so they go on past the
 * DM's lines and the players' to the far line itself. That holds only
 * while each is a toggle of fixed width that leaves every player's widths
 * as they were, which these tests read in every combination of the two
 * settings that put creatures in a player's exact part: the stored room
 * grows by one byte for each thing shown or unlocked and by nothing else,
 * and in each player's exact part everything keeps its width (what the
 * part counts past what the stepped part takes out). The changes are what
 * the toggle brings into the player's copy or takes out of it. A creature
 * shown to a player who may move any or apply damage, or an area of
 * theirs, comes in as any thing coming into sight does, at no more than
 * its kind's width in EXACT_WIDTH, which the room keeps for every creature
 * and for one seat's areas (shared/limits.ts keptForPlayers), and a row of
 * theirs as one never hidden counts. An area of theirs riding a creature
 * shown or hidden changes form instead (LP47-OPUS-1), between its copy
 * and the one constant an unseen area counts at, which the room keeps for
 * a seat's riding areas (EXACT_WIDTH.unseenArea). So each player's reading
 * moves by the toggle's bytes and by those widths alone.
 */

const SETTINGS = [
  ["none", false],
  ["all", false],
  [["p1"], false],
  [["p2"], false],
  [[], false],
  ["none", true],
  ["all", true],
  [["p1"], true],
  [["p2"], true],
  [[], true],
] as const;

/**
 * P1's Hero and a wolf of theirs the DM hid, the DM's goblins (one hidden,
 * one shown), two hidden bandits, a locked statue, a figure whose name the
 * DM hid, the DM's hidden area and an area of P1's the DM hid, with a
 * shared line about the goblin, P1's areas riding the lurker and the
 * goblin, and a fight in which the DM hid Hero's row (shown in the twin
 * `rowShown` makes).
 */
function table(moveAny: (typeof SETTINGS)[number][0], damage: boolean, rowShown = false): RoomState {
  const state = room({
    characters: { c1: character("c1", { ownerIds: ["p1"] }) },
    tokens: {
      hero: token("hero", { kind: "pc", name: "Hero", ownerIds: ["p1"], actor: { ref: "c1" }, x: 1, y: 1 }),
      wolf: token("wolf", { name: "Wolf", ownerIds: ["p1"], visibility: "dm", x: 2, y: 8 }),
      lurker: token("lurker", { visibility: "dm", x: 4, y: 4, notes: "Waits under the bridge." }),
      goblin: token("goblin", { x: 6, y: 6 }),
      flank1: token("flank1", { name: "Bandit", visibility: "dm", x: 9, y: 2 }),
      flank2: token("flank2", { name: "Bandit", visibility: "dm", x: 9, y: 3 }),
      statue: token("statue", { name: "Statue", kind: "object", locked: true, x: 12, y: 12 }),
      masked: token("masked", { name: "Bandit chief of the Black Road", nameHidden: true, publicName: "Hooded figure", x: 10, y: 10 }),
    },
    templates: {
      zone: template("zone", { ownerId: "dm1", visibility: "dm", origin: { x: 14, y: 4, z: 0 } }),
      aura: template("aura", { ownerId: "p1", visibility: "dm", origin: { x: 8, y: 8, z: 0 } }),
      // P1's areas riding the hidden lurker, one bare and one labeled, and the shown goblin.
      ward: template("ward", { ownerId: "p1", attachedTo: "lurker", origin: { x: 4, y: 4, z: 0 } }),
      ward2: template("ward2", { ownerId: "p1", attachedTo: "lurker", shape: "cube", size: 10, label: "Hunter's Mark on the bandit leader", origin: { x: 4, y: 4, z: 0 } }),
      mark: template("mark", { ownerId: "p1", attachedTo: "goblin", origin: { x: 6, y: 6, z: 0 } }),
    },
    log: [{ id: "1:0", at: "2026-10-12T20:00:00.000Z", kind: "chat", from: "dm1", text: "The goblin snarls." }],
  });
  state.scenes.s1 = scene("s1", { fogEnabled: false });
  state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("rhero", { tokenId: "hero", value: 15, hidden: !rowShown }), entry("rgob", { tokenId: "goblin", value: 10, tieOrder: 1 })] };
  state.meta = { ...state.meta, settings: { ...state.meta.settings, playersMoveAny: moveAny as RoomState["meta"]["settings"]["playersMoveAny"], playersApplyDamage: damage } };
  return state;
}

const TOGGLES: [string, Op][] = [
  ["the DM's creature shown", { t: "token.update", tokenId: "lurker", patch: { visibility: "all" } }],
  ["the DM's creature hidden", { t: "token.update", tokenId: "goblin", patch: { visibility: "dm" } }],
  ["P1's wolf shown", { t: "token.update", tokenId: "wolf", patch: { visibility: "all" } }],
  ["a group shown", { t: "token.updateMany", tokenIds: ["flank1", "flank2"], patch: { visibility: "all" } }],
  ["the DM's area shown", { t: "template.update", templateId: "zone", patch: { visibility: "all" } }],
  ["P1's area shown", { t: "template.update", templateId: "aura", patch: { visibility: "all" } }],
  ["the statue unlocked", { t: "token.update", tokenId: "statue", patch: { locked: false } }],
  ["the goblin locked", { t: "token.update", tokenId: "goblin", patch: { locked: true } }],
  ["a name revealed", { t: "token.update", tokenId: "masked", patch: { nameHidden: false } }],
  ["the goblin's name hidden", { t: "token.update", tokenId: "goblin", patch: { nameHidden: true } }],
  ["P1's wolf's name hidden", { t: "token.update", tokenId: "wolf", patch: { nameHidden: true } }],
  ["Hero's row shown", { t: "encounter.update", entryId: "rhero", patch: { hidden: false } }],
];

/** An area of theirs riding a creature their copy does not hold, which counts at a constant in every scene's reading (exactCopies). */
const unseen = (part: ExactCopy) => part.shownOn?.kind === "room";

const width = (part: ExactCopy) => part.shown - part.sub;
const total = (parts: { stepped: number; exact: number }) => parts.stepped + parts.exact;
/** A map key's bytes in the measure: the id as JSON and its colon. */
const keyBytes = (id: string) => JSON.stringify(id).length + 1;
/** What an unseen area counts past its key, read once from the bare ward on the hidden lurker. */
const UNSEEN_AREA = (() => {
  const part = exactCopies(table("none", false), "p1").get("template:ward")!;
  assert.ok(unseen(part), "the ward rides a creature P1 does not see");
  return part.shown - keyBytes("ward");
})();

/** The things a toggle wrote, by key, with the bytes each stores past what it stored before. */
function toggled(before: RoomState, after: RoomState): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, was] of Object.entries(before.tokens)) {
    const now = after.tokens[id]!;
    if (now.visibility !== was.visibility || now.locked !== was.locked || now.nameHidden !== was.nameHidden) out.set(`token:${id}`, JSON.stringify(now).length - JSON.stringify(was).length);
  }
  for (const [id, was] of Object.entries(before.templates)) {
    const now = after.templates[id]!;
    if (now.visibility !== was.visibility) out.set(`template:${id}`, JSON.stringify(now).length - JSON.stringify(was).length);
  }
  const rowsHidden = (state: RoomState) => state.encounter!.entries.map((e) => e.hidden).join();
  if (rowsHidden(after) !== rowsHidden(before)) out.set("encounter", JSON.stringify(after.encounter).length - JSON.stringify(before.encounter).length);
  return out;
}

/**
 * What a toggle changes in `player`'s exact part, asserting that what stays
 * keeps its place and widths: the widths of what came in or left, and of
 * what changed form. A name shown or hidden moves the name between what the
 * copy holds and what it hides, so only a creature whose name `op` toggled
 * may change its hidden bytes, and still keeps its width. An area of theirs
 * riding a creature shown or hidden changes form, between the unseen form
 * (a constant) and its copy (LP47-OPUS-1), so its width moves by the change.
 */
function exactChange(before: RoomState, after: RoomState, player: string, op?: Op): { came: Map<string, number>; left: Map<string, number>; switched: Map<string, number> } {
  const renamed = op?.t === "token.update" && "nameHidden" in op.patch ? `token:${op.tokenId}` : null;
  const [was, is] = [exactCopies(before, player), exactCopies(after, player)];
  const came = new Map<string, number>();
  const left = new Map<string, number>();
  const switched = new Map<string, number>();
  for (const [key, part] of is) {
    const old = was.get(key);
    if (!old) came.set(key, width(part));
    else if (unseen(part) !== unseen(old)) {
      assert.deepEqual(part.on, old.on, `${player}'s ${key} keeps its place`);
      switched.set(key, width(part) - width(old));
    } else if (key === renamed) assert.deepEqual([part.on, width(part)], [old.on, width(old)], `${player}'s ${key} keeps its place and width`);
    else assert.deepEqual([part.on, width(part), part.hidden], [old.on, width(old), old.hidden], `${player}'s ${key} keeps its place and widths`);
  }
  for (const [key, part] of was) if (!is.has(key)) left.set(key, width(part));
  return { came, left, switched };
}

describe("LP47A-SHOW-1: a hide, a show, a lock and an unlock are toggles of fixed width that leave every player's widths as they were", () => {
  for (const [moveAny, damage] of SETTINGS) {
    const named = `Who can move any token ${JSON.stringify(moveAny)}, Players apply damage ${damage ? "on" : "off"}`;
    test(named, () => {
      for (const [what, op] of TOGGLES) {
        assert.equal(farRule(op), "exempt", `${what} is bookkeeping`);
        const before = table(moveAny, damage);
        const result = applyOp(before, op, DM, env(5));
        assert.ok(result.ok, `${what}: ${result.ok ? "" : result.message}`);
        const after = result.state;
        // The stored room: one byte more for each thing shown or unlocked, one less for each hidden or locked, nothing else written.
        const things = toggled(before, after);
        assert.ok(things.size > 0, `${what} toggled something`);
        for (const bytes of things.values()) assert.equal(Math.abs(bytes), 1, `${what}: one byte a thing`);
        const stored = [...things.values()].reduce((sum, bytes) => sum + bytes, 0);
        assert.deepEqual([...new Set(result.touched)].sort(), [...things.keys()].sort(), `${what} wrote only what it toggled`);
        assert.equal(measuredStateBytes(after) - measuredStateBytes(before), stored, `${what}: the measure moves by the toggles alone`);
        assert.equal(growthBound(before, after, result.touched), Math.max(0, stored), `${what}: its growth bound is the toggles'`);
        assert.equal(farWidths(after), farWidths(before), `${what}: the far line's widths are as they were`);
        for (const player of ["p1", "p2"]) {
          const at = `${what}, ${player}`;
          const { came, left, switched } = exactChange(before, after, player, op);
          // An area of theirs changes form only as the creature it rides is shown or hidden, and in its unseen form counts the
          // one constant whatever the area holds: a bare area and a labeled cube count alike past their keys.
          for (const key of switched.keys()) {
            const area = after.templates[key.slice("template:".length)]!;
            assert.ok(area.ownerId === player && area.attachedTo !== undefined && things.has(`token:${area.attachedTo}`), `${at}: ${key} changed form only as the creature it rides was shown or hidden`);
            for (const part of [exactCopies(before, player).get(key)!, exactCopies(after, player).get(key)!].filter(unseen)) {
              assert.equal(part.shown - keyBytes(area.id), UNSEEN_AREA, `${at}: ${key} unseen at the constant`);
            }
          }
          // Only a creature or an area shown or hidden comes into or leaves their copy, and only one the settings put in their part.
          const view = seatView(after, player);
          for (const [key, bytes] of came) {
            if (key.startsWith("row:")) {
              // A row of theirs the DM shows comes in as one never hidden counts: at the widths of what their own ops write on it.
              const row = after.encounter!.entries.find((e) => `row:${e.id}` === key)!;
              assert.ok(things.has("encounter") && !row.hidden && after.tokens[row.tokenId!]!.ownerIds.includes(player), `${at}: ${key} came in only as their own row was shown`);
              assert.deepEqual(exactCopies(after, player).get(key), exactCopies(table(moveAny, damage, true), player).get(key), `${at}: ${key} counts as a row never hidden`);
              continue;
            }
            const [kind, id] = key.split(":") as ["token" | "template", string];
            assert.ok(things.has(key) && (kind === "token" ? after.tokens[id]!.visibility : after.templates[id]!.visibility) === "all", `${at}: ${key} came in only as it was shown`);
            assert.ok(view.copy(kind, id) !== null, `${at}: their copy holds ${key}`);
            if (kind === "token") assert.ok(after.tokens[id]!.ownerIds.includes(player) || movesAnyToken(after.meta.settings, player) || damage, `${at}: ${key} is in their part by the settings`);
            else assert.equal(after.templates[id]!.ownerId, player, `${at}: ${key} is their own area`);
            assert.ok(bytes >= 0 && bytes <= (kind === "token" ? EXACT_WIDTH.creature : EXACT_WIDTH.area), `${at}: ${key} comes in at ${bytes} bytes past what it takes out, within its kind's kept width`);
          }
          for (const key of left.keys()) assert.ok(things.has(key) && after.tokens[key.split(":")[1]!]?.visibility === "dm", `${at}: ${key} left only as it was hidden`);
          const lines = [...linesHeld(after, player).values()];
          assert.equal(lines.length, 1, `${at}: the shared line in their part`);
          assert.deepEqual(lines, [...linesHeld(before, player).values()], `${at}: the shared lines as they read them`);
          // So each reading, the room's and the scene's, moves by the toggles' bytes and the widths of what came in or left.
          const sum = (bytes: Map<string, number>) => [...bytes.values()].reduce((total, b) => total + b, 0);
          const moved = sum(came) - sum(left) + sum(switched);
          for (const scope of [{ kind: "room" } as const, { kind: "scene", main: "s1" } as const]) {
            const was = readingAt(farReadings(undefined, before, player), scope)!.after;
            const is = readingAt(farReadings(undefined, after, player), scope)!.after;
            assert.equal(total(is) - total(was), stored + moved, `${at}: the ${scope.kind}'s reading`);
          }
        }
        // The toggle back leaves every player's exact part as it was.
        const back = applyOp(after, reverse(op, before), DM, env(6));
        assert.ok(back.ok);
        for (const player of ["p1", "p2"]) assert.deepEqual(exactCopies(back.state, player), exactCopies(before, player), `${what}, ${player}: the toggle back`);
      }
    });
  }

  test("each kind of thing the settings put in a player's part comes into it at a show in some combination, and each riding area changes form, so the checks above are not empty", () => {
    const came = new Set<string>();
    for (const [moveAny, damage] of SETTINGS) {
      for (const [, op] of TOGGLES) {
        const before = table(moveAny, damage);
        const result = applyOp(before, op, DM, env(5));
        assert.ok(result.ok);
        for (const player of ["p1", "p2"]) {
          const change = exactChange(before, result.state, player, op);
          for (const key of change.came.keys()) came.add(`${player} ${key}`);
          for (const key of change.switched.keys()) came.add(`${player} ${key} changed form`);
        }
      }
    }
    for (const key of ["p1 token:lurker", "p2 token:lurker", "p2 token:wolf", "p1 token:flank2", "p1 template:aura", "p1 row:rhero", "p1 template:ward changed form", "p1 template:ward2 changed form", "p1 template:mark changed form"]) assert.ok(came.has(key), `${key} came in somewhere: ${[...came].join(", ")}`);
  });
});

/** The op that toggles back what `op` toggled on `before`. */
function reverse(op: Op, before: RoomState): Op {
  switch (op.t) {
    case "token.update":
      if ("nameHidden" in op.patch) return { ...op, patch: { nameHidden: before.tokens[op.tokenId]!.nameHidden } };
      return { ...op, patch: "visibility" in op.patch ? { visibility: before.tokens[op.tokenId]!.visibility } : { locked: before.tokens[op.tokenId]!.locked } };
    case "token.updateMany":
      return { ...op, patch: { visibility: before.tokens[op.tokenIds[0]!]!.visibility } };
    case "template.update":
      return { ...op, patch: { visibility: before.templates[op.templateId]!.visibility } };
    case "encounter.update":
      return { ...op, patch: { hidden: before.encounter!.entries.find((e) => e.id === op.entryId)!.hidden } };
    default:
      throw new Error(op.t);
  }
}
