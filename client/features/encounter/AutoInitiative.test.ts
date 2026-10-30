import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { actor, apply, DM, room, token } from "#shared/testutil.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { diceChoicesSlot } from "../dice/useDicePanel.ts";
import type { RollModeOverride } from "../dice/rollMode.ts";
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { useAuto } = await import("./autoState.ts");
const { AutoInitiativeControls, AutoInitiativeResult, RowRollTools, useAutoInitiativeFor } = await import("./AutoInitiative.tsx");

for (const route of ["auto", "row", "selection"] as const) test(`one-roll ${route} initiative keeps fixed secrecy and panel choices`, () => {
  for (const override of ["adv", "dis", "normal"] as const) {
    let view = room({ tokens: { g: token("g", { actor: { inline: actor({ initBonus: 3 }) } }) } });
    view = apply(view, { t: "encounter.start", entries: [{ id: "e", tokenId: "g" }] });
    const scope = new RoomScope();
    const choices = scope.get(diceChoicesSlot);
    const initial = { adv: false, dis: true, secret: false, secretFor: "g", version: 11, last: null };
    choices.setState(initial);
    choices.getInitialState = choices.getState;
    const sent: ClientOp[] = [];
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: ["g"], multi: false } }));
    let roll: ((override?: RollModeOverride) => void) | undefined;
    function collect(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (!value || typeof value !== "object" || !("props" in value) || !("type" in value)) return;
      const element = value as { type: { name?: string } | string; props: { onRoll?: typeof roll; children?: unknown } };
      if (typeof element.type !== "string" && element.type.name === "InitiativeButton") roll = element.props.onRoll;
      else collect(element.props.children);
    }
    function Probe() {
      if (route === "selection") roll = useAutoInitiativeFor(["g"]).press;
      else collect(route === "auto" ? AutoInitiativeControls() : RowRollTools({ entry: view.encounter!.entries[0]! }));
      return route === "auto" ? createElement(AutoInitiativeControls) : route === "row" ? createElement(RowRollTools, { entry: view.encounter!.entries[0]! }) : null;
    }
    const html = renderToStaticMarkup(createElement(RoomProvider, {
      store: store as never, actions: { dispatch: (op: ClientOp) => sent.push(op) } as never, ui: { notify() {} } as never, assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: createElement(Probe) }),
    }));
    if (route !== "selection") {
      assert.match(html, /aria-haspopup="menu"/);
      assert.match(html, /Hold, right-click or Shift\+F10 for Advantage, Disadvantage or Normal/);
    }
    assert.ok(roll);
    roll(override);
    assert.equal(sent.length, 1);
    const op = sent[0];
    assert.ok(op?.t === "dice.roll");
    assert.equal(op.to, "dm");
    assert.equal(op.rolls[0]!.mode, override === "normal" ? undefined : override);
    assert.equal(op.rolls[0]!.initiative, true);
    assert.deepEqual({ ...choices.getState(), last: null }, initial);
  }
});

test("auto result details describe returned Normal and Secret", () => {
  let view = room({ tokens: { g: token("g") } });
  view = apply(view, { t: "encounter.start", entries: [{ id: "e", tokenId: "g" }] });
  view.encounter!.entries[0]!.value = 12;
  const scope = new RoomScope();
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: ["g"], multi: false } }));
  function Probe() {
    const auto = useAuto();
    auto.store.setState({ last: { mode: "each", groups: [], joined: [], tag: null, rolled: [{ rows: [{ entryId: "e", tokenId: "g", name: "Goblin", modifier: 2, sources: [], extra: [], value: null }], modifier: 2, sources: [], extra: [], mixedAdvantage: false, mixedModifier: false, mixedExtra: false, total: 12, roll: { formula: "1d20+2", faces: [10], total: 12 } }], error: null, changed: [], done: true, sent: [] } });
    auto.store.getInitialState = auto.store.getState;
    return createElement(AutoInitiativeResult);
  }
  const html = renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope, children: createElement(Probe) }),
  }));
  assert.match(html.replace(/<[^>]*>/g, ""), /Normal, Secret/);
});

test("Auto Initiative offers no menu when every waiting monster joins a kept value", () => {
  let view = room({ tokens: { a: token("a"), b: token("b") } });
  view = apply(view, { t: "encounter.start", entries: [{ id: "a", tokenId: "a" }, { id: "b", tokenId: "b" }] });
  for (const entry of view.encounter!.entries) {
    entry.groupKey = "g";
    entry.value = entry.id === "a" ? 16 : null;
  }
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  const html = renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(AutoInitiativeControls) }),
  }));
  assert.match(html, /Auto Initiative \(1\)/);
  assert.doesNotMatch(html, /aria-haspopup="menu"/);
});
