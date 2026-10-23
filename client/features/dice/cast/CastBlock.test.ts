import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { PcStats, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { P1, castAsk, castTable, character } from "#shared/testutil.ts";
import { diceFoldsSlot } from "../diceFolds.ts";
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

type Input = {
  picked: string | null;
  cast: { spell: string; roll?: string; area?: string; sent: string; opened?: number } | null;
  offScene?: boolean;
  only?: "list";
  shaped?: true;
  /** Thorn's Spells folded after the block's opening and send opened it once. */
  folded?: true;
  /** Where Hold Person's send stands: refused as Fireball's by default, its answer unknown, waiting in the view, or settled and gone. */
  hold?: "unknown" | "asked" | "closed";
};

/** Thorn's two sends, each refused unless `hold` says otherwise, and the block open on one, as `cast` says. */
function render(input: Input): string {
  return draw(setup(input));
}

/** As render, once an unknown answer's lookup has settled it. */
async function settled(input: Input): Promise<string> {
  const ready = setup(input);
  await ready.tracker.lookup("h1");
  return draw(ready);
}

function setup(input: Input) {
  const state = castTable();
  state.characters["thorn-c"] = character("thorn-c", { name: "Thorn", ownerIds: ["p1"], level: 5, stats: THORN });
  // In a beast's shape Thorn's options wait for the SRD's chunks, which a server render never loads.
  if (input.shaped) state.characters["thorn-c"]!.actor.srdId = "wolf";
  state.characters["bree-c"]!.ownerIds = ["p1"];
  if (input.offScene) {
    // The DM moved Thorn and Bree to the other scene: the player sees neither, and has no creature to pick.
    state.tokens.thorn!.sceneId = "s2";
    state.tokens.bree!.sceneId = "s2";
    state.characters["thorn-c"]!.ownerIds = [];
    state.characters["bree-c"]!.ownerIds = [];
    state.tokens.thorn!.ownerIds = ["p1"];
  }
  if (input.hold === "asked") state.casts = { h1: castAsk("h1", { caster: "thorn", spell: "Hold Person", roll: "hp", area: undefined, slot: 2, targets: ["g1"] }) };
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
    if (id === "h1" && input.hold === "unknown") tracker.answer(id, 0, "unknown");
    else if (id === "h1" && input.hold === "closed") tracker.answer(id, 0, "taken");
    else if (!(id === "h1" && input.hold === "asked")) tracker.answer(id, 0, "refused", { code: "invalid", message: REFUSED, text: REFUSED });
  }
  const options = scope.get(optionSlot);
  if (input.cast) options.setState({ cast: { key: "c:thorn-c", creature: { characterId: "thorn-c" }, ...input.cast } });
  if (input.picked !== null) options.setState({ picked: input.picked });
  options.getInitialState = options.getState;
  if (input.folded && input.cast) {
    // The opening and its send opened Spells once, then Pat folded it.
    const folds = scope.get(diceFoldsSlot);
    folds.openForNew("pc.spells", [`open:${input.cast.opened ?? 0}`, input.cast.sent]);
    folds.tap("pc.spells", false, false);
  }
  return { input, view, scope, tracker };
}

function draw(ready: ReturnType<typeof setup>): string {
  const { input, view, scope } = ready;
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: [], multi: false }, ephemeral: { drags: {} } }));
  const body = input.only === "list" ? createElement(WaitingAsks, { view, pickedKey: input.picked, blockDraws: false }) : createElement(PlayerOptions, { view, selected: [] });
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

  test("while the block's creature's options load, the block does not draw, so its send shows in the list", () => {
    const markup = render({ picked: "c:thorn-c", cast: { spell: "Fireball", area: "a1", sent: "f1" }, shaped: true });
    assert.match(markup, /aria-label="Rolls for Thorn"/, "the card's frame and header draw at once");
    assert.doesNotMatch(markup, /aria-label="Spells"/, "the options still load");
    assert.doesNotMatch(markup, /aria-label="Ask for saves: Fireball"/, "no block yet");
    assert.match(markup, /Fireball: not asked\./);
    assert.match(markup, /Hold Person: not asked\./);
    assert.equal(count(markup, REFUSED), 2);
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

describe("a block whose group is folded (docs/design-v1-dice-pass.md 6.6)", () => {
  const HOLD = { spell: "Hold Person", roll: "hp", sent: "h1", opened: 1 };
  /** The Spells fold row, with its folded line. */
  function spellsFold(markup: string): string {
    const row = /<button[^>]*data-group-fold[^>]*>(?:(?!<\/button>).)*?Spells(?:(?!<\/button>).)*<\/button>/.exec(markup)?.[0];
    assert.ok(row, "the Spells fold row");
    return row;
  }

  test("a refused send shows above the card, and the folded line stops naming the block", () => {
    const markup = render({ picked: "c:thorn-c", cast: HOLD, folded: true });
    assert.match(spellsFold(markup), /aria-expanded="false"/);
    assert.doesNotMatch(markup, /aria-label="Ask for saves: Hold Person"/, "the folded group hides the block");
    assert.match(list(markup), /Hold Person: not asked\./, "so its refusal shows above the card");
    assert.equal(count(markup, REFUSED), 2, "Hold Person's and Fireball's, each once");
    assert.doesNotMatch(markup, /Ask for saves waiting/);
  });

  test("an unknown answer shows above the card, and the folded line stops naming the block", async () => {
    const markup = await settled({ picked: "c:thorn-c", cast: HOLD, folded: true, hold: "unknown" });
    assert.match(list(markup), /Hold Person: the ask may have gone\./);
    assert.match(markup, /This may have happened\. Check the log\./);
    assert.doesNotMatch(markup, /Ask for saves waiting/);
  });

  test("an ask the server took waits above the card, and the folded line names it once, from the view", () => {
    const markup = render({ picked: "c:thorn-c", cast: HOLD, folded: true, hold: "asked" });
    assert.match(list(markup), /Asked the DM for saves\. Waiting\./);
    assert.match(markup, /aria-label="Withdraw the ask for saves against Hold Person"/);
    assert.equal(count(spellsFold(markup), "Ask for saves waiting: Hold Person"), 1);
  });

  test("an ask the DM settled shows nowhere, and the folded line stops naming the block", () => {
    const markup = render({ picked: "c:thorn-c", cast: HOLD, folded: true, hold: "closed" });
    assert.doesNotMatch(markup, /Hold Person: not asked|Hold Person: the ask may have gone|Asked the DM for saves/);
    assert.doesNotMatch(markup, /Ask for saves waiting/);
  });

  test("opened, the block shows its own refusal in place, and the folded line would name it while it waits", () => {
    const open = render({ picked: "c:thorn-c", cast: HOLD });
    assert.match(open, /aria-label="Ask for saves: Hold Person"/);
    assert.doesNotMatch(list(open), /Hold Person: not asked/);
    const waiting = render({ picked: "c:thorn-c", cast: { spell: "Hold Person", roll: "hp", sent: "h9", opened: 1 }, folded: true });
    assert.match(spellsFold(waiting), /Ask for saves waiting: Hold Person/, "a send with no answer yet still waits");
  });
});

describe("Ask for saves in its row (docs/design-v1-dice-pass.md 7.3)", () => {
  test("wears the option buttons' outline, as it acts beside Attack and Damage", async () => {
    const { theme } = await import("../../../lib/theme.ts");
    const markup = render({ picked: "c:thorn-c", cast: null });
    const button = /<button[^>]*aria-label="Ask the DM for saves against Hold Person"[^>]*>/.exec(markup)?.[0];
    assert.ok(button, "the row's Ask for saves");
    assert.match(button, new RegExp(`border:${theme.line.border}px solid ${theme.color.controlBorder}`));
  });
});
