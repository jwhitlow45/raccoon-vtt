import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { PcStats, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { P1, castAsk, castTable, character } from "#shared/testutil.ts";
import { creatureRolls } from "../creature.ts";
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
const panelModule = await import("../useDicePanel.ts");
const { WaitingAsks, useCastEnv, RowCast } = await import("./CastBlock.tsx");

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
  selected?: string[];
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
    // The opening opened Spells once, its send marked seen, then Pat folded it.
    const folds = scope.get(diceFoldsSlot);
    folds.openForNew("pc.spells", [`open:${input.cast.opened ?? 0}`], [input.cast.sent]);
    folds.tap("pc.spells", false, false);
  }
  return { input, view, scope, tracker };
}

function draw(ready: ReturnType<typeof setup>): string {
  const { input, view, scope } = ready;
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: input.selected ?? [], multi: false }, ephemeral: { drags: {} } }));
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

test("cast damage menu keeps panel state, disables d20 damage modes and uses ordinary default visibility", () => {
  for (const override of ["secret", "normal"] as const) {
    const ready = setup({ picked: "c:thorn-c", cast: null });
    const choices = ready.scope.get(panelModule.diceChoicesSlot);
    const initial = { adv: true, dis: false, secret: true, version: 21, last: null };
    choices.setState(initial);
    choices.getInitialState = choices.getState;
    const sent: import("#shared/protocol.ts").ClientOp[] = [];
    const store = createStore(() => ({ view: ready.view, roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: [], multi: false } }));
    let env: ReturnType<typeof useCastEnv> | undefined;
    function Probe() { env = useCastEnv(); return null; }
    renderToStaticMarkup(createElement(RoomProvider, {
      store: store as never, actions: { dispatch: (op: import("#shared/protocol.ts").ClientOp) => sent.push(op) } as never, ui: { notify() {} } as never, assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: ready.scope, children: createElement(Probe) }),
    }));
    assert.ok(env);
    assert.ok(env.rollDamage([{ formula: "1d20", modeEligible: false }], override));
    const op = sent[0];
    assert.ok(op?.t === "dice.roll");
    assert.equal(op.to, override === "secret" ? "dm" : "all");
    assert.equal(op.rolls[0]!.mode, undefined);
    assert.deepEqual({ ...choices.getState(), last: null }, initial);
  }
  const fire = render({ picked: "c:thorn-c", selected: ["g1"], cast: { spell: "Fireball", roll: "fb", sent: "fresh", opened: 1 } });
  assert.match(fire, /Hold, right-click or Shift\+F10 for Secret or Normal/);
  const hold = render({ picked: "c:thorn-c", selected: ["g1"], cast: { spell: "Hold Person", roll: "hp", sent: "fresh", opened: 1 } });
  const ask = /<button[^>]*>Ask the DM<\/button>/.exec(hold)?.[0];
  assert.ok(ask);
  assert.doesNotMatch(ask, /aria-haspopup/);
});

test("cast menu picks reach the damage invocation once before the unchanged ask", () => {
  for (const override of ["secret", "normal"] as const) {
    const ready = setup({ picked: "c:thorn-c", cast: { spell: "Fireball", roll: "fb", sent: "fresh", opened: 1 }, selected: ["g1"] });
    const choices = ready.scope.get(panelModule.diceChoicesSlot);
    const initial = { adv: true, dis: false, secret: true, version: 23, last: null };
    choices.setState(initial);
    choices.getInitialState = choices.getState;
    const sent: import("#shared/protocol.ts").ClientOp[] = [];
    const store = createStore(() => ({ view: ready.view, roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: ["g1"], multi: false }, ephemeral: { drags: {} } }));
    let source: import("../useRollModeMenu.tsx").RollModeButtonProps | undefined;
    let pick: ((override: "secret" | "normal") => void) | undefined;
    function collect(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (!value || typeof value !== "object" || !("props" in value) || !("type" in value)) return;
      const element = value as { type: { name?: string } | string; props: { children?: unknown; onPick?: typeof pick } };
      if (typeof element.type === "function" && element.type.name === "CastBlockView") collect((element.type as (p: never) => unknown)(element.props as never));
      else if (typeof element.type !== "string" && element.type.name === "Button" && typeof element.props.children === "string" && element.props.children.startsWith("Roll ")) source = element.props as never;
      else if (typeof element.type !== "string" && element.type.name === "RollModeMenu") pick = element.props.onPick;
      else collect(element.props.children);
    }
    function Probe() {
      const dice = { view: ready.view, you: P1, srd: { monsters: null, rolls: null } };
      const named = creatureRolls(dice, { characterId: "thorn-c" })!.named.find((roll) => roll.key === "fb")!;
      collect(RowCast({ dice, creatureKey: "c:thorn-c", creature: { characterId: "thorn-c" }, name: "Thorn", blocked: null, named, rowSlot: 3, blockHere: true }));
      return null;
    }
    renderToStaticMarkup(createElement(RoomProvider, {
      store: store as never, actions: { dispatch: (op: import("#shared/protocol.ts").ClientOp) => sent.push(op) } as never, ui: { notify() {} } as never, assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: ready.scope, children: createElement(Probe) }),
    }));
    assert.ok(source && pick);
    const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node };
    class FakeNode {}
    Object.assign(globalThis, { window: new EventTarget(), document: { activeElement: null, body: null }, Node: FakeNode });
    try {
      source.ref({ style: { boxShadow: "" }, closest: () => null, parentElement: null, isConnected: true, getClientRects: () => [1], focus() {}, dispatchEvent: () => true } as unknown as HTMLButtonElement);
      const open = () => source!.onKeyDown?.({ key: "F10", shiftKey: true, preventDefault() {} } as never);
      for (const stale of ["selection", "scene", "view"] as const) {
        const before = store.getState();
        open();
        store.setState(stale === "selection" ? { local: { ...before.local, selectedIds: ["bree"] } } : stale === "scene" ? { sceneId: "s2" } : { view: structuredClone(before.view) });
        pick(override);
        assert.equal(sent.length, 0, `a stale ${stale} cannot send`);
        store.setState(before);
      }
      open();
      pick(override);
      pick(override);
      assert.equal(sent.length, 2, "one damage roll precedes one ask");
      const damage = sent[0];
      assert.ok(damage?.t === "dice.roll");
      assert.equal(damage.to, override === "secret" ? "dm" : "all");
      assert.equal(sent[1]?.t, "cast.ask");
      assert.deepEqual({ ...choices.getState(), last: null }, initial);
    } finally { Object.assign(globalThis, previous); }
  }
});
