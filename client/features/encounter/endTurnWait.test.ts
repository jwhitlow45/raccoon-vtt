import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ClientOp } from "#shared/protocol.ts";
import { RoomScope } from "../../state/scope.ts";

/*
 * End turn's one wait for the Room (docs/design/design-v1-qol.md 6, QD-OPUS-25): the
 * strip's End turn and a phone's own token bar's share it, so a press on
 * either shows both busy and the other sends no second Next. Drawn to
 * markup, which runs the hooks but no effects, with the press called on
 * what the render gave.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const { endTurnWaitSlot, useEndTurn } = await import("./InitiativeStrip.tsx");

type Pending = { n: number; op: ClientOp };

/** Sets a store's state for a render to markup, which reads a zustand store's first state rather than its state now. */
function seed<T>(store: { setState(s: T): void; getState(): T; getInitialState(): T }, state: T): void {
  store.setState(state);
  store.getInitialState = store.getState;
}

function table() {
  const sent: ClientOp[] = [];
  const store = createStore(() => ({
    view: { encounter: { activeEntryId: "e1", round: 2, entries: [] } },
    you: { memberId: "p1", role: "player" },
    roomId: "r1",
    pending: [] as Pending[],
    local: { selectedIds: [], multi: false },
  }));
  const actions = {
    dispatch: (op: ClientOp) => {
      sent.push(op);
      return 4 + sent.length;
    },
    newId: () => "x",
    sendEph: () => {},
  };
  return { sent, store, actions };
}

/** Two buttons' hooks in one Room, as the strip and the bar hold them. */
function draw(t: ReturnType<typeof table>, scope: RoomScope) {
  const drawn: { end(): void; waiting: boolean }[] = [];
  const Probe = () => {
    drawn.push(useEndTurn());
    return null;
  };
  renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope,
      children: createElement(RoomProvider, {
        store: t.store as never,
        actions: t.actions as never,
        ui: { notify: () => {} } as never,
        assets: { url: () => "" } as never,
        children: [createElement(Probe, { key: "strip" }), createElement(Probe, { key: "bar" })],
      }),
    }),
  );
  return drawn;
}

test("a press on either button is the Room's one wait: the other sends nothing more and both show busy", () => {
  const t = table();
  const scope = new RoomScope();
  const [strip, bar] = draw(t, scope);
  assert.deepEqual([strip!.waiting, bar!.waiting], [false, false]);

  bar!.end();
  assert.deepEqual(t.sent, [{ t: "encounter.next", from: { entry: "e1", round: 2 } }]);
  assert.equal(scope.get(endTurnWaitSlot).getState().n, 5);
  seed(t.store, { ...t.store.getState(), pending: [{ n: 5, op: t.sent[0]! }] });
  strip!.end();
  assert.equal(t.sent.length, 1, "the strip's press while the bar's is out sends no second Next");

  seed(scope.get(endTurnWaitSlot), scope.get(endTurnWaitSlot).getState());
  const again = draw(t, scope);
  assert.deepEqual(again.map((d) => d.waiting), [true, true]);

  // Answered, the wait is over for both, and the next press goes.
  seed(t.store, { ...t.store.getState(), pending: [] });
  assert.deepEqual(draw(t, scope).map((d) => d.waiting), [false, false]);
  again[0]!.end();
  assert.equal(t.sent.length, 2);
});

test("another Room, such as a preview over the DM's, keeps a wait of its own", () => {
  const t = table();
  const scope = new RoomScope();
  draw(t, scope)[0]!.end();
  seed(t.store, { ...t.store.getState(), pending: [{ n: 5, op: t.sent[0]! }] });
  seed(scope.get(endTurnWaitSlot), scope.get(endTurnWaitSlot).getState());
  assert.deepEqual(draw(t, scope).map((d) => d.waiting), [true, true]);
  assert.deepEqual(draw(t, new RoomScope()).map((d) => d.waiting), [false, false]);
});
