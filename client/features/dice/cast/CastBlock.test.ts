import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { PcStats, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { P1, castTable, character } from "#shared/testutil.ts";
import { optionSlot } from "../optionState.ts";
import { castReceiptsSlot, castSendsSlot, type CastSend } from "./cast.ts";

/*
 * The sends that lead the Dice panel's options (docs/design-v1-player-save-spell.md
 * 3.2): a send the open block shows in place is left to it only while that
 * block draws, and every other send is named for its caster and spell.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../../state/scope.ts");
const { PlayerOptions } = await import("../RollOptions.tsx");
const { WaitingAsks } = await import("./CastBlock.tsx");

const THORN: PcStats = {
  abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
  saves: ["int", "wis"],
  skills: {},
  spellAbility: "int",
  adjust: {},
  defenses: {},
  rolls: [
    { id: "fb", name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] },
    { id: "hp", name: "Hold Person", kind: "spell", ability: "spell", level: 2, save: { ability: "wis" }, dice: [] },
  ],
};

const REFUSED = "That roll already went with another ask.";

function send(id: string, spell: string, over: Partial<CastSend> = {}): CastSend {
  return { id, key: "c:thorn-c", spell, ask: { caster: "thorn", sceneId: "s1", spell, targets: ["g1"] }, ...over };
}

/** Thorn's two sends, each refused, and the block open on the first, as `cast` says. */
function render(input: { picked: string | null; cast: { spell: string; roll?: string; area?: string; sent: string } | null; offScene?: boolean; only?: "list" }): string {
  const state = castTable();
  state.characters["thorn-c"] = character("thorn-c", { name: "Thorn", ownerIds: ["p1"], level: 5, stats: THORN });
  state.characters["bree-c"]!.ownerIds = ["p1"];
  if (input.offScene) {
    // The DM moved Thorn and Bree to the other scene: the player sees neither, and has no creature to pick.
    state.tokens.thorn!.sceneId = "s2";
    state.tokens.bree!.sceneId = "s2";
    state.characters["thorn-c"]!.ownerIds = [];
    state.characters["bree-c"]!.ownerIds = [];
    state.tokens.thorn!.ownerIds = ["p1"];
  }
  const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
  const scope = new RoomScope();
  const sends = scope.get(castSendsSlot);
  sends.setState({ sends: { f1: send("f1", "Fireball", { area: "a1", ask: { caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1" } }), h1: send("h1", "Hold Person", { roll: "hp" }) } });
  // A server render reads a zustand store's first state, so each store's state is made its first.
  sends.getInitialState = sends.getState;
  const tracker = scope.get(castReceiptsSlot);
  tracker.env = { lookup: async () => ({ parts: [] }), log: () => [] };
  for (const id of ["f1", "h1"]) {
    tracker.sending(id, 0);
    tracker.answer(id, 0, "refused", { code: "invalid", message: REFUSED, text: REFUSED });
  }
  const options = scope.get(optionSlot);
  if (input.cast) options.setState({ cast: { key: "c:thorn-c", creature: { characterId: "thorn-c" }, ...input.cast } });
  if (input.picked !== null) options.setState({ picked: input.picked });
  options.getInitialState = options.getState;
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: [], multi: false }, ephemeral: { drags: {} } }));
  const body = input.only === "list" ? createElement(WaitingAsks, { view, pickedKey: input.picked }) : createElement(PlayerOptions, { view, selected: [] });
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: { notify() {} } as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: body }),
    }),
  );
}

/** The leading list's markup: everything before the creature's own options. */
function list(markup: string): string {
  const at = markup.indexOf("Rolls for ");
  return at < 0 ? markup : markup.slice(0, at);
}

const count = (text: string, part: string) => text.split(part).length - 1;

describe("the sends leading the options", () => {
  test("refused Fireball and Hold Person sends show side by side, each named for its caster and spell, with Ask again", () => {
    const markup = render({ picked: null, cast: null, only: "list" });
    assert.match(markup, /Thorn&#x27;s Fireball: not asked\./);
    assert.match(markup, /Thorn&#x27;s Hold Person: not asked\./);
    assert.equal(count(markup, REFUSED), 2);
    assert.match(markup, /aria-label="Ask again for saves against Fireball"/);
    assert.match(markup, /aria-label="Ask again for saves against Hold Person"/);
  });

  test("the open block's send is left to it while the block draws for the picked creature", () => {
    const markup = render({ picked: "c:thorn-c", cast: { spell: "Fireball", area: "a1", sent: "f1" } });
    assert.doesNotMatch(list(markup), /Fireball: not asked/, "not in the list");
    assert.match(list(markup), /Hold Person: not asked/, "the other send is");
    assert.match(markup, /aria-label="Ask for saves: Fireball"/, "the block draws");
    assert.equal(count(markup, REFUSED), 2, "each refusal once: Fireball's in its block, Hold Person's in the list");
  });

  test("a chip switch away from the block's creature brings its send back to the list", () => {
    const markup = render({ picked: "c:bree-c", cast: { spell: "Fireball", area: "a1", sent: "f1" } });
    assert.doesNotMatch(markup, /aria-label="Ask for saves: Fireball"/, "the block does not draw for Bree");
    assert.match(list(markup), /Thorn&#x27;s Fireball: not asked\./);
    assert.match(list(markup), /Thorn&#x27;s Hold Person: not asked\./);
  });

  test("with no creature to pick, every send still shows, the block's included", () => {
    const markup = render({ picked: null, cast: { spell: "Fireball", area: "a1", sent: "f1" }, offScene: true });
    assert.match(markup, /Your character&#x27;s rolls show here once you play one\./);
    assert.match(markup, /Fireball: not asked\./);
    assert.match(markup, /Hold Person: not asked\./);
    assert.equal(count(markup, REFUSED), 2);
  });

  test("a block whose row is gone draws at the top of the options, so its send shows there", () => {
    const markup = render({ picked: "c:thorn-c", cast: { spell: "Old Hold", roll: "spells:gone", sent: "h1" } });
    assert.match(markup, /aria-label="Ask for saves: Old Hold"/, "the block draws though its row is gone");
    assert.doesNotMatch(list(markup), /Hold Person: not asked/, "its send is the block's");
    assert.match(list(markup), /Fireball: not asked/);
    assert.equal(count(markup, REFUSED), 2);
  });
});
