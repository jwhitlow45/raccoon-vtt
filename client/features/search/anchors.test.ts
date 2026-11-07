import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { DM, P1 } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import type { RoomView } from "../../state/types.ts";
import type { DmMenuView } from "../../pages/chipMenus.ts";
import type { RecentHandout } from "../handouts/recent.ts";
import { DM_CATALOG, dmMenuViewOf } from "./catalog/dm.ts";
import { EVERYONE } from "./catalog/everyone.ts";
import type { Catalog, SearchContext } from "./catalog/types.ts";
import type { SearchRoute } from "./entry.ts";
import { searchRole } from "./index.ts";
import { seededRoom, viewOf } from "./search.testutil.ts";

/*
 * Each control the catalogs route to draws its anchor (designs/qol/search.md
 * 5.10): the DM panel, Menu's X-card, Room settings and Members, drawn
 * to markup as a DM and as a player, hold the `data-search`
 * id of every entry and twin that routes there and holds now, and no id
 * the catalogs do not know. A player's drawing holds every anchor of
 * everyone's catalog there, so no entry a player cannot reach ships in
 * the room's chunk. Drawn at a phone's layout width (no window). This
 * device's page cannot draw to markup (its turn and ping sound switches
 * read a store with no server snapshot), so catalog.test.ts's source scan
 * alone holds its anchors.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const { default: DmPanel } = await import("../../panels/DmPanel.tsx");
// Menu's first page draws its X-card button. The page itself imports the About page's notice, which the test loader cannot read.
const { XCardButton } = await import("../xcard/XCardButton.tsx");
const { default: SettingsPanel } = await import("../../panels/SettingsPanel.tsx");
const { default: MembersPanel } = await import("../../panels/MembersPanel.tsx");
const { joinRequestsSlot } = await import("../dm/JoinRequests.tsx");
const { recentHandoutsSlot } = await import("../handouts/recent.ts");

/** A device's storage for the file, which the fold stores read as they are made: with none, every fold opens (lib/folds.ts). */
const items = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
};

/** Sets a store's state for a render to markup, which reads a zustand store's first state. */
function seed<T>(store: { setState(s: T): void; getState(): T; getInitialState(): T }, state: T): void {
  store.setState(state);
  store.getInitialState = store.getState;
}

/**
 * The seeded room with what draws every anchor that waits on the room:
 * party vision on the scene in view and chosen movers. No sounds: Include
 * sounds waits on the server's answer about the room's storage
 * (settings/ExportSection.tsx), which a drawing to markup never gets.
 */
function fullRoom(): RoomState {
  const room = seededRoom();
  room.scenes.s1 = { ...room.scenes.s1!, vision: { on: true } as never };
  room.meta.settings.playersMoveAny = ["p1"];
  room.sounds = {};
  room.playlists = {};
  return room;
}

/** A document this device showed before, which the DM panel's Recent and the DM menu offer again. */
const SHOWN_BEFORE: RecentHandout = { kind: "doc", docId: "letter", title: "Belak's letter", to: "all", at: Date.UTC(2026, 10, 6, 12) };

/** A viewer's search context, the DM's with the DM menu's view as the menu reads it, this device's recent showing in it. */
function contextOf(view: RoomView, wide: boolean): SearchContext {
  const dmMenu: DmMenuView | undefined = view.you?.role === "dm" ? { ...dmMenuViewOf(view), recent: [SHOWN_BEFORE] } : undefined;
  return { role: searchRole(view), memberId: view.you?.memberId ?? null, state: view, wide, ...(dmMenu ? { dmMenu } : null) };
}

function scopeFor(view: RoomView): RoomScope {
  const scope = new RoomScope();
  seed(scope.get(joinRequestsSlot).store, { kind: "shown", stale: false, list: { mode: "password_or_ask", players: [], requests: [] } } as never);
  seed(scope.get(recentHandoutsSlot), { roomId: view.roomId, entries: [SHOWN_BEFORE] });
  return scope;
}

function draw(view: RoomView, Component: (props: never) => unknown): string {
  const store = createStore(() => ({ ...view, connection: "open", pending: [], online: [], displays: 0, accessVersion: 0, joinRequestsVersion: 0 }));
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: scopeFor(view),
      children: createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x", sendEph: () => {} } as never,
        ui: { notify: () => {}, openPanel: () => {}, closePanel: () => {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(Component as never, {} as never),
      }),
    }),
  );
}

function anchorsIn(markup: string): string[] {
  return [...markup.matchAll(/\bdata-search="([^"]+)"/g)].map((m) => m[1]!);
}

/** The routes of a viewer's catalogs whose entry holds now: each entry's, and each DM menu item's twin. */
function routes(catalogs: readonly Catalog[], ctx: SearchContext): SearchRoute[] {
  const out: SearchRoute[] = [];
  for (const c of catalogs) {
    for (const e of [...c.entries.filter((e) => !e.when || e.when(ctx)), ...(c.items?.(ctx) ?? [])]) {
      if (e.act.t === "open") out.push(e.act.route);
      if (e.act.t === "item") out.push(e.act.twin);
    }
  }
  return out;
}

/** Every anchor any catalog routes to, whatever holds now, for the reverse check. */
function known(): Set<string> {
  const all = new Set<string>();
  for (const view of [viewOf(fullRoom(), DM), viewOf(fullRoom(), P1)]) {
    const ctx = contextOf(view, true);
    for (const c of [EVERYONE, DM_CATALOG]) {
      for (const e of [...c.entries, ...(c.items?.(ctx) ?? [])]) {
        const route = e.act.t === "open" ? e.act.route : e.act.t === "item" ? e.act.twin : null;
        if (route?.anchor) all.add(route.anchor);
      }
    }
  }
  return all;
}

/** A surface drawn for the roles that have it: Room settings and the DM panel are a DM's, and only a player's You menu has the X-card as an item. */
type Surface = { name: string; panel: string; page?: string; roles: readonly ("dm" | "player")[]; Component: (props: never) => unknown };

const SURFACES: Surface[] = [
  { name: "the DM panel", panel: "dm", roles: ["dm"], Component: DmPanel as never },
  { name: "Menu's X-card", panel: "menu", roles: ["player"], Component: XCardButton as never },
  { name: "Room settings", panel: "menu", page: "settings", roles: ["dm"], Component: SettingsPanel as never },
  { name: "Members", panel: "menu", page: "members", roles: ["dm", "player"], Component: MembersPanel as never },
];

/** The anchors a surface must draw for a viewer: every route there that names one. */
function expected(surface: Surface, catalogs: readonly Catalog[], ctx: SearchContext): string[] {
  return routes(catalogs, ctx)
    .filter((r) => r.panel === surface.panel && r.page === surface.page && r.anchor !== undefined)
    .map((r) => r.anchor!)
    .filter((a, i, all) => all.indexOf(a) === i);
}

describe("each entry's control draws its anchor (search.md 5.10)", () => {
  const all = known();
  for (const role of ["dm", "player"] as const) {
    const view = viewOf(fullRoom(), role === "dm" ? DM : P1);
    const ctx = contextOf(view, false);
    const catalogs = role === "dm" ? [EVERYONE, DM_CATALOG] : [EVERYONE];
    for (const surface of SURFACES) {
      if (!surface.roles.includes(role)) continue;
      test(`${surface.name}, as ${role === "dm" ? "the DM" : "a player"}`, () => {
        const drawn = anchorsIn(draw(view, surface.Component));
        const want = expected(surface, catalogs, ctx);
        assert.ok(want.length > 0, "the check reads routes to this surface");
        for (const a of want) assert.ok(drawn.includes(a), `${a} is routed to but not drawn`);
        for (const a of drawn) assert.ok(all.has(a), `${a} is drawn but no entry or twin routes to it`);
        assert.equal(new Set(drawn).size, drawn.length, `an anchor drawn twice: ${drawn.join(" ")}`);
      });
    }
  }

  test("a player's surfaces draw none of the DM's anchors", () => {
    const view = viewOf(fullRoom(), P1);
    const dmOnly = new Set(routes([DM_CATALOG], contextOf(viewOf(fullRoom(), DM), true)).flatMap((r) => (r.anchor ? [r.anchor] : [])));
    for (const surface of SURFACES.filter((s) => s.roles.includes("player"))) {
      for (const a of anchorsIn(draw(view, surface.Component))) assert.ok(!dmOnly.has(a), `${surface.name} draws the DM's ${a} for a player`);
    }
  });
});
