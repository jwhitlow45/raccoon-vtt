import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ambianceFoldsSlot } from "../../lib/folds.ts";
import { RoomScope } from "../../state/scope.ts";
import type { PanelHow } from "../../state/types.ts";
import { AMBIANCE_PANEL, ambianceRequestSlot, ambianceRootsSlot, openAmbiance, useAmbianceRoot } from "./request.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * The one way into Ambiance from elsewhere (docs/design/design-v1-panel-groups.md
 * 4.3): the top bar's chip, its only caller now that Weather lives in Scenes
 * (docs/design/design-v1-scenes-reorg.md 7), and any later caller in a panel.
 */

/** What openAmbiance asks of the room's UI and the page, recorded in order. */
function recorder() {
  const calls: string[] = [];
  return { calls, ui: { openPanel: (id: string, how?: PanelHow) => calls.push(`openPanel ${id} ${JSON.stringify(how ?? null)}`) } };
}

const CLOCK = { clock: true, scenes: true };

/** This device's storage, empty, for every Room page in this file: Node has none, and a store that cannot read one opens every section. */
const stored = new Map<string, string>();
let writes = 0;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => {
    writes++;
    stored.set(key, value);
  },
};

/** A page whose focus sits on `active`, for the length of `fn`. */
function withFocus(active: unknown, fn: () => void): void {
  const world = globalThis as { document?: unknown };
  const before = world.document;
  world.document = { activeElement: active };
  try {
    fn();
  } finally {
    world.document = before;
  }
}

describe("openAmbiance", () => {
  test("the chip: Ambiance opens in the top pane, and Time shows open", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    openAmbiance(scope, ui, "time", { pane: "top" });
    assert.deepEqual(calls, ['openPanel ambiance {"pane":"top"}']);
    assert.equal(AMBIANCE_PANEL, "ambiance");
    assert.deepEqual(scope.get(ambianceRequestSlot).getState(), { section: "time", seq: 1 });
    assert.equal(scope.get(ambianceFoldsSlot).get(390, CLOCK).time, true, "revealed over its folded start");
  });

  test("a caller in a panel: Ambiance opens from that panel, so with two panels in the other pane", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    openAmbiance(scope, ui, "time", { from: "log" });
    assert.deepEqual(calls, ['openPanel ambiance {"from":"log"}']);
    assert.deepEqual(scope.get(ambianceRequestSlot).getState(), { section: "time", seq: 1 });
    assert.equal(scope.get(ambianceFoldsSlot).get(390, CLOCK).time, true);
  });

  test("the request asks for no focus: its only caller with focus, Scenes' Weather row, is gone (SCN-O-02)", () => {
    const scope = new RoomScope();
    // @ts-expect-error: openAmbiance takes no focus option now.
    openAmbiance(scope, recorder().ui, "time", { pane: "top", focus: true });
    assert.deepEqual(Object.keys(scope.get(ambianceRequestSlot).getState()).sort(), ["section", "seq"]);
  });

  test("with neither, it opens as any path outside the panels does", () => {
    const { calls, ui } = recorder();
    openAmbiance(new RoomScope(), ui, "sound", { from: null });
    assert.deepEqual(calls, ["openPanel ambiance null"]);
  });

  test("each press is a new request, so a second press acts again", () => {
    const scope = new RoomScope();
    const { ui } = recorder();
    openAmbiance(scope, ui, "time", { pane: "top" });
    openAmbiance(scope, ui, "time", { pane: "top" });
    assert.equal(scope.get(ambianceRequestSlot).getState().seq, 2);
  });

  test("the section opens for now and is never written: once Ambiance closes, the fold the DM left shows again", () => {
    const scope = new RoomScope();
    const folds = scope.get(ambianceFoldsSlot);
    const { ui } = recorder();
    folds.follow(true, CLOCK);
    openAmbiance(scope, ui, "time", { pane: "top" });
    assert.equal(folds.get(390, CLOCK).time, true);
    folds.follow(false, CLOCK);
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).time, false);
    assert.equal(writes, 0, "nothing stored");
  });

  test("a request in one Room page never reaches another's, as a preview's never reaches the DM's", () => {
    const dm = new RoomScope();
    const preview = new RoomScope();
    openAmbiance(preview, recorder().ui, "time", { pane: "top" });
    assert.equal(dm.get(ambianceRequestSlot).getState().seq, 0);
    assert.equal(dm.get(ambianceFoldsSlot).get(390, CLOCK).time, false);
  });

  test("a field focused in the panel, such as a subpage's name, blurs before anything else, so it saves while still drawn", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    const field = { blur: () => calls.push(`blur, request ${scope.get(ambianceRequestSlot).getState().seq}`) };
    scope.get(ambianceRootsSlot).add({ contains: (node) => node === (field as never) });
    withFocus(field, () => openAmbiance(scope, ui, "time", { pane: "top" }));
    assert.deepEqual(calls, ["blur, request 0", 'openPanel ambiance {"pane":"top"}']);
  });

  test("focus anywhere else is left where it is", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    const elsewhere = { blur: () => calls.push("blur") };
    scope.get(ambianceRootsSlot).add({ contains: () => false });
    withFocus(elsewhere, () => openAmbiance(scope, ui, "time", { pane: "top" }));
    withFocus(null, () => openAmbiance(scope, ui, "time", { pane: "top" }));
    assert.deepEqual(calls, ['openPanel ambiance {"pane":"top"}', 'openPanel ambiance {"pane":"top"}']);
  });

  test("useAmbianceRoot: the panel's root counts while mounted, and no longer once it goes", () => {
    const scope = new RoomScope();
    let ref: ((el: HTMLElement | null) => void | (() => void)) | null = null;
    function Probe() {
      ref = useAmbianceRoot();
      return null;
    }
    renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: createElement(Probe) }));
    const root = { contains: () => true } as unknown as HTMLElement;
    const cleanup = ref!(root);
    assert.ok(scope.get(ambianceRootsSlot).has(root));
    assert.equal(typeof cleanup, "function");
    (cleanup as () => void)();
    assert.equal(scope.get(ambianceRootsSlot).size, 0);
    assert.equal(ref!(null), undefined, "a null ref adds nothing");
    assert.equal(scope.get(ambianceRootsSlot).size, 0);
  });
});
