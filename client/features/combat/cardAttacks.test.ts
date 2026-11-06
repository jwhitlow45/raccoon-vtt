import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { actor, character, customMonster, DM, entry, room, token } from "#shared/testutil.ts";
import { cardAttacks, combatAlerts } from "./alerts.ts";
import { turnParticipants } from "./logic.ts";

/*
 * A creature's attacks on its turn card (QOL audit Q1, D-261106-100): the
 * Dice panel's rows for its attacks in Actions and Bonus Actions, a card
 * for every creature that has them, each row's newest result since its
 * turn began under it, and Apply to under a damage result.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { optionSlot } = await import("../dice/optionState.ts");
const { receiptsSlot } = await import("../dice/useReceipt.ts");
const { AttackRows } = await import("../dice/RollOptions.tsx");
const { blockActions } = await import("#shared/dice/named.ts");
const { monsterView, statBlockOf } = await import("#shared/statBlock.ts");

const named = (name: string, section: NamedRoll["section"], attack?: number): NamedRoll => ({ key: `${section}:${name}`, name, section, damage: [], ...(attack !== undefined ? { attack } : {}) });

describe("cardAttacks", () => {
  test("named rolls with an attack bonus in Actions and Bonus Actions, in their order, nothing else", () => {
    const rolls = [named("Bite", "actions", 4), named("Fire Breath", "actions"), named("Offhand", "bonusActions", 4), named("Tail", "legendaryActions", 6), named("Parry", "reactions", 2), named("Fire Bolt", "spells", 5), named("Pounce", "traits", 3)];
    assert.deepEqual(cardAttacks(rolls).map((r) => r.name), ["Bite", "Offhand"]);
  });
});

/** The lurker's turn, round 1, started at seq 10, with Thorn beside it. */
function table(): RoomState {
  return room({
    monsters: { lurker: customMonster("lurker") },
    characters: { "c-thorn": character("c-thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor() }) },
    tokens: {
      m1: token("m1", { name: "Cave Lurker", x: 5, y: 5, actor: { inline: actor({ monsterId: "lurker" }) } }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 6, y: 5, disposition: "ally", actor: { ref: "c-thorn" } }),
    },
    encounter: { id: "enc", round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "m1", value: 15 }), entry("e2", { tokenId: "thorn", value: 12 })], started: true } as never,
  });
}

describe("the turn card's gating", () => {
  const dmYou = { role: "dm" as const, memberId: "dm1" };
  test("a creature with attacks and no uses gets its card, counting them, and one with neither gets none", () => {
    const view = table();
    const participants = turnParticipants(view);
    const base = { view, you: dmYou, participants, uses: participants.map(() => []), loading: false, failed: false, dismissed: new Set<string>() };
    assert.equal(combatAlerts(base).turn, null, "no attacks known: as before, no card");
    const withAttacks = combatAlerts({ ...base, attacks: participants.map(() => 1) });
    assert.deepEqual([withAttacks.turn?.attacks, withAttacks.turn?.count, withAttacks.turn?.blocks.length], [1, 0, 1]);
    assert.equal(combatAlerts({ ...base, attacks: participants.map(() => 0) }).turn, null);
  });

  test("while its attacks load the card keeps its place, and once loaded with none it goes", () => {
    const view = table();
    const participants = turnParticipants(view);
    const base = { view, you: dmYou, participants, uses: participants.map(() => []), dismissed: new Set<string>(), failed: false };
    assert.ok(combatAlerts({ ...base, attacks: [null], loading: true }).turn, "loading: it stays");
    assert.equal(combatAlerts({ ...base, attacks: [null], loading: false }).turn, null);
  });

  test("dismissed, it stays away for the turn as before", () => {
    const view = table();
    const participants = turnParticipants(view);
    const first = combatAlerts({ view, you: dmYou, participants, uses: [[]], attacks: [1], loading: false, failed: false, dismissed: new Set() }).turn!;
    assert.equal(combatAlerts({ view, you: dmYou, participants, uses: [[]], attacks: [1], loading: false, failed: false, dismissed: new Set([first.id]) }).turn, null);
  });
});

describe("AttackRows", () => {
  const bite = blockActions(monsterView(statBlockOf(customMonster("lurker")))).find((r) => r.name === "Bite")!;
  const rows = { attack: `t:m1|${bite.key}|attack`, damage: `t:m1|${bite.key}|damage` };
  const line = (id: string, tag: string, rolls: object[]): LogEntry => ({ id, at: "2026-11-06T20:00:00.000Z", kind: "event", data: { type: "dice", tag, by: "dm1", to: "dm", rolls } as never });

  /** The card's rows with an attack and a damage roll landed at room seq `since`. */
  function render(since: number | null): string {
    const view = table();
    const scope = new RoomScope();
    const log: LogEntry[] = [];
    if (since !== null) {
      log.push(line("12:0", "tag-a", [{ formula: "1d20+4", faces: [13], total: 17, label: "Bite", tokenId: "m1" }]));
      log.push(line("13:0", "tag-d", [{ formula: "1d10+2", faces: [5], total: 7, label: "Bite damage, Piercing", type: "piercing", tokenId: "m1" }]));
      const tracker = scope.get(receiptsSlot);
      tracker.env = { lookup: async () => ({ parts: [] }), log: () => log };
      for (const tag of ["tag-a", "tag-d"]) {
        tracker.sending(tag, 0);
        tracker.answer(tag, 0, "taken");
      }
      // A server render reads a store's first state, so the remembered tags are made the first.
      const options = scope.get(optionSlot);
      options.setState({ tags: { [rows.attack]: "tag-a", [rows.damage]: "tag-d" }, since: { [rows.attack]: since, [rows.damage]: since } });
      options.getInitialState = options.getState;
    }
    const store = createStore(() => ({ view: { ...view, log }, roomId: "r1", connection: "open", you: DM, sceneId: "s1", pending: [], local: { selectedIds: [], multi: false, panel: null, panelList: false, sheetHidden: false } }));
    return renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope, children: createElement(AttackRows, { creature: { tokenId: "m1" }, tokenId: "m1", name: "Cave Lurker", after: 10 }) }),
      }),
    );
  }

  test("the lurker's Bite as the Dice panel's row: its name and numbers, Attack and Damage", () => {
    const html = render(null);
    assert.match(html, /aria-label="Cave Lurker&#x27;s attacks"/);
    assert.match(html, />Bite</);
    assert.match(html, /\+4 to hit/);
    assert.match(html, /aria-label="Bite"[^>]*><span[^>]*>Attack</, "Attack, named as in the panel");
    assert.match(html, /aria-label="Bite damage"/);
    assert.doesNotMatch(html, /data-card-result/, "nothing rolled this turn");
  });

  test("this turn's hit shows under the row, 17 to hit and 7 Piercing damage, with Apply to naming Thorn", () => {
    const html = render(12);
    const result = /<div data-card-result=""[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? "";
    assert.match(result, />17<\/span><span[^>]*>to hit, Secret</, "a monster's roll starts secret, as in the panel");
    assert.match(result, />7<\/span><span[^>]*>Piercing damage, Secret</);
    assert.match(html, /role="group" aria-label="Apply to"/);
    assert.match(html, /aria-label="Apply 7 Piercing damage to Thorn"/);
  });

  test("a roll from before the turn began never shows, so its chips never come back", () => {
    const html = render(9);
    assert.doesNotMatch(html, /data-card-result/);
    assert.doesNotMatch(html, /Apply to/);
  });
});
