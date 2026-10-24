import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientOp, EntryInput } from "#shared/protocol.ts";
import { loadedMonsters, loadMonsters } from "#shared/srd/monsters.ts";
import { DM, actor, entry, room, token } from "#shared/testutil.ts";
import { lairCounts } from "#shared/dice/uses.ts";
import { fightOps } from "../tokens/groupEdit.ts";
import type { DiceView } from "../dice/creature.ts";
import { joinState, lairState } from "./state.ts";

/*
 * A creature placed in its lair joins a fight with In lair on, by one rule
 * on every path into it (docs/design-v1-combat-controls.md 13.4), and In
 * lair never goes without the counts its block gives (3.1): a block still
 * loading holds the join and the switch busy, and one that did not load
 * stops them with its reload, so neither marks a creature off unread.
 * The SRD's blocks load part way through this file, as on a page: the
 * cases before the load read them unread.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { EntryRow } = await import("../encounter/Row.tsx");
const { useFightJoin } = await import("./state.ts");

const LAIR = { actionsMax: 4, actionsUsed: 0, resistMax: 4, resistUsed: 0 };
const BASE = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };

function table(): RoomState {
  const state = room();
  state.tokens.lair = token("lair", { name: "Lair Dragon", size: "huge", x: 2, y: 2, actor: { inline: actor({ srdId: "adult-red-dragon", legendary: LAIR }) } });
  state.tokens.away = token("away", { name: "Away Dragon", size: "huge", x: 8, y: 2, actor: { inline: actor({ srdId: "adult-red-dragon", legendary: BASE }) } });
  state.tokens.gob = token("gob", { name: "Goblin", x: 14, y: 2, actor: { inline: actor({ srdId: "goblin-warrior" }) } });
  state.tokens.ogre = token("ogre", { name: "Ogre", x: 18, y: 2, actor: { inline: actor({ legendary: BASE }) } });
  return state;
}

function provide(state: RoomState, child: ReturnType<typeof createElement>): string {
  const view = projectState(state, DM, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: DM.memberId, role: DM.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: child }),
    }),
  );
}

/** What useFightJoin says of these tokens and the rows it marks, as text a server render shows. */
function joined(state: RoomState, ids: readonly string[]): { state: string; rows: EntryInput[] } {
  function Probe() {
    const tokens = ids.map((id) => state.tokens[id] as Token);
    const join = useFightJoin(tokens);
    return createElement("pre", null, JSON.stringify({ state: join.stateOf(tokens), rows: ids.map((id) => join.mark({ id: `e-${id}`, tokenId: id })) }));
  }
  const markup = provide(state, createElement(Probe));
  return JSON.parse(/<pre>(.*)<\/pre>/.exec(markup)![1]!.replaceAll("&quot;", '"')) as { state: string; rows: EntryInput[] };
}

/** The DM's options for a dragon's row, open, and its In lair switch. */
function lairSwitch(state: RoomState, tokenId: string): string {
  const s = { ...state, encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e1", { tokenId, value: 15 })] } };
  const view = projectState(s, DM, { sceneId: "s1" });
  const row = createElement(EntryRow, {
    entry: view.encounter!.entries[0]!,
    active: false,
    role: "dm",
    mine: false,
    expanded: true,
    picking: false,
    selected: false,
    onExpand() {},
    onShow() {},
    onShowToken() {},
    drag: null,
    rowRef: () => {},
  });
  const markup = provide(s, createElement("ol", null, row));
  const at = markup.indexOf("In lair");
  assert.ok(at >= 0, "the switch is there");
  return markup.slice(markup.lastIndexOf("<button", at), markup.indexOf("</button>", at));
}

const dmYou = { role: "dm" as const, memberId: "dm1" };
const diceOf = (state: RoomState, monsters: DiceView["srd"]["monsters"]): DiceView => ({ you: dmYou, view: state, srd: { monsters, rolls: null } });

describe("whether a join or In lair can read its creature's lair (CCB-ASTRA-04, CCB-OPUS-3)", () => {
  test("a join waits for a legendary creature's SRD block, stops where it failed, and never waits for a creature with no legendary counts or a block at hand", () => {
    const state = table();
    const t = (id: string) => state.tokens[id] as Token;
    assert.equal(joinState(diceOf(state, null), false, [t("lair"), t("gob")]), "loading");
    assert.equal(joinState(diceOf(state, null), true, [t("lair")]), "failed");
    assert.equal(joinState(null, false, [t("lair")]), "loading", "before the room's first snapshot");
    assert.equal(joinState(diceOf(state, null), true, [t("gob")]), "ready", "a goblin has no lair to read");
    assert.equal(joinState(diceOf(state, null), true, [t("ogre")]), "ready", "counts with no SRD block: nothing to load");
    assert.equal(joinState(diceOf(state, []), false, [t("lair")]), "ready");
  });

  test("In lair waits only for a block not read yet, and keeps its manual path for a creature with no block", () => {
    const state = table();
    assert.equal(lairState(diceOf(state, null), false, { tokenId: "lair" }), "loading");
    assert.equal(lairState(diceOf(state, null), true, { tokenId: "lair" }), "failed");
    assert.equal(lairState(diceOf(state, null), true, { tokenId: "ogre" }), "ready", "no block: In lair alone, with no counts");
    assert.equal(lairState(diceOf(state, []), false, { tokenId: "lair" }), "ready");
    assert.equal(lairState(null, false, { tokenId: "lair" }), "loading");
    assert.equal(lairState(diceOf(state, null), true, null), "ready");
  });

  test("before the blocks load: the join says loading and marks no row, and the row's In lair waits busy", () => {
    assert.equal(loadedMonsters(), null, "this case runs before the SRD loads");
    const state = table();
    const read = joined(state, ["lair", "away", "gob"]);
    assert.equal(read.state, "loading");
    assert.ok(read.rows.every((r) => r.inLair === undefined), "no row marked while its block loads");
    assert.match(lairSwitch(state, "lair"), /aria-busy="true"/);
    assert.doesNotMatch(lairSwitch(state, "ogre"), /aria-busy/, "a creature with no block sets In lair at once");
  });

  test("once read: the dragon placed in its lair joins with In lair on, the one at its base counts and the goblin without", async () => {
    const monsters = await loadMonsters();
    const dragon = monsters.find((m) => m.srdId === "adult-red-dragon")!;
    assert.deepEqual(lairCounts(dragon, true), { actionsMax: LAIR.actionsMax, resistMax: LAIR.resistMax, xp: dragon.xpInLair });
    const state = table();
    const read = joined(state, ["lair", "away", "gob", "ogre"]);
    assert.equal(read.state, "ready");
    assert.deepEqual(
      read.rows.map((r) => [r.tokenId, r.inLair ?? false]),
      [
        ["lair", true],
        ["away", false],
        ["gob", false],
        ["ogre", false],
      ],
    );
    const sw = lairSwitch(state, "lair");
    assert.doesNotMatch(sw, /aria-busy|disabled/);
  });

  test("the group bar's Start a fight and Add to the fight carry the mark on every row they send", async () => {
    await loadMonsters();
    const state = table();
    const marks = new Map<string, boolean>([["lair", true]]);
    const mark = (e: EntryInput): EntryInput => (marks.get(e.tokenId ?? "") ? { ...e, inLair: true } : e);
    let n = 0;
    const id = () => `n${++n}`;
    const tokens = ["lair", "away", "gob"].map((t) => state.tokens[t] as Token);
    const rows = (ops: ClientOp[]) => ops.flatMap((op) => (op.t === "encounter.start" || op.t === "encounter.add" ? op.entries.map((e) => [op.t, e.tokenId, e.inLair ?? false]) : []));
    assert.deepEqual(rows(fightOps(tokens, null, id, mark)), [
      ["encounter.start", "lair", true],
      ["encounter.start", "away", false],
      ["encounter.start", "gob", false],
    ]);
    const fight = { entries: [entry("e-away", { tokenId: "away" })] };
    assert.deepEqual(rows(fightOps(tokens, fight, id, mark)), [
      ["encounter.add", "lair", true],
      ["encounter.add", "gob", false],
    ]);
  });
});
