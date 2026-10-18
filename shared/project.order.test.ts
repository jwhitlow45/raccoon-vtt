import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OrderReveal, RoomState, Viewer } from "./model.ts";
import type { Op } from "./protocol.ts";
import { projectState } from "./project.ts";
import { DM, P1, P2, apply, character, room, token } from "./testutil.ts";

/**
 * Which rows of the initiative order players see before each row's first
 * turn (docs/design-v1-combat-flow.md 11): the room's setting, applied by
 * the projection the server sends from, so no player receives a row, total,
 * place or count it hides.
 */

/** A table display's viewer: a player who owns nothing (docs/design-v1-dm-tools.md 3.1). */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

const ROWS = [
  { id: "r-pc", tokenId: "pc1", value: 20 },
  { id: "r-gob", tokenId: "gob", value: 18 },
  { id: "r-ally", tokenId: "ally", value: 16 },
  { id: "r-comp", tokenId: "comp", value: 14 },
  { id: "r-npc", characterId: "npc", value: 12 },
  { id: "r-lent", tokenId: "lent", value: 11 },
  { id: "r-lair", label: "Lair", value: 9 },
  { id: "r-hid", tokenId: "hid", value: 7 },
];

/** A fight of a player character, its companion, a goblin lent to the other player, an Ally NPC, a goblin, the DM's NPC character, a lair and a hidden goblin. */
function fight(reveal: OrderReveal): RoomState {
  const state = room();
  state.meta.settings.playersSeeOrder = reveal;
  state.characters.c1 = character("c1", { ownerIds: ["p1"], name: "Bree" });
  state.characters.npc = character("npc", { ownerIds: [], name: "Captain" });
  state.tokens.pc1 = token("pc1", { kind: "pc", actor: { ref: "c1" }, disposition: "ally", x: 1, y: 1 });
  state.tokens.comp = token("comp", { kind: "npc", name: "Owl", ownerIds: ["p1"], disposition: "ally", companion: { of: "c1", turn: "own" }, x: 2, y: 1 });
  state.tokens.lent = token("lent", { name: "Wolf", ownerIds: ["p2"], x: 3, y: 1 });
  state.tokens.ally = token("ally", { kind: "npc", name: "Guard", disposition: "ally", x: 4, y: 1 });
  state.tokens.gob = token("gob", { x: 5, y: 1 });
  state.tokens.hid = token("hid", { visibility: "dm", x: 6, y: 1 });
  return run(state, { t: "encounter.start", entries: ROWS.map((r) => ({ ...r, ...(r.id === "r-hid" ? { hidden: true } : {}) })) });
}

const rowsOf = (state: RoomState, viewer: Viewer) => projectState(state, viewer, { sceneId: "s1" }).encounter?.entries.map((e) => e.id) ?? [];

/** Each op gets a seq of its own, so every log line keeps its own id. */
let seq = 0;
const run = (state: RoomState, op: Op) => apply(state, op, DM, ++seq);
const next = (state: RoomState) => run(state, { t: "encounter.next" });

/** What every player's copy must hold to keep the order's secrets: only `shown`, numbered 0 to n-1, with no mark of whose turn has come, and none of the others' ids anywhere. */
function holdsOnly(state: RoomState, viewer: Viewer, shown: string[]): void {
  const snapshot = projectState(state, viewer, { sceneId: "s1" });
  const entries = snapshot.encounter!.entries;
  assert.deepEqual(entries.map((e) => e.id), shown, viewer.memberId);
  assert.deepEqual(entries.map((e) => e.tieOrder), shown.map((_, i) => i), "numbered without gaps");
  assert.ok(entries.every((e) => !("hadTurn" in e)), "whose turn has come is the DM's");
  const text = JSON.stringify(snapshot);
  for (const row of ROWS) if (!shown.includes(row.id)) assert.ok(!text.includes(`"${row.id}"`), `${row.id} reaches ${viewer.memberId}`);
}

describe("the initiative order players see (docs/design-v1-combat-flow.md 11)", () => {
  test("before any turn, each choice shows players only its rows, and the DM every row", () => {
    const party = fight("party");
    for (const viewer of [P1, DISPLAY]) holdsOnly(party, viewer, ["r-pc", "r-comp"]);
    holdsOnly(party, P2, ["r-pc", "r-comp", "r-lent"]);
    const allies = fight("allies");
    for (const viewer of [P1, DISPLAY]) holdsOnly(allies, viewer, ["r-pc", "r-ally", "r-comp"]);
    holdsOnly(allies, P2, ["r-pc", "r-ally", "r-comp", "r-lent"]);
    const all = fight("all");
    for (const viewer of [P1, P2, DISPLAY]) holdsOnly(all, viewer, ["r-pc", "r-gob", "r-ally", "r-comp", "r-npc", "r-lent", "r-lair"]);
    for (const state of [party, allies, all]) assert.deepEqual(rowsOf(state, DM), ROWS.map((r) => r.id));
    assert.equal(projectState(party, P1, { sceneId: "s1" }).encounter!.started, false);
  });

  test("a row joins in its place when its turn comes, and stays through later turns, a drag, a new value and later rounds", () => {
    let state = next(fight("party"));
    holdsOnly(state, P1, ["r-pc", "r-comp"]);
    state = next(state);
    assert.equal(state.encounter!.activeEntryId, "r-gob");
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-comp"]);
    assert.equal(projectState(state, P1, { sceneId: "s1" }).encounter!.activeEntryId, "r-gob", "players see whose turn it is");
    assert.equal(projectState(state, P1, { sceneId: "s1" }).encounter!.entries[1]!.value, 18);
    state = next(state);
    holdsOnly(state, P2, ["r-pc", "r-gob", "r-ally", "r-comp", "r-lent"]);
    // A drag settles ties only, and the table delays the goblin with a new value: it stays in their view, in its new place.
    state = run(state, { t: "encounter.reorder", entryIds: ["r-pc", "r-ally", "r-comp", "r-npc", "r-lent", "r-lair", "r-hid", "r-gob"] });
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp"]);
    state = run(state, { t: "encounter.setValue", entryId: "r-gob", value: 3 });
    holdsOnly(state, P1, ["r-pc", "r-ally", "r-comp", "r-gob"]);
    for (let i = 0; i < 12; i++) state = next(state);
    assert.ok(state.encounter!.round >= 2);
    // The hidden goblin too, which "Reveal hidden combatants on their turn" showed on its turn.
    holdsOnly(state, DISPLAY, ["r-pc", "r-ally", "r-comp", "r-npc", "r-lent", "r-lair", "r-hid", "r-gob"]);
  });

  test("a row added mid-fight waits for its turn, a turn passed on by a removal shows its row, and Previous takes a reveal back", () => {
    let state = next(next(fight("party")));
    state.tokens.late = token("late", { name: "Ogre", x: 8, y: 1 });
    state = run(state, { t: "encounter.add", entries: [{ id: "r-late", tokenId: "late", value: 17 }] });
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-comp"]);
    state = next(state);
    assert.equal(state.encounter!.activeEntryId, "r-late");
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-late", "r-comp"]);
    // The Ogre leaves while acting: the Guard's turn starts, and the Guard shows from then on.
    state = run(state, { t: "encounter.remove", entryIds: ["r-late"] });
    assert.equal(state.encounter!.activeEntryId, "r-ally");
    state = next(state);
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp"]);
    // Previous back onto the Guard keeps it, and once more takes back the turn that showed it.
    state = run(state, { t: "encounter.prev" });
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp"]);
    state = run(state, { t: "encounter.prev" });
    assert.ok(state.encounter!.entries.find((e) => e.id === "r-ally")?.hadTurn !== true);
  });

  test("ending the fight forgets whose turn came, so the next fight starts with only the party in view", () => {
    let state = fight("party");
    for (let i = 0; i < 7; i++) state = next(state);
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp", "r-npc", "r-lent", "r-lair"]);
    state = run(state, { t: "encounter.end" });
    state = run(state, { t: "encounter.start", entries: ROWS.filter((r) => r.id !== "r-hid") });
    holdsOnly(state, P1, ["r-pc", "r-comp"]);
  });

  test("a monster lent to a player shows from the start to that player alone, and to the others on its first turn (the project owner, 2026-10-17)", () => {
    let state = fight("party");
    holdsOnly(state, P2, ["r-pc", "r-comp", "r-lent"]);
    holdsOnly(state, P1, ["r-pc", "r-comp"]);
    holdsOnly(state, DISPLAY, ["r-pc", "r-comp"]);
    assert.ok(rowsOf(state, DM).includes("r-lent"));
    for (let i = 0; i < 6; i++) state = next(state);
    assert.equal(state.encounter!.activeEntryId, "r-lent");
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp", "r-npc", "r-lent"]);
    holdsOnly(state, DISPLAY, ["r-pc", "r-gob", "r-ally", "r-comp", "r-npc", "r-lent"]);
    // Taken back from the lent player, it is the DM's again: no player sees it before its turn.
    state = run(fight("party"), { t: "token.update", tokenId: "lent", patch: { ownerIds: [] } });
    holdsOnly(state, P2, ["r-pc", "r-comp"]);
    // A player character played by its token's owner alone, with no character, is still the party's.
    state = fight("party");
    state.tokens.pc1 = { ...state.tokens.pc1!, actor: { inline: state.characters.c1!.actor }, ownerIds: ["p1"] };
    holdsOnly(state, P2, ["r-pc", "r-comp", "r-lent"]);
  });

  test("a ring or setting changed mid-fight applies at once, and rows that had their turn stay", () => {
    let state = next(next(fight("allies")));
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp"]);
    state = run(state, { t: "token.update", tokenId: "ally", patch: { disposition: "neutral" } });
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-comp"]);
    state = run(state, { t: "token.update", tokenId: "ally", patch: { disposition: "ally" } });
    state = run(state, { t: "room.update", settings: { playersSeeOrder: "all" } });
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp", "r-npc", "r-lent", "r-lair"]);
    state = run(state, { t: "room.update", settings: { playersSeeOrder: "party" } });
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-comp"]);
  });

  test("a hidden creature's turn follows Hidden: it stays out while hidden, and shows once unhidden since its turn came", () => {
    let state = fight("party");
    state.meta.settings.revealHiddenOnTurn = false;
    for (let i = 0; i < 8; i++) state = next(state);
    assert.equal(state.encounter!.activeEntryId, "r-hid");
    const acting = projectState(state, P1, { sceneId: "s1" }).encounter!;
    assert.equal(acting.activeEntryId, null, "another creature's turn");
    assert.equal(acting.started, true);
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp", "r-npc", "r-lent", "r-lair"]);
    state = run(state, { t: "encounter.update", entryId: "r-hid", patch: { hidden: false } });
    state = run(state, { t: "token.update", tokenId: "hid", patch: { visibility: "all" } });
    state = next(state);
    holdsOnly(state, P1, ["r-pc", "r-gob", "r-ally", "r-comp", "r-npc", "r-lent", "r-lair", "r-hid"]);
  });

  test("a turn line reaches players with its row, and leaves with it when Previous takes the reveal back", () => {
    let state = next(fight("party"));
    state = next(state);
    const turnLines = (s: RoomState) => projectState(s, P2, { sceneId: "s1" }).log.flatMap((l) => (l.data?.type === "turn" ? [l.data.entryId] : []));
    assert.deepEqual(turnLines(state), ["r-pc", "r-gob"]);
    state = run(state, { t: "encounter.prev" });
    assert.deepEqual(turnLines(state), ["r-pc"], "the goblin's line and its take-back leave with its row");
    assert.ok(projectState(state, DM, { sceneId: "s1" }).log.some((l) => l.data?.type === "turn" && l.data.entryId === "r-gob"));
  });

  test("the DM keeps every row with its mark, which is what the preview projects for a player", () => {
    const state = next(next(fight("party")));
    const dm = projectState(state, DM, { sceneId: "s1" });
    assert.deepEqual(dm.encounter!.entries.filter((e) => e.hadTurn).map((e) => e.id), ["r-pc", "r-gob"]);
    // "View as a player" projects the DM's own view (client/features/dm/preview.ts).
    const preview = projectState(dm as unknown as RoomState, P1, { sceneId: null });
    assert.deepEqual(preview.encounter!.entries.map((e) => e.id), ["r-pc", "r-gob", "r-comp"]);
  });
});
