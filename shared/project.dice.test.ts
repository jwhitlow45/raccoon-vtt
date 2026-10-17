import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { DiceResult, LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { dependents, projectEntity } from "./project.ts";
import type { Op, OpOf } from "./protocol.ts";
import { DM, P1, P2, apply, character, member, reveal, room, scene, token } from "./testutil.ts";

/**
 * Who receives a dice line (docs/design-v1-dice.md 5.2), as a matrix of
 * line shapes and viewers: the DM, a co-DM, the roller, another player, a
 * table display, and a player behind a blackout.
 */
const DM2: Viewer = { memberId: "dm2", role: "dm" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const ON_S1 = { sceneId: "s1" };
const TAG = "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d";
const BATCH = "AbCdEfGhIjKlMnOp";

type Roll = OpOf<"dice.roll">["rolls"][number];

function roll(by: Viewer, state: RoomState, to: "all" | "dm", rolls: Roll[], extra: Partial<OpOf<"dice.roll">> = {}): { state: RoomState; entry: LogEntry } {
  const results: DiceResult[] = rolls.map(() => ({ formula: "1d20+2", faces: [11], total: 13 }));
  const op: Op = { t: "sys.dice", asked: { t: "dice.roll", tag: TAG, to, rolls, ...extra }, batch: BATCH, results };
  const next = apply(state, op, by, state.log.length + 1);
  return { state: next, entry: next.log.at(-1)! };
}

function seen(state: RoomState, entry: LogEntry, viewer: Viewer): Extract<LogEvent, { type: "dice" }> | null {
  const projected = projectEntity(keys.log(entry.id), state, viewer, ON_S1) as LogEntry | null;
  return (projected?.data as Extract<LogEvent, { type: "dice" }> | undefined) ?? null;
}

/** The goblin in sight (g1), one in the dark (g3), one hidden by the DM (g4), and Thorn, p1's, a party member. */
function table(): RoomState {
  const state = room({
    members: { dm1: member("dm1", "dm"), dm2: member("dm2", "dm"), p1: member("p1"), p2: member("p2") },
    scenes: { s1: scene("s1", { fogEnabled: true }), s2: scene("s2", { order: 1 }) },
    tokens: {
      g1: token("g1", { x: 2, y: 2 }),
      g3: token("g3", { x: 30, y: 2 }),
      g4: token("g4", { x: 4, y: 4, visibility: "dm" }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 6, y: 6, ownerIds: ["p1"] }),
    },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p2"] }) },
  });
  reveal(state, "s1", { x: 0, y: 0, w: 20, h: 30 });
  return state;
}

const FREE: Roll = { formula: "2d6+3", label: "Longsword" };

describe("who receives a dice line (docs/design-v1-dice.md 5.2)", () => {
  test("an open free roll reaches every member in full, the tag only its roller, and no table display", () => {
    const { state, entry } = roll(P1, table(), "all", [FREE], { dc: 15 });
    for (const v of [DM, DM2]) assert.equal(seen(state, entry, v)?.tag, TAG, `${v.memberId} gets the DM's whole line`);
    assert.equal(seen(state, entry, P1)?.tag, TAG);
    const other = seen(state, entry, P2);
    assert.deepEqual(other, { type: "dice", by: "p1", to: "all", rolls: entry.data?.type === "dice" ? entry.data.rolls : [], batch: BATCH, dc: 15 });
    assert.equal(seen(state, entry, DISPLAY), null);
  });

  test("a secret free roll reaches the DMs and the roller in full, and another player as the bare line", () => {
    const { state, entry } = roll(P1, table(), "dm", [FREE]);
    assert.equal(seen(state, entry, DM)?.rolls.length, 1);
    assert.equal(seen(state, entry, DM2)?.rolls.length, 1);
    assert.equal(seen(state, entry, P1)?.rolls.length, 1);
    assert.deepEqual(seen(state, entry, P2), { type: "dice", by: "p1", to: "dm", rolls: [] });
    assert.equal(seen(state, entry, DISPLAY), null);
  });

  test("the DM's secret roll for a goblin the party sees reads as rolled in secret, and for one in the dark or hidden leaves no trace", () => {
    const g1 = roll(DM, table(), "dm", [{ formula: "1d20+2", creature: { tokenId: "g1" } }]);
    for (const v of [P1, P2]) assert.deepEqual(seen(g1.state, g1.entry, v), { type: "dice", by: "dm1", to: "dm", rolls: [] });
    assert.equal(seen(g1.state, g1.entry, DM2)?.rolls[0]?.tokenId, "g1");
    for (const id of ["g3", "g4"]) {
      const hidden = roll(DM, table(), "dm", [{ formula: "1d20+2", creature: { tokenId: id } }]);
      for (const v of [P1, P2, DISPLAY]) assert.equal(seen(hidden.state, hidden.entry, v), null, `${id} to ${v.memberId}`);
      assert.equal(seen(hidden.state, hidden.entry, DM)?.rolls.length, 1);
    }
  });

  test("a group with some goblins unseen: open, players get the seen ones' rolls; secret, the bare line", () => {
    const rolls: Roll[] = [
      { formula: "1d20+2", creature: { tokenId: "g1" } },
      { formula: "1d20+2", creature: { tokenId: "g3" } },
      { formula: "1d20+2", creature: { tokenId: "g4" } },
    ];
    const open = roll(DM, table(), "all", rolls);
    assert.deepEqual(
      seen(open.state, open.entry, P2)?.rolls.map((r) => r.tokenId),
      ["g1"],
    );
    assert.equal(seen(open.state, open.entry, P2)?.tag, undefined);
    assert.equal(seen(open.state, open.entry, DM2)?.rolls.length, 3);
    const secret = roll(DM, table(), "dm", rolls);
    assert.deepEqual(seen(secret.state, secret.entry, P2), { type: "dice", by: "dm1", to: "dm", rolls: [] });
  });

  test("a character's roll reaches players as a free roll does, and a party member's token roll everyone who sees it", () => {
    const bree = roll(P2, table(), "all", [{ formula: "1d20+5", label: "Stealth", creature: { characterId: "bree" } }]);
    assert.equal(seen(bree.state, bree.entry, P1)?.rolls[0]?.characterId, "bree");
    const thorn = roll(P1, table(), "all", [{ formula: "1d20+5", creature: { tokenId: "thorn" } }]);
    assert.equal(seen(thorn.state, thorn.entry, P2)?.rolls[0]?.tokenId, "thorn");
  });

  test("behind a blackout free and character rolls reach players as chat does, and token rolls neither then nor after", () => {
    let state = table();
    state = { ...state, meta: { ...state.meta, view: { ...state.meta.view, blackout: true } } };
    const free = roll(P1, state, "all", [FREE]);
    assert.equal(seen(free.state, free.entry, P2)?.rolls.length, 1);
    const character = roll(P2, free.state, "all", [{ formula: "1d20", creature: { characterId: "bree" } }]);
    assert.equal(seen(character.state, character.entry, P1)?.rolls.length, 1);
    const goblin = roll(DM, character.state, "all", [{ formula: "1d20", creature: { tokenId: "g1" } }]);
    assert.equal(seen(goblin.state, goblin.entry, P2), null, "nothing of the table behind the blackout");
    const lifted = { ...goblin.state, meta: { ...goblin.state.meta, view: { ...goblin.state.meta.view, blackout: false } } };
    assert.equal(seen(lifted, goblin.entry, P2), null, "nor after it lifts: no one saw the goblin then");
  });

  test("a token revealed later keeps its earlier unseen rolls out of others' logs, and its new owner gets them", () => {
    const dark = roll(DM, table(), "all", [{ formula: "1d20+2", creature: { tokenId: "g3" } }]);
    const revealed = structuredClone(dark.state);
    reveal(revealed, "s1", { x: 0, y: 0, w: 40, h: 30 });
    assert.equal(seen(revealed, dark.entry, P2), null);
    const given = apply(dark.state, { t: "token.update", tokenId: "g3", patch: { ownerIds: ["p2"] } }, DM, 50);
    assert.equal(seen(given, dark.entry, P2)?.rolls[0]?.tokenId, "g3");
    assert.equal(seen(given, dark.entry, P1), null);
  });

  test("a public ac and dc reach players, and a roller removed from the room still has a line", () => {
    const attack = roll(DM, table(), "all", [{ formula: "1d20+4", creature: { tokenId: "g1" }, critOn: 19 }], { ac: 15 });
    assert.equal(seen(attack.state, attack.entry, P1)?.ac, 15);
    assert.equal(seen(attack.state, attack.entry, P1)?.rolls[0]?.critOn, 19);
    const gone = { ...attack.state, members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } };
    const byGone = roll(DM2, gone, "all", [FREE]);
    assert.equal(seen(byGone.state, byGone.entry, P1)?.by, "dm2");
  });

  test("a change to a token re-projects every dice line that names it", () => {
    const { state, entry } = roll(DM, table(), "all", [{ formula: "1d20", creature: { tokenId: "g3" } }, { formula: "1d20", creature: { characterId: "bree" } }]);
    assert.ok(dependents(state, [keys.token("g3")]).includes(keys.log(entry.id)));
    assert.ok(dependents(state, [keys.character("bree")]).includes(keys.log(entry.id)));
    assert.ok(!dependents(state, [keys.token("g1")]).includes(keys.log(entry.id)));
  });
});
