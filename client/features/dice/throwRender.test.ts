import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { P1, room } from "#shared/testutil.ts";
import { FakeClock } from "../../state/testing.ts";
import { diceChoicesSlot } from "./useDicePanel.ts";
import { receiptsSlot } from "./useReceipt.ts";
import type { Stage, StageModule } from "./throw/store.ts";

/*
 * The header line during a throw (docs/design/design-v1-roll-animation.md 3.4 and
 * 10), rendered as the server renders it: the first render after the
 * commit shows no total, the live region already says the result with its
 * verdict, Again is live, and the tray takes no tap and no screen reader.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { LastResult } = await import("./Roller.tsx");
const { Tray } = await import("./throw/Tray.tsx");
const { throwsSlot } = await import("./throw/useThrows.ts");

const TAG = "tag-attack";

/** A Champion's Longsword landing a 19, a critical hit in its wider range: 19 + 4 is 23. */
const LINE: LogEntry = {
  id: "1:0",
  at: "2026-10-18T20:00:00.000Z",
  kind: "event",
  data: { type: "dice", tag: TAG, by: "p1", to: "all", rolls: [{ formula: "1d20+4", faces: [19], total: 23, label: "Longsword", critOn: 19, characterId: "thorn" }] },
};

function render(throwing: boolean, trays?: "block"): string {
  const view = room({}) as unknown as RoomState;
  const scope = new RoomScope();
  const log: LogEntry[] = [LINE];
  const tracker = scope.get(receiptsSlot);
  tracker.env = { lookup: async () => ({ parts: [] }), log: () => log };
  const choices = scope.get(diceChoicesSlot);
  choices.setState({ last: { tag: TAG, rolls: [{ formula: "1d20+4", label: "Longsword" }], to: "all" } });
  choices.getInitialState = choices.getState;
  const { store } = scope.get(throwsSlot);
  const stage: Stage = { warm: () => ({ then: (ok: () => void) => ok() }) as unknown as Promise<void>, play() {}, stop() {}, dispose() {} };
  const module: StageModule = { createStage: () => stage };
  store.bind({ clock: new FakeClock(), idle: (cb) => (cb(), () => undefined), tracker, loader: { loaded: () => module, state: () => "ready", subscribe: () => () => undefined }, hidden: () => false });
  store.setInputs({ on: throwing });
  const host = store.mount({ kinds: () => ["d20"] });
  const block = store.mount({ surface: "block", kinds: () => ["d20", "d4"] });
  const thrower = trays === "block" ? block : host;
  thrower.attach({ parent: null, measure: () => ({ width: 356, height: 200, zoom: 1, from: null }) });
  tracker.sending(TAG, 0);
  store.register(TAG, thrower.origin());
  tracker.answer(TAG, 0, "taken");
  assert.equal(store.held(TAG), throwing);
  const roomStore = createStore(() => ({ view: { ...view, log }, roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: roomStore as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, {
        scope,
        children: trays === "block" ? [createElement("section", { key: "dice", "data-in": "dice" }, createElement(Tray, { host })), createElement("section", { key: "block", "data-in": "block" }, createElement(Tray, { host: block }))] : createElement(LastResult, { onOpen() {} }),
      }),
    }),
  );
}

/** The header line's own words, without the live region's. */
function shown(markup: string): string {
  return markup.replace(/<span role="status"[^>]*>.*?<\/span>/, "");
}

describe("the header line during a throw", () => {
  test("the first render after the commit shows no total, and the live region already says it with its verdict", () => {
    const markup = render(true);
    assert.doesNotMatch(shown(markup), />23</, "no total while the dice fly");
    assert.match(markup, /<span role="status" aria-live="polite"[^>]*>Rolled 23, Critical Hit: Longsword, Normal\.<\/span>/);
  });

  test("Again is live during the throw, and the tray takes no tap and is hidden from a screen reader", () => {
    const markup = render(true);
    const again = /<button[^>]*>(?:(?!<\/button>).)*Again<\/button>/.exec(markup)?.[0] ?? "";
    assert.ok(again, "Again is there");
    assert.doesNotMatch(again, /aria-busy|disabled/);
    assert.match(markup, /<div aria-hidden="true" data-dice-tray=""[^>]*pointer-events:none/);
  });

  test("only the tray of the host that rolled draws the scrim, and the scrim covers the pane's side padding", () => {
    const markup = render(true, "block");
    const dice = /<section data-in="dice">(.*?)<\/section>/.exec(markup)?.[1] ?? "";
    const block = /<section data-in="block">(.*?)<\/section>/.exec(markup)?.[1] ?? "";
    assert.match(dice, /data-dice-tray/);
    assert.doesNotMatch(dice, /opacity:0\.92/, "the Dice panel's tray stays empty for a block roll");
    assert.match(block, /opacity:0\.92/, "the scrim");
    // The fill is a token, a CSS variable with a comma of its own.
    assert.match(block, /box-shadow:calc\(-1 \* var\(--pane-pad-x, 0px\)\) 0 0 .+?, var\(--pane-pad-x, 0px\) 0 0 /, "paneSides");
  });

  test("with the dice off, the same commit shows its total at once", () => {
    assert.match(shown(render(false)), />23</);
  });
});
