import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { actor, DM, effect, entry, P1, room, token } from "#shared/testutil.ts";

/*
 * The turn card's Opportunity Attacks (docs/design/design-v1-opportunity-attacks.md
 * 1 and 6): the block's model from the turn's jobs, a block for a creature
 * with rows and nothing else, a shared mount's own block, the folded row's
 * words, a dismissed card brought back by a new row, and the block's words,
 * its 44 px Reaction used buttons and its group as they draw.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { combatAlerts, reachByMover, returned, NO_REACH } = await import("./alerts.ts");
const { TurnCard, turnUsesText, reachRowText, reactionUsedOp, REACH_WORDS, REACH_ROWS } = await import("./TurnCard.tsx");
type TurnReach = import("./opportunity.ts").TurnReach;
type BlockReach = import("./alerts.ts").BlockReach;

/** Bree, p1's, on her turn beside two goblins with tracker rows, one of them Hidden from players' sight by nothing, the other's Reaction spent. */
function fight(): RoomState {
  return room({
    tokens: {
      bree: token("bree", { kind: "pc", name: "Bree", ownerIds: ["p1"], disposition: "ally", x: 4, y: 4 }),
      g1: token("g1", { name: "Goblin", number: 1, x: 5, y: 4 }),
      g2: token("g2", { name: "Goblin", number: 2, x: 5, y: 5 }),
      hydra: token("hydra", { name: "Hydra", size: "huge", x: 7, y: 3 }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: "eb", started: true, entries: [entry("eb", { tokenId: "bree", value: 18 }), entry("e1", { tokenId: "g1", value: 12 }), entry("e2", { tokenId: "g2", value: 10, reactionUsed: true }), entry("eh", { tokenId: "hydra", value: 9, reactionUsed: true })] },
  });
}

function reachOf(moverId: string, rows: { id: string; known?: boolean; extra?: string }[], more: Partial<TurnReach["movers"][string]> = {}): TurnReach {
  return {
    key: "k",
    movers: { [moverId]: { turn: 1, legs: [], rows: rows.map((r) => ({ moverId, leg: 1, left: { id: r.id, spot: 1, reach: 5, known: r.known ?? true, ...(r.extra ? { extra: r.extra } : {}) } })), checking: false, over: false, ...more } },
    fresh: { seq: 0, rows: [] },
  };
}

describe("a block's Opportunity Attacks, as the model reads the turn's jobs", () => {
  test("rows by the names this viewer reads, Reaction used where this viewer may mark a free one, a trait for more Reactions", () => {
    const state = fight();
    const out = reachByMover(state, DM, new Map(), reachOf("bree", [{ id: "g1" }, { id: "hydra", extra: "Reactive Heads" }]), () => null);
    assert.deepEqual(out.bree!.rows, [
      { id: "g1", name: "Goblin 1", fiveFt: false, trait: null, mark: { kind: "row", entryId: "e1", tokenId: "g1" } },
      { id: "hydra", name: "Hydra", fiveFt: false, trait: "Hydra: Reactive Heads", mark: null },
    ]);
    // A player marks no goblin's Reaction, and reads a creature counted at 5 ft as such.
    const player = reachByMover(state, P1, new Map(), reachOf("bree", [{ id: "g1", known: false }]), () => null);
    assert.deepEqual(player.bree!.rows, [{ id: "g1", name: "Goblin 1", fiveFt: true, trait: null, mark: null }]);
  });

  test("a Reaction marked on this device keeps its row's Reaction used until the server's copy has it", () => {
    const state = fight();
    const marked = { ...state, encounter: { ...state.encounter!, entries: state.encounter!.entries.map((e) => (e.id === "e1" ? { ...e, reactionUsed: true } : e)) } };
    const mark = { kind: "row", entryId: "e1", tokenId: "g1" };
    assert.deepEqual(reachByMover(marked, DM, new Map(), reachOf("bree", [{ id: "g1" }]), () => null, state).bree!.rows[0]!.mark, mark, "sent, not yet taken");
    assert.equal(reachByMover(marked, DM, new Map(), reachOf("bree", [{ id: "g1" }]), () => null, marked).bree!.rows[0]!.mark, null, "taken");
    assert.equal(reachByMover(marked, DM, new Map(), reachOf("bree", [{ id: "g1" }]), () => null).bree!.rows[0]!.mark, null, "with no server's copy given, the view's");
  });

  test("the mover Invisible or Hidden, and a trait of its block that avoids them, as the Owl's Flyby", async () => {
    const state = fight();
    state.tokens.bree = { ...state.tokens.bree!, actor: { inline: actor({ effects: [effect("i1", { key: "hidden" })] }) } };
    const owl = (await loadMonsters()).find((m) => m.srdId === "owl")!;
    const out = reachByMover(state, DM, new Map(), reachOf("bree", [{ id: "g1" }]), () => owl);
    assert.equal(out.bree!.unseen, true);
    assert.equal(out.bree!.avoid, "Flyby");
  });

  test("nothing while a mover's jobs found no row and none runs, and its live region says the rows new on this device", () => {
    assert.deepEqual(reachByMover(fight(), DM, new Map(), reachOf("bree", []), () => null), {});
    const fresh: TurnReach = { ...reachOf("bree", [{ id: "g1" }]), fresh: { seq: 2, rows: [{ moverId: "bree", leg: 1, left: { id: "g1", spot: 1, reach: 5, known: true } }] } };
    assert.equal(reachByMover(fight(), DM, new Map(), fresh, () => null).bree!.announce, "Left Goblin 1's reach.");
  });

  test("a creature with rows alone gets the card, a shared mount gets a block of its own, and the folded words lead with the notice", () => {
    const state = fight();
    const rows: BlockReach = { ...NO_REACH, rows: [{ id: "g1", name: "Goblin 1", fiveFt: false, trait: null, mark: null }] };
    const participant = { target: { tokenId: "bree" }, holder: "t:bree", name: "Bree", record: null, landing: true };
    const none = combatAlerts({ labels: new Map(), view: state, you: P1, participants: [participant], uses: [[]], loading: false, failed: false, dismissed: new Set() });
    assert.equal(none.turn, null, "no uses, attacks or rows: no card");
    const card = combatAlerts({ labels: new Map(), view: state, you: P1, participants: [participant], uses: [[]], loading: false, failed: false, dismissed: new Set(), reach: { bree: rows } });
    assert.deepEqual(card.turn?.blocks.map((b) => b.participant.holder), ["t:bree"]);
    assert.deepEqual(card.turn?.left, ["Goblin 1"]);
    assert.equal(turnUsesText(card.turn!), "left Goblin 1's reach");
    state.tokens.horse = token("horse", { name: "Warhorse", kind: "npc", disposition: "ally", x: 4, y: 4 });
    const mounted = combatAlerts({ labels: new Map(), view: state, you: P1, participants: [participant], uses: [[]], loading: false, failed: false, dismissed: new Set(), reach: { horse: rows } });
    assert.deepEqual(mounted.turn?.blocks.map((b) => b.participant.holder), ["t:horse"], "the mount's rows under the Warhorse, none under the rider");
    const elsewhere = combatAlerts({ labels: new Map(), view: state, you: { memberId: "p2", role: "player" }, participants: [], uses: [], loading: false, failed: false, dismissed: new Set(), reach: { horse: rows } });
    assert.equal(elsewhere.turn, null, "a player who does not answer for the turn reads no mount's block");
  });

  test("the folded words", () => {
    assert.equal(turnUsesText({ count: 3, attacks: 2, left: ["Goblin 2"] }), "left Goblin 2's reach, 2 attacks, 3 uses");
    assert.equal(turnUsesText({ count: 0, attacks: 2, left: ["Goblin 2", "Goblin 3", "Goblin 4"] }), "left 3 creatures' reach, 2 attacks");
    assert.equal(turnUsesText({ count: 1, attacks: 0, left: [] }), "1 use");
  });

  test("a new row brings a dismissed card back, folded where it folds", () => {
    const back = returned({ dismissed: new Set(["turn|eb|1", "x"]), shown: new Set(["turn|eb|1"]) }, "turn|eb|1");
    assert.deepEqual(back && [[...back.dismissed], [...back.shown]], [["x"], []]);
    assert.equal(returned({ dismissed: new Set(["x"]), shown: new Set() }, "turn|eb|1"), null);
  });
});

describe("the block as it draws", () => {
  function draw(reach: BlockReach, you = DM): string {
    const state = fight();
    const store = createStore(() => ({ view: state, confirmed: state, you: { memberId: you.memberId, role: you.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
    const block = { participant: { target: { tokenId: "bree" }, holder: "t:bree", name: "Bree", record: null, landing: true }, uses: [], count: 0, attacks: 0, reach };
    const model = { id: "turn|eb|1", name: "Bree", blocks: [block], left: reach.rows.map((r) => r.name), count: 0, attacks: 0, since: 0, loading: false, failed: false, usesLoad: { loading: false, failed: false }, rollsFailed: false };
    return renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(TurnCard, { model, folded: false, foldable: true, onShow: () => {}, onDismiss: () => {} }) }),
      }),
    );
  }
  const row = (n: number, mark = true) => ({ id: `g${n}`, name: `Goblin ${n}`, fiveFt: false, trait: null, mark: mark ? ({ kind: "row", entryId: `e${n}`, tokenId: `g${n}` } as const) : null });

  test("a group named Opportunity Attacks over the rows, each with Reaction used, then Unless Bree took the Disengage action.", () => {
    const html = draw({ ...NO_REACH, rows: [row(1), row(2, false)] });
    assert.match(html, /role="group" aria-label="Opportunity Attacks"/);
    assert.match(html, /data-part="opportunity"/);
    assert.equal((html.match(/data-reach-used=""/g) ?? []).length, 1, "a button only where the viewer may mark it");
    assert.match(html, /aria-label="Reaction used: Goblin 1"/);
    assert.ok(html.includes(REACH_WORDS.disengage("Bree")));
    assert.match(html, /aria-live="polite"/);
  });

  test("past eight rows the rest are counted, and the muted lines say the trait, the mover unseen, a check under way and a walk too crowded", () => {
    const rows = Array.from({ length: REACH_ROWS + 3 }, (_, i) => row(i + 1, false));
    const html = draw({ rows, checking: false, over: true, unseen: true, avoid: "Flyby", announce: "Left Goblin 1's reach." });
    assert.equal((html.match(/Goblin \d+<\/span>/g) ?? []).length, REACH_ROWS);
    for (const words of ["and 3 more", REACH_WORDS.over, "Bree has Flyby, which may avoid them.", "Bree is Invisible. Creatures that can&#x27;t see Bree get no Opportunity Attack.", "Left Goblin 1&#x27;s reach."]) assert.ok(html.includes(words), words);
    // A walk still checked with no row yet holds the block for its wait alone, which the shared indicator shows after 200 ms.
    const waiting = draw({ ...NO_REACH, checking: true });
    assert.match(waiting, /aria-label="Opportunity Attacks"/);
    assert.ok(!waiting.includes("Disengage"), "no Disengage line before any row");
  });

  test("a row's words and the op its Reaction used sends", () => {
    assert.equal(reachRowText({ name: "Goblin 2", fiveFt: true, trait: null }), "Goblin 2 (5 ft counted)");
    assert.equal(reachRowText({ name: "Hydra", fiveFt: false, trait: "Hydra: Reactive Heads" }), "Hydra: Reactive Heads");
    assert.deepEqual(reactionUsedOp({ kind: "row", entryId: "e1", tokenId: "g1" }), { t: "encounter.update", entryId: "e1", patch: { reactionUsed: true } });
    assert.deepEqual(reactionUsedOp({ kind: "companion", tokenId: "owl", entryId: "eb" }), { t: "token.update", tokenId: "owl", patch: { companionReaction: true } });
  });
});
