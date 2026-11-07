import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ClientOp } from "#shared/protocol.ts";
import { DM, scene } from "#shared/testutil.ts";
import { setRoomSoundChoice } from "../device/settings.ts";
import { dmMenuSections, itemsOf, type ChipEnv, type DmMenuView } from "../../pages/chipMenus.ts";
import type { DmItemKind } from "../../pages/chipWords.ts";
import type { RoomView } from "../../state/types.ts";
import type { RecentHandout } from "../handouts/recent.ts";
import { PANELS, panelsFor } from "../panels.ts";
import { groupAnchor, SETTING_GROUPS, settingAnchor } from "../settings/form.ts";
import { DM_CATALOG, dmMenuEntries, dmMenuViewOf, TWINS, type SearchedItemKind } from "./catalog/dm.ts";
import { EVERYONE } from "./catalog/everyone.ts";
import type { Catalog, CatalogEntry, SearchContext } from "./catalog/types.ts";
import { isSearchId, type SearchEntry, type SearchRoute } from "./entry.ts";
import { buildIndex, searchRole, VIEW_ANCHORS } from "./index.ts";
import { MENU_PAGES, recordId, routeFolds } from "./route.ts";
import { DM_VIEW, keysOf, PAT_VIEW, seededRoom, viewOf } from "./search.testutil.ts";

/*
 * The catalogs lanes S2a and S2b write (designs/qol/search.md 5.10's unit
 * test): ids unique, every route's panel, page and fold real, every entry
 * a player may not reach in the DM's catalog, every kind of DM menu item a
 * row with a twin, and every anchor the catalogs route to drawn by exactly
 * one `search=` in client/**\/*.tsx, and the reverse.
 */

const ctxOf = (state: RoomView, over: Partial<SearchContext> = {}): SearchContext => ({ role: searchRole(state), memberId: state.you?.memberId ?? null, state, wide: true, ...over });

/** Every entry a catalog can offer a viewer, whatever its `when` says now, and its items for that viewer. */
function entriesOf(catalog: Catalog, ctx: SearchContext): CatalogEntry[] {
  return [...catalog.entries, ...(catalog.items?.(ctx) ?? [])];
}

/** Where an entry goes: its route, or a DM menu item's twin. */
function routesOf(e: SearchEntry): SearchRoute[] {
  if (e.act.t === "open") return [e.act.route];
  if (e.act.t === "item") return [e.act.twin];
  if (e.act.t === "character" && e.act.route) return [e.act.route];
  return [];
}

// The DM menu's views that draw every kind of item between them (chips.md C1, C2).
const at = "2026-11-06T12:00:00.000Z";
const crypt = scene("crypt", { name: "Crypt of Belak", phases: [{ id: "day", name: "Day" } as never, { id: "night", name: "Night" } as never], phaseId: "night" });
const members = { dm1: { id: "dm1", rev: 0, name: "Dee", color: "#4cc9f0", kind: "dm", createdAt: at }, p1: { id: "p1", rev: 0, name: "Pat", color: "#4cc9f0", kind: "player", createdAt: at } } as const;
const toPat: RecentHandout = { kind: "doc", docId: "letter", title: "Belak's letter", to: ["p1"], at: Date.UTC(2026, 10, 6, 12) };
const docs = { letter: { id: "letter", rev: 0, title: "Belak's letter", pages: [{ assetId: "p1", width: 10, height: 10 }], createdAt: at } };

function menuView(over: Partial<DmMenuView> = {}): DmMenuView {
  return {
    blackout: false,
    follow: false,
    viewing: crypt,
    playerScene: { id: crypt.id, name: crypt.name },
    focusHere: true,
    handouts: { h1: { id: "h1", rev: 0, assetId: "map", title: "The old map", to: "all", shownAt: at } },
    handoutDocs: docs,
    members,
    recent: [toPat],
    images: null,
    time: { text: "Day 4, 8:00 PM", name: "Time: Day 4" },
    nowPlaying: true,
    movingTo: null,
    revealing: null,
    outShown: false,
    ...over,
  } as DmMenuView;
}
const AT_PLAY = menuView();
const IN_BLACKOUT = menuView({ blackout: true, playerScene: { id: "hall", name: "Citadel gate" } });

/** Every kind of item, so a kind added to the menu shows here as one this test does not yet draw. */
const KINDS = {
  hideHandout: true,
  showRecent: true,
  showHandout: true,
  blackout: true,
  follow: true,
  bringEveryone: true,
  movePlayers: true,
  phase: true,
  viewAs: true,
  time: true,
  nowPlaying: true,
  endBlackout: true,
  showPlayers: true,
} as const satisfies Record<DmItemKind, true>;

const dmCtx = ctxOf(DM_VIEW(), { dmMenu: AT_PLAY });
const patCtx = ctxOf(PAT_VIEW());
const ALL: { where: string; entry: CatalogEntry }[] = [
  ...entriesOf(EVERYONE, patCtx).map((entry) => ({ where: "everyone's", entry })),
  ...entriesOf(DM_CATALOG, dmCtx).map((entry) => ({ where: "the DM's", entry })),
  ...dmMenuEntries(IN_BLACKOUT).map((entry) => ({ where: "the DM's", entry })),
];

describe("the catalogs' entries (search.md 5.10)", () => {
  test("ids are unique within a viewer's catalogs, and each is its kind and its anchor or the item's id", () => {
    for (const [ctx, catalogs] of [
      [dmCtx, [EVERYONE, DM_CATALOG]],
      [patCtx, [EVERYONE]],
    ] as const) {
      const ids = catalogs.flatMap((c) => entriesOf(c, ctx).map((e) => e.id));
      assert.equal(new Set(ids).size, ids.length, ids.filter((id, i) => ids.indexOf(id) !== i).join(" "));
    }
    for (const { entry } of ALL) {
      const route = routesOf(entry)[0];
      if (entry.act.t === "item") assert.equal(entry.id, `item:${entry.act.itemId}`);
      else if (route?.anchor) assert.equal(entry.id, `${entry.kind}:${route.anchor}`);
    }
  });

  test("every route names a panel, a page it has and a fold on its way, and a well formed anchor", () => {
    const panels = new Set(PANELS.map((p) => p.id));
    for (const { entry } of ALL) {
      for (const r of routesOf(entry)) {
        const name = `${entry.id} ${JSON.stringify(r)}`;
        assert.ok(panels.has(r.panel), name);
        if (r.page !== undefined) {
          if (r.panel === "menu") assert.ok((MENU_PAGES as readonly string[]).includes(r.page), name);
          else assert.ok(r.panel === "scenes" && recordId("scene", r.page) !== null, name);
        }
        if (r.section !== undefined) assert.ok(routeFolds(r.panel, r.page).includes(r.section), name);
        if (r.anchor !== undefined) assert.ok(isSearchId(r.anchor), name);
      }
    }
  });

  test("every entry a player may not reach is in the DM's catalog, so it never ships to a player's device", () => {
    const offered = new Set([...panelsFor("player", true), ...panelsFor("player", false)].map((p) => p.id));
    for (const e of entriesOf(EVERYONE, patCtx)) {
      for (const r of routesOf(e)) {
        assert.ok(offered.has(r.panel), `${e.id}: a player has no ${r.panel}`);
        assert.notEqual(r.page, "settings", `${e.id}: Room settings is a DM's`);
        assert.ok(!r.anchor?.startsWith("dm.") && !r.anchor?.startsWith("menu.room-settings."), e.id);
      }
    }
    assert.deepEqual(EVERYONE.items?.(dmCtx), [], "a DM has no You menu");
    assert.deepEqual(DM_CATALOG.items?.(patCtx), [], "a player's context draws no DM menu item");
    const everyone = new Set(entriesOf(EVERYONE, patCtx).map((e) => e.id));
    assert.ok(entriesOf(DM_CATALOG, dmCtx).every((e) => !everyone.has(e.id)));
  });
});

describe("the DM menu's items (search.md 5.5, plan.md 3)", () => {
  test("every kind the menu draws is one row with its twin, but Time and Now playing", () => {
    const drawn = new Set([...itemsOf(dmMenuSections(AT_PLAY)), ...itemsOf(dmMenuSections(IN_BLACKOUT))].map((i) => i.kind));
    assert.deepEqual([...drawn].sort(), Object.keys(KINDS).sort(), "the two views draw every kind");
    const searched = Object.keys(KINDS).filter((k) => k !== "time" && k !== "nowPlaying");
    assert.deepEqual(Object.keys(TWINS).sort(), searched.sort());
    for (const view of [AT_PLAY, IN_BLACKOUT]) {
      const rows = dmMenuEntries(view);
      for (const item of itemsOf(dmMenuSections(view))) {
        const row = rows.filter((r) => r.act.t === "item" && r.act.itemId === item.id);
        if (item.kind === "time" || item.kind === "nowPlaying") assert.equal(row.length, 0, item.id);
        else assert.equal(row.length, 1, item.id);
      }
    }
  });

  test("each row is titled as the menu titles it, where the menu holds it, a recent showing with its audience", () => {
    const rows = dmMenuEntries(AT_PLAY);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const s of dmMenuSections(AT_PLAY)) {
      for (const item of s.items) {
        const row = byId.get(`item:${item.id}`);
        if (!row) continue;
        assert.equal(row.where, `DM menu · ${s.heading}`);
        if (item.kind !== "showRecent") assert.equal(row.title, item.title);
      }
    }
    assert.equal(byId.get("item:recent:doc:letter")?.title, "Show Belak's letter to Pat");
    assert.equal(byId.get("item:recent:doc:letter")?.description, "Shows it to Pat again.");
    assert.equal(byId.get("item:follow")?.value, "Off");
    const lead = dmMenuEntries(IN_BLACKOUT).find((r) => r.id === "item:endBlackout");
    assert.equal(lead?.where, "DM menu · Players see black");
    assert.equal(lead?.description, "Players see the map again.");
    const away = dmMenuEntries(IN_BLACKOUT).find((r) => r.id === "item:movePlayers");
    assert.equal(away?.value, "on Crypt of Belak");
  });

  test("a showing to Pat is offered while Pat is in the room, and not once Pat has left", () => {
    assert.ok(dmMenuEntries(AT_PLAY).some((r) => r.id === "item:recent:doc:letter"));
    assert.ok(!dmMenuEntries(menuView({ members: { dm1: members.dm1 } as never })).some((r) => r.id === "item:recent:doc:letter"));
  });

  test("a row's item runs the very function the menu runs, sending the same op", () => {
    for (const view of [AT_PLAY, IN_BLACKOUT]) {
      for (const row of dmMenuEntries(view)) {
        if (row.act.t !== "item") continue;
        const id = row.act.itemId;
        const sent: ClientOp[][] = [[], []];
        // The menu's sections and the search's, built apart from the same view, as the menu and the search each build them.
        [dmMenuSections(view), dmMenuSections(view)].forEach((sections, i) => {
          const item = itemsOf(sections).find((it) => it.id === id);
          assert.ok(item, id);
          const env = { actions: { dispatch: (op: ClientOp) => (sent[i]!.push(op), 1), newId: () => "n", sendEph: () => {} }, notify: () => {}, moveRoom: { viewingId: "crypt", sight: undefined, serverSound: "off", playlists: {}, sounds: {} }, open: () => {}, focus: () => ({ sceneId: "crypt", x: 0, y: 0, zoom: 1 }), remember: () => {} } as unknown as ChipEnv;
          item.run(env, { confirmed: true });
        });
        assert.deepEqual(sent[0], sent[1], id);
      }
    }
    const blackout = dmMenuEntries(AT_PLAY).find((r) => r.id === "item:blackout")!;
    assert.deepEqual(blackout.act, { t: "item", itemId: "blackout", twin: { panel: "dm", section: "screens", anchor: "dm.screens.blackout" } });
  });

  test("each kind's twin is its panel control, the scene's row in Scenes for a move or a phase", () => {
    const twin = (kind: SearchedItemKind) => TWINS[kind](AT_PLAY);
    assert.deepEqual(twin("follow"), { panel: "dm", section: "screens", anchor: "dm.screens.follow" });
    assert.deepEqual(twin("endBlackout"), twin("blackout"));
    assert.deepEqual(twin("movePlayers"), { panel: "scenes", page: "scene:crypt" });
    assert.deepEqual(twin("showRecent"), { panel: "dm", section: "handouts", anchor: "dm.handouts.recent" });
    assert.deepEqual(twin("viewAs"), { panel: "dm", section: "check", anchor: "dm.preview.view-as" });
  });

  test("without the menu's own view the DM's index reads the room's, and a player's never draws an item", () => {
    const dm = buildIndex({ state: DM_VIEW(), wide: true, keys: keysOf(DM_VIEW()), catalogs: [EVERYONE, DM_CATALOG], monsters: null });
    const items = dm.items.filter((i) => i.entry.act.t === "item").map((i) => i.entry.id);
    assert.deepEqual(items.sort(), ["item:blackout", "item:bringEveryone", "item:follow", "item:showHandout", "item:viewAs:p1", "item:viewAs:p2"].sort());
    const fromMenu = buildIndex({ state: DM_VIEW(), wide: true, keys: keysOf(DM_VIEW()), catalogs: [EVERYONE, DM_CATALOG], monsters: null, dmMenu: { ...dmMenuViewOf(DM_VIEW()), recent: [{ ...toPat, to: "all" } as RecentHandout] } });
    assert.ok(fromMenu.byId.has("item:recent:doc:letter"), "this device's recent showing comes with the menu's view");
    const pat = buildIndex({ state: PAT_VIEW(), wide: true, keys: keysOf(PAT_VIEW()), catalogs: [EVERYONE, DM_CATALOG], monsters: null });
    assert.deepEqual(
      pat.items.filter((i) => i.entry.act.t === "item").map((i) => i.entry.id),
      ["item:xcard"],
    );
  });

  test("the room's own view: blackout, follow, the players' scene and the members from the projection", () => {
    const room = seededRoom();
    room.meta.view = { ...room.meta.view, blackout: true, follow: true };
    const view = dmMenuViewOf(viewOf(room, DM, { sceneId: "s2" }));
    assert.equal(view.blackout, true);
    assert.equal(view.follow, true);
    assert.equal(view.viewing?.id, "s2");
    assert.deepEqual(view.playerScene, { id: "s1", name: "Battle mat" });
    assert.deepEqual(Object.keys(view.members).sort(), ["dm1", "p1", "p2"]);
  });
});

describe("every anchor is drawn by exactly one search= in client/**/*.tsx, and the reverse (search.md 5.10)", () => {
  const client = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  /** `search="id"`, `data-search="id"`, a literal inside `search={…}`, and a `search: "id"` an element's props or data hold. */
  const SEARCH = /(?<![\w-])(?:data-)?search=(?:"([^"]*)"|\{([^}\n]*)\})|(?<![\w-])search:\s*"([^"]*)"/g;

  function literals(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(SEARCH)) {
      if (m[1] !== undefined) out.push(m[1]);
      if (m[3] !== undefined) out.push(m[3]);
      if (m[2] !== undefined) for (const l of m[2].matchAll(/"([^"]*)"/g)) out.push(l[1]!);
    }
    return out;
  }

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, d.name);
      if (d.isDirectory()) out.push(...sources(path));
      else if (d.name.endsWith(".tsx") && !/\.test\.tsx$/.test(d.name)) out.push(path);
    }
    return out;
  }

  /** Each anchor written in the client's components, with every place it is written. */
  function written(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const path of sources(client)) {
      for (const id of literals(readFileSync(path, "utf8"))) out.set(id, [...(out.get(id) ?? []), relative(client, path)]);
    }
    return out;
  }

  /** Room settings' anchors, made from the form's data rather than written (settings/form.ts). anchors.test.ts draws them. */
  function made(): Set<string> {
    const out = new Set<string>();
    for (const g of SETTING_GROUPS) {
      out.add(groupAnchor(g.heading));
      for (const f of g.fields) {
        out.add(settingAnchor(f.key));
        if (f.kind === "movers" || f.kind === "drawers") out.add(`${settingAnchor(f.key)}.chosen`);
      }
    }
    return out;
  }

  /** Every anchor the catalogs route to, the DM menu's twins and the fields' places included. */
  function routed(): Set<string> {
    const out = new Set<string>(VIEW_ANCHORS);
    for (const { entry } of ALL) for (const r of routesOf(entry)) if (r.anchor) out.add(r.anchor);
    for (const c of [EVERYONE, DM_CATALOG]) for (const f of c.fields) for (const p of [f.token, f.page]) if (p) out.add(p.anchor);
    return out;
  }

  test("the scan finds what it looks for", () => {
    assert.deepEqual(literals(`<Switch search="dm.screens.follow" />`), ["dm.screens.follow"]);
    assert.deepEqual(literals(`<ul data-search="dm.handouts.recent">`), ["dm.handouts.recent"]);
    assert.deepEqual(literals(`<Button search={props.fold ? "dm.link.show" : undefined}>`), ["dm.link.show"]);
    assert.deepEqual(literals(`{ key: "music", search: "menu.this-device.sounds.music" }`), ["menu.this-device.sounds.music"]);
    assert.deepEqual(literals(`<Switch search={settingAnchor(field.key)} /> <ImagePicker search={(q) => q} /> research="x" data-search-page="scene:1"`), []);
  });

  test("each anchor written is well formed, written once, and routed to", () => {
    const routes = routed();
    for (const [id, places] of written()) {
      assert.ok(isSearchId(id), `${id} in ${places.join(", ")}`);
      assert.equal(places.length, 1, `${id} is written in ${places.join(", ")}`);
      assert.ok(routes.has(id), `${id} (${places[0]}) is drawn but no entry or twin routes to it`);
    }
  });

  test("each anchor routed to is written or made, but the playlist page's Play, which lane S2b places", () => {
    const drawn = new Set([...written().keys(), ...made()]);
    const missing = [...routed()].filter((id) => !drawn.has(id));
    assert.deepEqual(missing, [...VIEW_ANCHORS]);
  });
});

describe("what an entry offers and says now (search.md 5.2)", () => {
  const offered = (catalog: Catalog, ctx: SearchContext) => new Set(catalog.entries.filter((e) => !e.when || e.when(ctx)).map((e) => e.id));

  test("This device offers what this device draws: the Tab row on a wide screen, the volumes while Room sound is on, Full screen where the browser has it", () => {
    const pat = PAT_VIEW();
    assert.ok(offered(EVERYONE, ctxOf(pat, { wide: true })).has("setting:menu.this-device.tab-row.panels"));
    for (const id of ["section:menu.this-device.tab-row", "setting:menu.this-device.tab-row.panels"]) assert.ok(!offered(EVERYONE, ctxOf(pat, { wide: false })).has(id), id);
    try {
      setRoomSoundChoice("off");
      assert.ok(!offered(EVERYONE, ctxOf(pat)).has("setting:menu.this-device.sounds.music"));
      assert.ok(offered(EVERYONE, ctxOf(pat)).has("setting:menu.this-device.sounds.room"));
      setRoomSoundChoice(null);
      assert.ok(offered(EVERYONE, ctxOf(DM_VIEW())).has("setting:menu.this-device.sounds.effects"), "a DM's device plays the room's sound until told not to");
      assert.ok(!offered(EVERYONE, ctxOf(pat)).has("setting:menu.this-device.sounds.effects"), "a player's waits to be asked");
      setRoomSoundChoice("on");
      assert.ok(offered(EVERYONE, ctxOf(pat)).has("setting:menu.this-device.sounds.loops"));
    } finally {
      setRoomSoundChoice(null);
    }
    // Node has no document, so no full screen, and the server's switch for animated maps is not known.
    for (const id of ["section:menu.this-device.screen", "setting:menu.this-device.screen.fullscreen", "setting:menu.this-device.map-detail.animated"]) assert.ok(!offered(EVERYONE, ctxOf(pat)).has(id), id);
  });

  test("Room settings' rows show each setting as the room has it", () => {
    const room = seededRoom();
    Object.assign(room.meta.settings, { pcHpVisibleToParty: true, monstersDieAtZero: false, critRule: "doubleDice", feetPerCell: 10, playersMoveAny: ["p1"], turnTimerSec: 60 });
    const ctx = ctxOf(viewOf(room, DM));
    const value = (id: string) => DM_CATALOG.entries.find((e) => e.id === id)?.valueNow?.(ctx);
    assert.equal(value("setting:menu.room-settings.players.pc-hp-visible-to-party"), "On");
    assert.equal(value("setting:menu.room-settings.combat.monsters-die-at-zero"), "Off");
    assert.equal(value("setting:menu.room-settings.combat.crit-rule"), "Double the dice rolled");
    assert.equal(value("setting:menu.room-settings.grid-and-distance.feet-per-cell"), "10 ft.");
    assert.equal(value("setting:menu.room-settings.players.players-move-any"), "Chosen players");
    assert.equal(value("setting:menu.room-settings.combat.turn-timer-sec"), "1 minute");
    assert.equal(value("setting:menu.room-settings.grid-and-distance.new-scenes"), "Squares");
    assert.equal(value("setting:menu.room-settings.name"), room.meta.name);
    const chosen = "setting:menu.room-settings.players.players-move-any.chosen";
    assert.ok(offered(DM_CATALOG, ctx).has(chosen), "the ticks while Chosen players is picked");
    room.meta.settings.playersMoveAny = "none";
    assert.ok(!offered(DM_CATALOG, ctxOf(viewOf(room, DM))).has(chosen));
    assert.ok(DM_CATALOG.entries.find((e) => e.id === "setting:menu.room-settings.grid-and-distance.feet-per-cell")?.names?.includes("Feet per square or hex"), "a room with hexes reads its own label");
  });

  test("Include sounds while the room holds sounds, Party sight on a scene with party vision", () => {
    const room = seededRoom();
    assert.ok(offered(DM_CATALOG, ctxOf(viewOf(room, DM))).has("setting:menu.room-settings.backup.sounds"));
    assert.ok(!offered(DM_CATALOG, ctxOf(viewOf(room, DM))).has("setting:dm.preview.party-sight"));
    room.sounds = {};
    room.scenes.s1 = { ...room.scenes.s1!, vision: { on: true } as never };
    assert.ok(!offered(DM_CATALOG, ctxOf(viewOf(room, DM))).has("setting:menu.room-settings.backup.sounds"));
    assert.ok(offered(DM_CATALOG, ctxOf(viewOf(room, DM))).has("setting:dm.preview.party-sight"));
  });
});
