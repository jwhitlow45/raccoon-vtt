import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../state/scope.ts";

/*
 * The DM panel's sections as folding groups (docs/design/design-v1-panel-groups.md
 * 6.1, 6.2 and 10): in today's order, the play ones open and the setup ones
 * folded on a phone, each named by its section's label with its summary,
 * Join requests first and never folded while one waits, and no line under
 * the panel's header on its first group. Drawn to markup at a phone's layout
 * width (no window, so layoutWidth reads 0).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../state/view.ts");
const { RoomScopeProvider } = await import("../state/scope.ts");
const { default: DmPanel } = await import("./DmPanel.tsx");
const { joinRequestsSlot } = await import("../features/dm/JoinRequests.tsx");
const { dmPanelFoldsSlot } = await import("../lib/folds.ts");
const { pdfJobSlot } = await import("../features/handouts/pdf/job.ts");
const { partySightSlot } = await import("../features/vision/sightMode.ts");

/** A device's storage for the file, which the panel's fold store reads as it is made: with none, every section opens (lib/folds.ts). */
const items = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
};

/**
 * Sets a store's state for a render to markup, which reads a zustand store's
 * first state (its server snapshot) rather than its state now.
 */
function seed<T>(store: { setState(s: T): void; getState(): T; getInitialState(): T }, state: T): void {
  store.setState(state);
  store.getInitialState = store.getState;
}

type Setup = { view?: RoomState; sceneId?: string; displays?: number; scope?: RoomScope };

function draw(setup: Setup = {}): string {
  const view = setup.view ?? room();
  const store = createStore(() => ({
    view,
    you: { memberId: "dm1", role: "dm" },
    roomId: "r1",
    sceneId: setup.sceneId ?? "s1",
    connection: "open",
    pending: [],
    online: [],
    displays: setup.displays ?? 0,
    accessVersion: 0,
    joinRequestsVersion: 0,
    local: { selectedIds: [], multi: false },
  }));
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: setup.scope ?? new RoomScope(),
      children: createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x", sendEph: () => {} } as never,
        ui: { notify: () => {}, openPanel: () => {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(DmPanel, {} as never),
      }),
    }),
  );
}

/** Each group's name, whether it folds and is open, its summary's words, and whether it draws its top line, in order. */
function groups(markup: string) {
  return [...markup.matchAll(/<div data-panel-group="" style="([^"]*)">(.*?)<\/h3>/g)].map((m) => {
    const head = m[2]!;
    const expanded = /aria-expanded="(true|false)"/.exec(head)?.[1];
    return {
      name: /data-group-name=""[^>]*>([^<]*)</.exec(head)?.[1]?.replace(/&#x27;/g, "'"),
      open: expanded === undefined ? "never folds" : expanded === "true",
      summary: /id="[^"]*-summary"[^>]*>(.*?)<\/span><\/span><\/button>/.exec(head)?.[1]?.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'") ?? null,
      line: m[1]!.includes("border-top"),
      reserve: head.includes("data-group-reserve"),
    };
  });
}

describe("the DM panel's groups on a phone, nothing stored", () => {
  test("today's order, Handouts and Players' screens open, the setup three folded with their summaries, and no line over the first", () => {
    assert.deepEqual(groups(draw()), [
      { name: "Handouts", open: true, summary: null, line: false, reserve: false },
      { name: "Players' screens", open: true, summary: null, line: true, reserve: false },
      { name: "Preview", open: false, summary: null, line: true, reserve: false },
      { name: "Player link", open: false, summary: null, line: true, reserve: false },
      { name: "Table display", open: false, summary: "No display", line: true, reserve: false },
    ]);
  });

  test("folded, each says what it holds", () => {
    const scope = new RoomScope();
    for (const s of ["handouts", "screens"] as const) scope.get(dmPanelFoldsSlot).tap(s, false, false);
    const view = room({ handouts: { h1: { id: "h1", title: "Map", assetId: "a1", to: "all", shownAt: "2026-11-03T00:00:00Z" } as never } });
    view.meta.view = { follow: true, blackout: true };
    view.scenes.s2 = scene("s2", { name: "Crypt" });
    view.meta.playerSceneId = "s2";
    const drawn = groups(draw({ view, scope, displays: 2 }));
    assert.deepEqual(
      drawn.map((g) => [g.name, g.summary]),
      [
        ["Handouts", "1 showing"],
        ["Players' screens", "Players on Crypt · Follow me on · Players see black"],
        ["Preview", null],
        ["Player link", null],
        ["Table display", "2 displays"],
      ],
    );
  });

  test("Preview says Party sight is on only on a scene with party vision", () => {
    const scope = new RoomScope();
    seed(scope.get(partySightSlot), { on: true });
    assert.equal(groups(draw({ scope }))[2]!.summary, null, "a scene with no party vision has no Party sight");
    const view = room();
    view.scenes.s1 = scene("s1", { vision: { on: true } as never });
    assert.equal(groups(draw({ view, scope }))[2]!.summary, "Party sight on");
  });

  test("an upload waiting on the DM badges folded Handouts, its words in the description", () => {
    const scope = new RoomScope();
    scope.get(dmPanelFoldsSlot).tap("handouts", false, false);
    // A range to pick, the first wait on the DM as a PDF opens.
    const job = { fileName: "Map.pdf", docId: "d1", title: "Map", numPages: 3, from: "1", to: "3", range: null, pages: [], leftOut: [], phase: { k: "range" }, uncertain: null, announce: "", announced: 0 };
    seed(scope.get(pdfJobSlot).store, { job, blockShown: false } as never);
    const markup = draw({ scope });
    assert.equal(groups(markup)[0]!.summary, "None showing, 11 upload waiting");
    assert.match(markup, /None showing<span style="[^"]*">, <\/span><span style="[^"]*"><span aria-hidden="true">1<\/span><span style="[^"]*">1 upload waiting<\/span><\/span>/);
  });

  test("every group keeps its content mounted while folded", () => {
    const markup = draw();
    for (const words of ["View as a player", "Show the player link", "Show my view on the table display"]) assert.ok(markup.includes(words), words);
  });
});

describe("Join requests over the folding groups", () => {
  test("first while one waits, never folding, its name where the chevrons' names start, and the line moves to Handouts", () => {
    const scope = new RoomScope();
    seed(scope.get(joinRequestsSlot).store, {
      kind: "shown",
      stale: false,
      list: { mode: "password_or_ask", players: [], requests: [{ id: "q1", name: "Fern", color: "#888", askedAt: "2026-11-03T00:00:00Z" }] },
    } as never);
    const drawn = groups(draw({ scope }));
    assert.deepEqual(drawn[0], { name: "Join requests", open: "never folds", summary: null, line: false, reserve: true });
    assert.deepEqual(
      drawn.slice(1).map((g) => [g.name, g.line]),
      [
        ["Handouts", true],
        ["Players' screens", true],
        ["Preview", true],
        ["Player link", true],
        ["Table display", true],
      ],
    );
  });
});
