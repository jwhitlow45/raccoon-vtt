import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ClientOp } from "#shared/protocol.ts";
import { DM, entry, P1, scene } from "#shared/testutil.ts";
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
import { DM_VIEW, keysOf, PAT_VIEW, seededRoom, towerRoom, towerView, viewOf } from "./search.testutil.ts";

/*
 * The catalogs lanes S2a and S2b write (docs/design/design-v1-qol.md 5, What
 * keeps it current, its unit test): ids unique, every route's panel, page and
 * fold real, every entry a player may not reach in the DM's catalog, every
 * kind of DM menu item a row with a twin, and every anchor the catalogs route
 * to drawn by exactly one `search=` in client/**\/*.tsx, and the reverse.
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

// The DM menu's views that draw every kind of item between them (design-v1-qol.md 4, C1 and C2).
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

describe("the catalogs' entries (design-v1-qol.md 5, What keeps it current)", () => {
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
          else if (r.panel === "sound") assert.ok(r.page === "now" || r.page === "library", name);
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

describe("the DM menu's items (design-v1-qol.md 5, Acting and 6)", () => {
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

  test("each kind's twin is its panel control, the scene's row in Scenes for a move, Show a phase for a phase", () => {
    const twin = (kind: SearchedItemKind) => TWINS[kind](AT_PLAY);
    assert.deepEqual(twin("follow"), { panel: "dm", section: "screens", anchor: "dm.screens.follow" });
    assert.deepEqual(twin("endBlackout"), twin("blackout"));
    assert.deepEqual(twin("movePlayers"), { panel: "scenes", page: "scene:crypt" });
    assert.deepEqual(twin("showRecent"), { panel: "dm", section: "handouts", anchor: "dm.handouts.recent" });
    assert.deepEqual(twin("viewAs"), { panel: "dm", section: "check", anchor: "dm.preview.view-as" });
    assert.deepEqual(twin("phase"), { panel: "scenes", section: "map", anchor: "scenes.map.phases" }, "the scene in view's own Show a phase");
  });

  test("without the menu's own view the DM's index reads the room's, and a player's never draws an item", () => {
    const dm = buildIndex({ state: DM_VIEW(), wide: true, keys: keysOf(DM_VIEW()), catalogs: [EVERYONE, DM_CATALOG], monsters: null, soundFiles: true });
    const items = dm.items.filter((i) => i.entry.act.t === "item").map((i) => i.entry.id);
    assert.deepEqual(items.sort(), ["item:blackout", "item:bringEveryone", "item:follow", "item:showHandout", "item:viewAs:p1", "item:viewAs:p2"].sort());
    const fromMenu = buildIndex({ state: DM_VIEW(), wide: true, keys: keysOf(DM_VIEW()), catalogs: [EVERYONE, DM_CATALOG], monsters: null, soundFiles: true, dmMenu: { ...dmMenuViewOf(DM_VIEW()), recent: [{ ...toPat, to: "all" } as RecentHandout] } });
    assert.ok(fromMenu.byId.has("item:recent:doc:letter"), "this device's recent showing comes with the menu's view");
    const pat = buildIndex({ state: PAT_VIEW(), wide: true, keys: keysOf(PAT_VIEW()), catalogs: [EVERYONE, DM_CATALOG], monsters: null, soundFiles: true });
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

describe("the DM menu's items on a floor of the players' scene (design-v1-floors.md 7.3, 14)", () => {
  const room = towerRoom();
  // Reached once an unhidden party member stands there (openFloor), not before.
  const reached = () => {
    const r = towerRoom();
    r.tokens.tp = { ...r.tokens.g1!, id: "tp", name: "Thorn's friend", kind: "pc", ownerIds: ["p1"], sceneId: "upper" };
    return r;
  };
  const rowsOf = (state: typeof room) => {
    const view = towerView(state, DM, "upper", ["ground", "upper", "attic"]);
    const menu = dmMenuViewOf(view);
    return { menu, rows: new Map(dmMenuEntries(menu).map((r) => [r.id, r])), items: new Map(itemsOf(dmMenuSections(menu)).map((i) => [i.id, i])) };
  };

  test("not reached: Move players here names the floor, Bring everyone here is off with its line, in the menu and the search alike", () => {
    const { menu, rows, items } = rowsOf(room);
    assert.deepEqual([menu.playersHoldHere, menu.playersSceneHere, menu.playerScene?.name], [false, true, "Tower · Ground floor"]);
    assert.equal(rows.get("item:movePlayers")?.value, "on Tower · Upper floor");
    const line = "Players haven't reached Upper floor, so their maps stay.";
    assert.equal(rows.get("item:bringEveryone")?.description, line);
    assert.deepEqual([items.get("bringEveryone")?.disabled, items.get("bringEveryone")?.description], [true, line]);
    assert.equal(rows.get("item:follow")?.description, line);
  });

  test("reached: Bring everyone here is on with no line, and both builders hold the same two flags", () => {
    const { menu, rows, items } = rowsOf(reached());
    assert.deepEqual([menu.playersHoldHere, menu.playersSceneHere], [true, true]);
    assert.equal(items.get("bringEveryone")?.disabled, false);
    assert.equal(rows.get("item:bringEveryone")?.description, undefined);
  });

  test("a scene's twin is the row of its main floor", () => {
    const { menu } = rowsOf(room);
    assert.deepEqual(TWINS.movePlayers(menu), { panel: "scenes", page: "scene:ground" });
    assert.deepEqual(TWINS.showPlayers(menu), { panel: "scenes", page: "scene:ground" });
  });
});

describe("every anchor is drawn by exactly one search= in client/**/*.tsx, and the reverse (design-v1-qol.md 5, What keeps it current)", () => {
  const client = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  /** `search="id"`, `data-search="id"`, a literal inside `search={…}`, and a `search: "id"` an element's props or data hold. */
  const SEARCH = /(?<![\w-])(?:data-)?search=(?:"([^"]*)"|\{([^}\n]*)\})|(?<![\w-])search:\s*"([^"]*)"/g;

  /*
   * An attribute named search is always an anchor, whatever its value, so a
   * malformed one there fails the check below. A property named search is
   * one only when its value is dotted, as every anchor id is (entry.ts
   * SEARCH_ID: a panel part and a control part): `search` is a common key,
   * an icon's name in the icon map (`search: "search"`) or a row's typed
   * text (`search: ""`), and neither is an anchor. A dotted value is still
   * held to the id's form, and an undotted anchor meant for a control
   * leaves its entry's anchor unwritten, which the reverse check fails.
   */
  function literals(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(SEARCH)) {
      if (m[1] !== undefined) out.push(m[1]);
      if (m[3] !== undefined && m[3].includes(".")) out.push(m[3]);
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

  test("an icon's name or a row's typed text under a key named search is no anchor, and every anchor form is still read whole", () => {
    assert.deepEqual(literals(`  queue: "list-music",\n  search: "search",\n};`), []);
    assert.deepEqual(literals(`{ key: "token:1", search: "" }`), []);
    // A dotted value under the key is an anchor, held to the id's form, a malformed one included.
    assert.deepEqual(literals(`{ search: "menu.This_device" }`), ["menu.This_device"]);
    // An attribute is an anchor whatever its value, so an undotted or empty one fails the form check.
    assert.deepEqual(literals(`<Switch search="blackout" /> <b data-search="" /> <Button search={on ? "Dm.Show" : undefined}>`), ["blackout", "", "Dm.Show"]);
    for (const id of ["menu.This_device", "blackout", "", "Dm.Show"]) assert.ok(!isSearchId(id), id);
  });

  test("each anchor written is well formed, written once, and routed to", () => {
    const routes = routed();
    for (const [id, places] of written()) {
      assert.ok(isSearchId(id), `${id} in ${places.join(", ")}`);
      assert.equal(places.length, 1, `${id} is written in ${places.join(", ")}`);
      assert.ok(routes.has(id), `${id} (${places[0]}) is drawn but no entry or twin routes to it`);
    }
  });

  test("each field a control names as why it is off is an anchor written beside it, in the same file (route.ts landOn)", () => {
    const OFF = /(?<![\w-])(?:searchOff|data-search-off)="([^"]*)"/g;
    const anchors = written();
    const named: string[] = [];
    for (const path of sources(client)) {
      for (const m of readFileSync(path, "utf8").matchAll(OFF)) {
        named.push(m[1]!);
        assert.deepEqual(anchors.get(m[1]!), [relative(client, path)], `${m[1]} in ${relative(client, path)}`);
      }
    }
    assert.ok(named.includes("menu.members.password.new"), "Change the password names New player password (se-10)");
  });

  test("each anchor routed to is written or made, the index's own rows' included", () => {
    const drawn = new Set([...written().keys(), ...made()]);
    const missing = [...routed()].filter((id) => !drawn.has(id));
    assert.deepEqual(missing, []);
    for (const id of VIEW_ANCHORS) assert.ok(drawn.has(id), id);
  });
});

describe("what an entry offers and says now (design-v1-qol.md 5, The results)", () => {
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

describe("what the rest of the panels offer and say now (design-v1-qol.md 5, The results, S2b)", () => {
  const offered = (catalog: Catalog, ctx: SearchContext) => new Set(catalog.entries.filter((e) => !e.when || e.when(ctx)).map((e) => e.id));
  const fight = () => {
    const room = seededRoom();
    room.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "g1", value: 12 })] };
    return room;
  };

  test("Initiative offers New fight's rows outside a fight and its setup in one, Camera follows the turn always", () => {
    const resting = offered(DM_CATALOG, ctxOf(DM_VIEW()));
    const fighting = offered(DM_CATALOG, ctxOf(viewOf(fight(), DM)));
    for (const id of ["action:tracker.new-fight", "setting:tracker.new-fight.roll"]) assert.ok(resting.has(id) && !fighting.has(id), id);
    for (const id of ["section:tracker.auto", "action:tracker.initiative.values", "setting:tracker.initiative.scores", "section:tracker.more", "setting:tracker.timer", "action:tracker.end"]) assert.ok(fighting.has(id) && !resting.has(id), id);
    assert.ok(resting.has("setting:tracker.device.follow") && fighting.has("setting:tracker.device.follow"));
  });

  test("Time offers Start the clock with no clock, and a running clock's rows with one, Players see the date and time with its value", () => {
    const room = seededRoom();
    assert.ok(offered(DM_CATALOG, ctxOf(viewOf(room, DM))).has("action:time.start"));
    room.clock = { id: "c1", rev: 0, t: 0, shown: false, calendar: { kind: "days" } };
    const ctx = ctxOf(viewOf(room, DM));
    const now = offered(DM_CATALOG, ctx);
    assert.ok(!now.has("action:time.start"));
    for (const id of ["section:time.steps", "action:time.set", "setting:time.shown", "action:time.calendar", "action:time.stop"]) assert.ok(now.has(id), id);
    assert.equal(DM_CATALOG.entries.find((e) => e.id === "setting:time.shown")?.valueNow?.(ctx), "Off");
  });

  test("Scenes offers the scene in view's settings while one is in view, with its light now", () => {
    const room = seededRoom();
    const ctx = ctxOf(viewOf(room, DM));
    assert.ok(offered(DM_CATALOG, ctx).has("setting:scenes.light.level"));
    assert.equal(DM_CATALOG.entries.find((e) => e.id === "setting:scenes.light.level")?.valueNow?.(ctx), "Bright");
    room.scenes.s1 = { ...room.scenes.s1!, vision: { on: true, light: "dim" } as never };
    assert.equal(DM_CATALOG.entries.find((e) => e.id === "setting:scenes.light.level")?.valueNow?.(ctxOf(viewOf(room, DM))), "Dim");
    const none = { ...DM_VIEW(), sceneId: null } as RoomView;
    const empty = offered(DM_CATALOG, ctxOf(none));
    assert.ok(empty.has("action:scenes.new"), "New scene, with no scene in view too");
    assert.ok(!empty.has("setting:scenes.light.level") && !empty.has("section:scenes.map"));
  });

  test("Sound offers Now playing always, and what waits on sound files only once the server says it has them", () => {
    const now = offered(DM_CATALOG, ctxOf(DM_VIEW()));
    assert.ok(now.has("section:sound.now") && now.has("section:sound.effects"));
    // The server's switch is not known in a test, which is not "on".
    for (const id of ["section:sound.library", "section:sound.table", "section:sound.background", "action:sound.library.add", "action:sound.stop-all", "section:sound.upnext"]) assert.ok(!now.has(id), id);
  });

  test("Only DM devices play is offered whatever the server's switch, both of Sound's layouts drawing it, with its value now (docs/design/design-v1-sound-dm-only.md 4)", () => {
    const room = seededRoom();
    const off = ctxOf(viewOf(room, DM));
    assert.ok(offered(DM_CATALOG, off).has("setting:sound.table.dmonly"), "with the switch not known");
    const entry = DM_CATALOG.entries.find((e) => e.id === "setting:sound.table.dmonly");
    assert.equal(entry?.valueNow?.(off), "Off");
    room.meta.settings = { ...room.meta.settings, soundDmOnly: true };
    assert.equal(entry?.valueNow?.(ctxOf(viewOf(room, DM))), "On");
    for (const name of ["only play for me", "play on my speaker"]) assert.ok(entry?.names?.includes(name), name);
    assert.ok(!offered(EVERYONE, ctxOf(PAT_VIEW())).has("setting:sound.table.dmonly"), "the DM's alone");
  });

  test("the Dice panel's creature groups while it shows one creature: the DM's one selected token, a player's own", () => {
    const dice = (view: RoomView) => offered(EVERYONE, ctxOf(view)).has("section:dice.saves");
    assert.equal(dice(DM_VIEW()), false, "nothing selected");
    assert.equal(dice(viewOf(seededRoom(), DM, { selectedId: "g1" })), true);
    const two = viewOf(seededRoom(), DM, { selectedId: "g1" });
    assert.equal(dice({ ...two, local: { ...two.local, selectedIds: ["g1", "g2"] } } as RoomView), false, "several show the group's options");
    assert.equal(dice(PAT_VIEW()), true, "Pat plays Bree");
    const room = seededRoom();
    room.characters.bree = { ...room.characters.bree!, ownerIds: [] };
    assert.equal(dice(viewOf(room, P1)), false, "a player with no creature of theirs");
    room.tokens.g1 = { ...room.tokens.g1!, ownerIds: ["p1"] };
    assert.equal(dice(viewOf(room, P1)), true, "a token of theirs on the scene");
  });

  test("a creature's Conditions say which it has, by name, and its other fields their values", () => {
    const room = seededRoom();
    room.characters.bree = { ...room.characters.bree!, actor: { ...room.characters.bree!.actor, effects: [{ id: "x1", key: "prone" }, { id: "x2", key: "poisoned" }] } };
    const bree = viewOf(room, P1).view!.characters.bree!.actor;
    const value = (key: string) => EVERYONE.fields.find((f) => f.key === key)?.value?.(bree);
    assert.equal(value("conditions"), "Prone, Poisoned");
    assert.equal(value("hp"), "24 of 24");
    assert.equal(value("ac"), "15");
    assert.equal(value("senses"), "Darkvision 60 ft.");
    assert.equal(EVERYONE.fields.find((f) => f.key === "conditions")?.value?.(viewOf(seededRoom(), P1).view!.characters.bree!.actor), undefined, "none, no value");
  });
});
