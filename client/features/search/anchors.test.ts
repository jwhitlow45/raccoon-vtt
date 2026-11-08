import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { DM, entry, P1 } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import type { RoomView } from "../../state/types.ts";
import type { DmMenuView } from "../../pages/chipMenus.ts";
import type { RecentHandout } from "../handouts/recent.ts";
import { DM_CATALOG, dmMenuViewOf } from "./catalog/dm.ts";
import { EVERYONE } from "./catalog/everyone.ts";
import type { Catalog, SearchContext } from "./catalog/types.ts";
import type { SearchRoute } from "./entry.ts";
import { searchRole } from "./index.ts";
import { indexOf, seededRoom, viewOf } from "./search.testutil.ts";

/*
 * Each control the catalogs route to draws its anchor
 * (docs/design/design-v1-qol.md 5, What keeps it current): the DM panel,
 * Menu's X-card, Room settings, Members, Scenes, Time, Initiative,
 * Characters, the Log and Sound, drawn to markup as a DM and as a player,
 * hold the `data-search` id of every entry and twin that routes there and
 * holds now, and no id the catalogs do not know. A player's drawing holds
 * every anchor of everyone's catalog there, so no entry a player cannot reach
 * ships in the room's chunk. Drawn at a phone's layout width (no window).
 * This device's page cannot draw to markup (its turn and ping sound switches
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
const { default: ScenesPanel } = await import("../../panels/ScenesPanel.tsx");
const { default: TimePanel } = await import("../clock/TimePanel.tsx");
const { default: TrackerPanel } = await import("../../panels/TrackerPanel.tsx");
const { default: CharactersPanel } = await import("../tokens/CharactersPanel.tsx");
const { default: LogPanel } = await import("../../panels/LogPanel.tsx");
const { default: SoundPanel } = await import("../sound/panel/SoundPanel.tsx");
const { default: DicePanel } = await import("../dice/DicePanel.tsx");
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

function draw(view: RoomView, Component: (props: never) => unknown, props: object = {}): string {
  const store = createStore(() => ({ ...view, floorView: view.view, connection: "open", pending: [], online: [], displays: 0, accessVersion: 0, joinRequestsVersion: 0 }));
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: scopeFor(view),
      children: createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x", sendEph: () => {} } as never,
        ui: { notify: () => {}, openPanel: () => {}, closePanel: () => {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(Component as never, props as never),
      }),
    }),
  );
}

function anchorsIn(markup: string): string[] {
  return [...markup.matchAll(/\bdata-search="([^"]+)"/g)].map((m) => m[1]!);
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * The anchors on a control that a wide setting row draws under its name,
 * where the control's only name is the row's: a choice, a list or a field,
 * not a button, which says what it does. A landing brings its anchor near
 * the top of the panel, so one on such a control scrolls the name above it
 * out of view, as the Light row's level did. A row with an
 * anchor of its own is the landing, and may hold others.
 */
function anchorsUnderRowNames(markup: string): string[] {
  const out: string[] = [];
  /** Each open element, true for a wide row with no anchor of its own. */
  const open: boolean[] = [];
  let wide = 0;
  let rowJustOpened = false;
  for (const [, close, tag, attrs, self] of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    if (close) {
      if (open.pop()) wide--;
      continue;
    }
    // A wide row's words take the whole line (components/SettingRow.tsx), so its control sits under them.
    if (rowJustOpened && /flex:1 1 100%/.test(attrs!)) {
      open[open.length - 1] = true;
      wide++;
    }
    rowJustOpened = false;
    const search = /\bdata-search="([^"]+)"/.exec(attrs!)?.[1];
    if (search && wide > 0 && tag !== "button") out.push(search);
    if (self || VOID.has(tag!)) continue;
    open.push(false);
    rowJustOpened = /\bdata-setting-row=""/.test(attrs!) && !search;
  }
  return out;
}

/** Room settings' Room name and New scenes, still anchored on the control under their row's name until a follow-up moves them. */
const UNDER_ROW_NAMES_FOR_NOW = new Set(["menu.room-settings.name", "menu.room-settings.grid-and-distance.new-scenes"]);

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
  for (const view of [viewOf(fullRoom(), DM), viewOf(fullRoom(), P1), viewOf(phasesRoom(), DM)]) {
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

/** A clock running, shown to players: Time's controls of a running clock. */
function clockRoom(): RoomState {
  const room = fullRoom();
  room.clock = { id: "c1", rev: 0, t: 0, shown: true, calendar: { kind: "days" } };
  return room;
}

/** The scene in view with two map phases, whose Show a phase is the DM menu's phase items' twin. */
function phasesRoom(): RoomState {
  const room = fullRoom();
  const phase = (id: string, name: string) => ({ id, name, assetId: `map-${id}`, widthPx: 100, heightPx: 100 });
  room.scenes.s1 = { ...room.scenes.s1!, map: { assetId: "map-day", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } }, phases: [phase("day", "Day"), phase("night", "Night")], phaseId: "day" };
  return room;
}

/** A fight running, with a goblin's row: Initiative's setup and settings. */
function fightRoom(): RoomState {
  const room = fullRoom();
  room.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "g1", value: 12 })] };
  return room;
}

/**
 * A surface drawn for the roles that have it: Room settings and the DM panel are a DM's, and only a player's You menu has the X-card as an item.
 * `room` draws it on another room than the full one, and `props` are its panel's.
 */
type Surface = { name: string; panel: string; page?: string; roles: readonly ("dm" | "player")[]; Component: (props: never) => unknown; room?: () => RoomState; props?: object };

const PANEL = { close: () => {}, selectedTokenId: null };

const SURFACES: Surface[] = [
  { name: "the DM panel", panel: "dm", roles: ["dm"], Component: DmPanel as never },
  { name: "Menu's X-card", panel: "menu", roles: ["player"], Component: XCardButton as never },
  { name: "Room settings", panel: "menu", page: "settings", roles: ["dm"], Component: SettingsPanel as never },
  { name: "Members", panel: "menu", page: "members", roles: ["dm", "player"], Component: MembersPanel as never },
  { name: "Scenes", panel: "scenes", roles: ["dm"], Component: ScenesPanel as never, props: PANEL },
  { name: "Scenes with map phases", panel: "scenes", roles: ["dm"], Component: ScenesPanel as never, props: PANEL, room: phasesRoom },
  { name: "Time with no clock", panel: "time", roles: ["dm"], Component: TimePanel as never, props: PANEL },
  { name: "Time with a clock", panel: "time", roles: ["dm"], Component: TimePanel as never, props: PANEL, room: clockRoom },
  { name: "Initiative with no fight", panel: "tracker", roles: ["dm"], Component: TrackerPanel as never, props: PANEL },
  { name: "Initiative in a fight", panel: "tracker", roles: ["dm"], Component: TrackerPanel as never, props: PANEL, room: fightRoom },
  { name: "Characters", panel: "characters", roles: ["dm"], Component: CharactersPanel as never, props: PANEL },
  { name: "the Log", panel: "log", roles: ["dm", "player"], Component: LogPanel as never, props: PANEL },
  { name: "Sound before the server says it has sound files", panel: "sound", page: "now", roles: ["dm"], Component: SoundPanel as never, props: PANEL },
  // With nothing selected, so no creature's groups, which wait for its rolls to load.
  { name: "Dice with nothing selected", panel: "dice", roles: ["dm"], Component: DicePanel as never, props: PANEL },
];

/** The anchors a surface must draw for a viewer: every route there that names one. */
function expected(surface: Surface, catalogs: readonly Catalog[], ctx: SearchContext): string[] {
  return routes(catalogs, ctx)
    .filter((r) => r.panel === surface.panel && r.page === surface.page && r.anchor !== undefined)
    .map((r) => r.anchor!)
    .filter((a, i, all) => all.indexOf(a) === i);
}

describe("each entry's control draws its anchor (design-v1-qol.md 5, What keeps it current)", () => {
  const all = known();
  for (const role of ["dm", "player"] as const) {
    const catalogs = role === "dm" ? [EVERYONE, DM_CATALOG] : [EVERYONE];
    for (const surface of SURFACES) {
      if (!surface.roles.includes(role)) continue;
      const view = viewOf((surface.room ?? fullRoom)(), role === "dm" ? DM : P1);
      const ctx = contextOf(view, false);
      test(`${surface.name}, as ${role === "dm" ? "the DM" : "a player"}`, () => {
        const markup = draw(view, surface.Component, surface.props);
        const drawn = anchorsIn(markup);
        const want = expected(surface, catalogs, ctx);
        assert.ok(want.length > 0, "the check reads routes to this surface");
        for (const a of want) assert.ok(drawn.includes(a), `${a} is routed to but not drawn`);
        for (const a of drawn) assert.ok(all.has(a), `${a} is drawn but no entry or twin routes to it`);
        assert.equal(new Set(drawn).size, drawn.length, `an anchor drawn twice: ${drawn.join(" ")}`);
        assert.deepEqual(anchorsUnderRowNames(markup).filter((a) => !UNDER_ROW_NAMES_FOR_NOW.has(a)), [], "a control under a wide row's name is anchored at the row, so a landing shows the name");
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

describe("a creature's fields draw their anchors (design-v1-qol.md 5, What it finds and What keeps it current)", () => {
  /** Every field place of a viewer's catalogs on one surface. */
  const places = (catalogs: readonly Catalog[], where: "token" | "page") => catalogs.flatMap((c) => c.fields.flatMap((f) => (f[where] ? [f[where].anchor] : [])));
  // Every group the fields live in open, as a route's reveal opens the one on its way: a folded group draws nothing under its header. Position stays folded: its Attach reads the window, which a render to markup has not.
  beforeEach(async () => {
    const { FOLD_KEYS, FOLDS_KEY } = await import("../tokens/panelFolds.ts");
    items.set(FOLDS_KEY, JSON.stringify(Object.fromEntries(FOLD_KEYS.map((k) => [k, k !== "position"]))));
  });
  afterEach(() => items.clear());

  test("the token panel, for the DM's selected goblin and for a player's own character's token", async () => {
    const { default: TokenPanel } = await import("../../panels/TokenPanel.tsx");
    const all = new Set([...places([EVERYONE, DM_CATALOG], "token")]);
    for (const [viewer, tokenId, catalogs] of [
      [DM, "g1", [EVERYONE, DM_CATALOG]],
      [P1, "tbree", [EVERYONE]],
    ] as const) {
      const view = viewOf(fullRoom(), viewer, { selectedId: tokenId });
      const drawn = anchorsIn(draw(view, TokenPanel as never, { ...PANEL, selectedTokenId: tokenId }));
      for (const a of places(catalogs, "token")) assert.ok(drawn.includes(a), `${a} is a field of the ${viewer.role}'s but not drawn`);
      for (const a of drawn.filter((a) => a.startsWith("token."))) assert.ok(all.has(a), `${a} is drawn but no field routes to it`);
      assert.equal(new Set(drawn).size, drawn.length, `an anchor drawn twice: ${drawn.join(" ")}`);
    }
  });

  test("the index offers a selected token's field exactly where its panel draws the field's anchor, for a token lent without its character, an HP-less creature and a card with rows unset too", async () => {
    const { default: TokenPanel } = await import("../../panels/TokenPanel.tsx");
    // Kel's token lent to Pat, who plays Bree, not Kel: Pat owns the token and holds none of Kel's card.
    const lent = () => {
      const room = fullRoom();
      room.tokens.tkel = { ...room.tokens.tkel!, ownerIds: ["p1"] };
      return room;
    };
    // A goblin with a maximum of 0 HP has no Armor Class in its card (hpLess).
    const hpLessGoblin = () => {
      const room = fullRoom();
      const g1 = room.tokens.g1!;
      room.tokens.g1 = { ...g1, actor: { inline: { ...("inline" in g1.actor ? g1.actor.inline : {}), hp: { cur: 0, max: 0, temp: 0 } } } } as never;
      return room;
    };
    // A goblin Pat owns with no Armor Class or Passive Perception set, which Pat may not set: its card draws neither row.
    const ownedBare = () => {
      const room = fullRoom();
      const g2 = room.tokens.g2!;
      const inline = { ...("inline" in g2.actor ? g2.actor.inline : {}) } as Record<string, unknown>;
      delete inline.ac;
      delete inline.passivePerception;
      room.tokens.g2 = { ...g2, ownerIds: ["p1"], actor: { inline } } as never;
      return room;
    };
    for (const [name, room, viewer, tokenId] of [
      ["the DM's goblin", fullRoom, DM, "g1"],
      ["Pat's goblin with no AC or Passive Perception", ownedBare, P1, "g2"],
      ["the DM's HP-less goblin", hpLessGoblin, DM, "g1"],
      ["Pat's own Bree", fullRoom, P1, "tbree"],
      ["Kel's token lent to Pat", lent, P1, "tkel"],
    ] as const) {
      const view = viewOf(room(), viewer, { selectedId: tokenId });
      const fieldAnchors = new Set(places(viewer === DM ? [EVERYONE, DM_CATALOG] : [EVERYONE], "token"));
      const drawn = anchorsIn(draw(view, TokenPanel as never, { ...PANEL, selectedTokenId: tokenId })).filter((a) => fieldAnchors.has(a));
      const offered = indexOf(view)
        .items.map((i) => i.entry)
        .filter((e) => e.id.startsWith(`field:token:${tokenId}:`))
        .map((e) => (e.act.t === "open" ? (e.act.route.anchor ?? "") : ""));
      assert.ok(offered.length > 0, `${name}: the index offers its fields`);
      assert.deepEqual([...offered].sort(), [...drawn].sort(), `${name}: offered and drawn`);
    }
  });

  test("the index offers a character's page field exactly where the page draws its anchor, for an HP-less character too", async () => {
    const { CharacterPage } = await import("../tokens/CharacterCard.tsx");
    // Kel at a maximum of 0 HP has no Armor Class on the page (hpLess).
    const hpLessKel = () => {
      const room = fullRoom();
      const kel = room.characters.kel!;
      room.characters.kel = { ...kel, actor: { ...kel.actor, hp: { cur: 0, max: 0, temp: 0 } } };
      return room;
    };
    for (const [name, room, viewer, characterId] of [
      ["Pat's Bree", fullRoom, P1, "bree"],
      ["the DM's Bree", fullRoom, DM, "bree"],
      ["the DM's HP-less Kel", hpLessKel, DM, "kel"],
    ] as const) {
      const view = viewOf(room(), viewer);
      const fieldAnchors = new Set(places(viewer === DM ? [EVERYONE, DM_CATALOG] : [EVERYONE], "page"));
      const character = view.view!.characters[characterId]!;
      const drawn = anchorsIn(draw(view, CharacterPage as never, { character, close: () => {}, onAddCompanion() {}, onBlocks() {}, onDelete: () => null })).filter((a) => fieldAnchors.has(a));
      const offered = indexOf(view)
        .items.map((i) => i.entry)
        .filter((e) => e.id.startsWith(`field:character:${characterId}:`))
        .map((e) => (e.act.t === "character" ? (e.act.route?.anchor ?? "") : ""));
      // A DM finds only the few fields play reads on every character's page (everyCharacter).
      const want = viewer === DM ? drawn.filter((a) => [EVERYONE, DM_CATALOG].some((c) => c.fields.some((f) => f.page?.anchor === a && f.everyCharacter))) : drawn;
      assert.deepEqual([...offered].sort(), [...want].sort(), `${name}: offered and drawn`);
    }
  });

  test("a character's page, for its player and for the DM", async () => {
    const { CharacterPage } = await import("../tokens/CharacterCard.tsx");
    for (const viewer of [P1, DM]) {
      const view = viewOf(fullRoom(), viewer);
      const bree = view.view!.characters.bree!;
      const drawn = anchorsIn(draw(view, CharacterPage as never, { character: bree, close: () => {}, onAddCompanion() {}, onBlocks() {}, onDelete: () => null }));
      for (const a of places(viewer === DM ? [EVERYONE, DM_CATALOG] : [EVERYONE], "page")) assert.ok(drawn.includes(a), `${a} is not drawn for the ${viewer.role}`);
      assert.equal(new Set(drawn).size, drawn.length, `an anchor drawn twice: ${drawn.join(" ")}`);
    }
  });
});
