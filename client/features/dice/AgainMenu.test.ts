import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry } from "#shared/model.ts";
import { P1, room } from "#shared/testutil.ts";
import { popoverSlot } from "../../components/popoverRules.ts";
import { createDicePanel, diceChoicesSlot } from "./useDicePanel.ts";
import { receiptsSlot } from "./useReceipt.ts";
import type { RollModeButtonProps } from "./useRollModeMenu.tsx";

// Server rendering supplies the real providers. Replay only changed hook layout effects to test its source-driven dismissal.
const captureKey = Symbol.for("again-menu-lifecycle");
let effects: { run(): void; deps: readonly unknown[] }[] = [];
let button: RollModeButtonProps | undefined;
(globalThis as Record<symbol, unknown>)[captureKey] = {
  layout(run: () => void, deps: readonly unknown[]) { effects.push({ run, deps }); },
  button(value: RollModeButtonProps) { button = value; },
};
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/dice/useRollModeMenu.tsx")) return result;
  const source = String(result.source);
  const replaced = source.replaceAll("useLayoutEffect(() =>", 'globalThis[Symbol.for("again-menu-lifecycle")].layout(() =>')
    .replace("return {\n\t\tbuttonProps,", 'globalThis[Symbol.for("again-menu-lifecycle")].button(buttonProps);\nreturn {\n\t\tbuttonProps,');
  assert.notEqual(source, replaced);
  assert.ok(replaced.includes(".button(buttonProps)"), "capture the real source button's handlers");
  return { ...result, source: replaced };
} });

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { PreviewContext } = await import("../dm/previewContext.ts");
const { LastResult } = await import("./Roller.tsx");
const { RecentRolls } = await import("./RecentRolls.tsx");

for (const surface of ["sticky", "recent"]) for (const blockedBy of ["disconnect", "preview"]) test(`${surface} Again closes its open menu on ${blockedBy} and retains tap feedback`, () => {
  const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node };
  class FakeNode {}
  Object.assign(globalThis, { window: new EventTarget(), document: Object.assign(new EventTarget(), { activeElement: null, body: null, visibilityState: "visible" }), Node: FakeNode });
  const scope = new RoomScope();
  try {
    const rolls = [{ formula: "1d20+5", faces: [10], total: 15 }];
    const log: LogEntry[] = [{ id: "1:0", at: "now", kind: "event", data: { type: "dice", tag: "previous", by: P1.memberId, to: "all", rolls } }];
    const view = room({ log });
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: [], multi: false } }));
    const choices = scope.get(diceChoicesSlot);
    choices.setState({ last: { tag: "previous", rolls: [{ formula: "1d20+5" }], to: "all" } });
    choices.getInitialState = choices.getState;
    const tracker = scope.get(receiptsSlot);
    tracker.env = { lookup: async () => ({ parts: [] }), log: () => log };
    tracker.answer("previous", 0, "taken");
    let taps = 0, preview = false;
    const panel = createDicePanel({ store: choices, sender: { connected: () => store.getState().connection === "open", receipts: tracker, dispatch: () => null }, secretStart: () => false });
    let prior: readonly unknown[][] = [];
    const render = () => {
      effects = []; button = undefined;
      store.getInitialState = store.getState;
      const body = surface === "sticky" ? createElement(LastResult, { onOpen() {} }) : createElement(RecentRolls, {
        names: { members: view.members, tokens: view.tokens, characters: view.characters, handouts: view.handouts, encounter: view.encounter }, me: P1.memberId, open: null,
        again: (inputs, to, origin) => { taps++; panel.again(inputs, to, origin); },
      });
      renderToStaticMarkup(createElement(RoomProvider, {
        store: store as never, actions: { dispatch: () => null } as never, ui: {} as never, assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope, children: createElement(PreviewContext.Provider, { value: preview ? {} as never : null, children: body }) }),
      }));
      const sourceButton = button as RollModeButtonProps | undefined;
      assert.ok(sourceButton?.onKeyDown);
      for (let index = 0; index < effects.length; index++) {
        const effect = effects[index]!;
        if (!prior[index] || effect.deps.some((dep, at) => !Object.is(dep, prior[index]![at]))) effect.run();
      }
      prior = effects.map((effect) => [...effect.deps]);
      return sourceButton;
    };
    render().onKeyDown!({ key: "ContextMenu", preventDefault() {} } as never);
    const popover = scope.get(popoverSlot);
    assert.ok(popover.current(), "the real shared hook opens a menu");
    render();
    assert.ok(popover.current(), "a stable source leaves the menu open");
    if (blockedBy === "disconnect") store.setState({ connection: "closed" });
    else preview = true;
    const blocked = render();
    assert.equal(popover.current(), null, "becoming blocked closes the existing menu without a pick");
    blocked.onKeyDown!({ key: "ContextMenu", preventDefault() {} } as never);
    assert.equal(popover.current(), null, "the blocked control cannot reopen its menu");
    blocked.onClick!({ detail: 1 } as never);
    assert.ok(choices.getState().last && "error" in choices.getState().last!);
    assert.equal((choices.getState().last as { error: string }).error, "Rolling needs a connection.");
    if (surface === "recent") assert.equal(taps, 1);
  } finally { scope.dispose(); Object.assign(globalThis, previous); }
});
