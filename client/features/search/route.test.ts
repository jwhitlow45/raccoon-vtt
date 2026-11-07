import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { dmPanelFoldsSlot, scenesFoldsSlot, soundFoldsSlot, thisDeviceFoldsSlot, type FoldRoom } from "../../lib/folds.ts";
import { theme } from "../../lib/theme.ts";
import { RoomScope } from "../../state/scope.ts";
import type { PanelHow } from "../../state/types.ts";
import { diceFoldsSlot } from "../dice/diceFolds.ts";
import { journalSlot } from "../journal/store.ts";
import { soundAskSlot, soundViewSlot } from "../sound/music/open.ts";
import { characterPageSlot } from "../tokens/characterPage.ts";
import { createPanelFolds, panelFoldsSlot } from "../tokens/panelFolds.ts";
import { SEARCH_OFF_ATTR as OFF_ATTR, type SearchRoute } from "./entry.ts";
import { recordPage as indexPage } from "./index.ts";
import {
  focusTarget,
  landing,
  landOn,
  MENU_PAGES,
  monsterPageKey,
  NOW_PLAYING,
  openAt,
  pageAfter,
  pressable,
  recordId,
  recordPage,
  routeFolds,
  routeSlot,
  takeRequest,
  type RouteRequest,
  type RouteView,
} from "./route.ts";

/* A device's storage that records each write, so "never written" is seen. */
let writes: string[] = [];
beforeEach(() => {
  writes = [];
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      items.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

const ROOM: FoldRoom = { clock: false, scenes: true };
const PHONE = { width: 390, height: 844 };

/** A Room page's scope with Room's part of the route lent, offering `panels`, and the opens it was asked for. */
function room(panels: readonly string[] = ["token", "tracker", "dice", "scenes", "sound", "characters", "journal", "dm", "menu", "monsters", "library"]) {
  const scope = new RoomScope();
  const asks: RouteRequest[] = [];
  const opens: { id: string; how?: PanelHow }[] = [];
  scope.get(routeSlot).room = { offers: (id) => panels.includes(id), ask: (request) => asks.push(request) };
  const ui = { openPanel: (id: string, how?: PanelHow) => opens.push(how ? { id, how } : { id }) };
  return { scope, ui, asks, opens, go: (route: SearchRoute, how?: PanelHow) => openAt(scope, ui, route, how) };
}

describe("openAt opens a panel at its page (design-v1-qol.md 5, The route)", () => {
  test("a panel opens, and its request is published and asked of Room with the next seq", () => {
    const r = room();
    assert.equal(r.go({ panel: "tracker" }), true);
    assert.deepEqual(r.opens, [{ id: "tracker" }]);
    const published = r.scope.get(routeSlot).store.getState().request;
    assert.deepEqual(published, { panel: "tracker", seq: 1 });
    assert.deepEqual(r.asks, [published]);
  });

  test("a press inside a panel places the one it opens as ui.openPanel takes it", () => {
    const r = room();
    r.go({ panel: "dice" }, { from: "tracker" });
    assert.deepEqual(r.opens, [{ id: "dice", how: { from: "tracker" } }]);
  });

  test("an old panel id opens the panel that took its place", () => {
    const r = room();
    r.go({ panel: "ambiance" });
    assert.deepEqual(r.opens, [{ id: "sound" }]);
    assert.equal(r.scope.get(routeSlot).store.getState().request?.panel, "sound");
  });

  test("a character's page opens from outside, and a control on the list goes back to the list", () => {
    const r = room();
    const pages = r.scope.get(characterPageSlot);
    r.go({ panel: "characters", page: recordPage("character", "bree"), section: "page.stats", anchor: "characters.page.senses" });
    assert.equal(pages.getState().characterId, "bree");
    assert.equal(pages.getState().opened, 1, "an outside open, which a form in the panel leaves for");
    r.go({ panel: "characters", anchor: "characters.party.long-rest", press: true });
    assert.equal(pages.getState().characterId, null);
    assert.equal(pages.getState().opened, 2);
    r.go({ panel: "characters" });
    assert.deepEqual([pages.getState().characterId, pages.getState().opened], [null, 2], "the panel alone keeps its page");
  });

  test("a journal page opens by id, and the list for a control on it", () => {
    const r = room();
    const journal = r.scope.get(journalSlot);
    r.go({ panel: "journal", page: recordPage("page", "j1") });
    assert.equal(journal.getState().pageId, "j1");
    r.go({ panel: "journal" });
    assert.equal(journal.getState().pageId, "j1", "the panel alone keeps its page");
    r.go({ panel: "journal", anchor: "journal.new" });
    assert.equal(journal.getState().pageId, null);
  });

  test("Sound's two views take the route: Now playing through Open Sound's own way in, Library for a playlist or a track", () => {
    const r = room();
    const view = r.scope.get(soundViewSlot);
    const ask = r.scope.get(soundAskSlot);
    view.setState({ view: "library", query: "rain" });
    assert.equal(r.go(NOW_PLAYING), true);
    assert.equal(view.getState().view, "now");
    assert.equal(ask.getState().seq, 1, "Sound leaves a subpage and shows its top");
    assert.deepEqual(r.opens, [{ id: "sound" }]);
    for (const page of ["library", recordPage("playlist", "p1"), recordPage("track", "t1")]) {
      view.setState({ view: "now" });
      r.go({ panel: "sound", page });
      assert.equal(view.getState().view, "library", page);
    }
    assert.equal(view.getState().query, "rain", "Library keeps its search");
  });

  test("Menu's page is the panel's to turn: published for it, with Room settings a DM's alone", () => {
    const r = room();
    r.go({ panel: "menu", page: "device", section: "theme", anchor: "menu.device.theme" });
    assert.deepEqual(takeRequest(r.scope.get(routeSlot), "menu"), { panel: "menu", page: "device", section: "theme", anchor: "menu.device.theme", seq: 1 });
    assert.equal(pageAfter({ page: "device" }, MENU_PAGES, null), "device");
    assert.equal(pageAfter({ page: "settings" }, MENU_PAGES, "members"), "settings");
    const player = MENU_PAGES.filter((p) => p !== "settings");
    assert.equal(pageAfter({ page: "settings" }, player, "members"), "members", "a player's Menu has no Room settings");
    assert.equal(pageAfter({ page: "nowhere" }, MENU_PAGES, null), null);
    assert.equal(pageAfter({ anchor: "menu.xcard" }, MENU_PAGES, "about"), null, "a control on the first page goes back to it");
    assert.equal(pageAfter({}, MENU_PAGES, "about"), "about", "the panel alone keeps its page");
  });

  test("a request for a panel the viewer may not open does nothing: no panel, no fold, no page, no ask", () => {
    const r = room(["token", "tracker", "dice", "characters", "menu"]);
    const pages = r.scope.get(characterPageSlot);
    const before = pages.getState();
    for (const route of [
      { panel: "dm", section: "check", anchor: "dm.check.view-as" },
      { panel: "scenes", page: recordPage("scene", "s1"), section: "walls" },
      { panel: "monsters", page: recordPage("srd", "goblin") },
      { panel: "nowhere" },
    ]) {
      assert.equal(r.go(route), false, route.panel);
    }
    assert.deepEqual([r.opens, r.asks], [[], []]);
    assert.equal(r.scope.get(routeSlot).store.getState().request, null);
    assert.equal(r.scope.get(dmPanelFoldsSlot).get(390, ROOM).check, false, "the DM panel's fold stays as it was");
    assert.equal(r.scope.get(scenesFoldsSlot).get(390, ROOM).walls, false);
    assert.equal(pages.getState(), before);
  });

  test("with no Room to land it, nothing opens", () => {
    const scope = new RoomScope();
    const opens: string[] = [];
    assert.equal(openAt(scope, { openPanel: (id) => opens.push(id) }, { panel: "tracker" }), false);
    assert.deepEqual(opens, []);
  });
});

describe("a section in a closed fold opens for now, never written (design-v1-qol.md 5, The route)", () => {
  test("lib/folds.ts's surfaces: the DM panel, Scenes, Sound and This device in Menu", () => {
    const r = room();
    const dm = r.scope.get(dmPanelFoldsSlot);
    const scenes = r.scope.get(scenesFoldsSlot);
    const sound = r.scope.get(soundFoldsSlot);
    const device = r.scope.get(thisDeviceFoldsSlot);
    assert.deepEqual([dm.get(390, ROOM).check, scenes.get(390, ROOM).walls, sound.get(390, ROOM).upnext, device.get(390, ROOM).theme], [false, false, false, false], "each starts folded on a phone");
    r.go({ panel: "dm", section: "check", anchor: "dm.check.view-as" });
    r.go({ panel: "scenes", section: "walls", anchor: "scenes.walls.movement" });
    r.go({ panel: "sound", page: "now", section: "upnext", anchor: "sound.upnext.shuffle" });
    r.go({ panel: "menu", page: "device", section: "theme", anchor: "menu.device.theme" });
    assert.deepEqual([dm.get(390, ROOM).check, scenes.get(390, ROOM).walls, sound.get(390, ROOM).upnext, device.get(390, ROOM).theme], [true, true, true, true]);
    assert.deepEqual(writes, []);
    dm.follow(true, ROOM);
    dm.follow(false, ROOM);
    assert.equal(dm.get(390, ROOM).check, false, "folded again once its panel closes");
  });

  test("the token panel's folds, the viewer's own and another creature's alike, and a character's page's", () => {
    const r = room();
    const folds = r.scope.get(panelFoldsSlot);
    const shut = folds.get(PHONE);
    assert.deepEqual([shut.stats, shut.statBlock, shut["other.statBlock"], shut["page.stats"]], [false, false, false, false]);
    r.go({ panel: "token", section: "stats", anchor: "token.stats.speed" });
    r.go({ panel: "token", section: "statBlock", anchor: "token.stat-block" });
    r.go({ panel: "characters", page: recordPage("character", "bree"), section: "page.stats", anchor: "characters.page.senses" });
    const open = folds.get(PHONE);
    assert.deepEqual([open.stats, open.statBlock, open["other.statBlock"], open["page.stats"]], [true, true, true, true]);
    assert.equal(open.settings, false, "only what a route named");
    assert.deepEqual(writes, []);
  });

  test("the Dice panel's folds: a creature's group for each kind the panel may show, and Recent rolls, for now", () => {
    const r = room();
    const folds = r.scope.get(diceFoldsSlot);
    const shut = folds.get(PHONE);
    assert.deepEqual([shut["pc.saves"], shut["monster.saves"], shut["pc.skills"]], [false, false, false]);
    r.go({ panel: "dice", section: "saves", anchor: "dice.saves" });
    const open = folds.get(PHONE);
    assert.deepEqual([open["pc.saves"], open["companion.saves"], open["monster.saves"]], [true, true, true]);
    assert.equal(open["pc.skills"], false, "only what a route named");
    assert.deepEqual(writes, []);
    folds.endReveals();
    assert.equal(folds.get(PHONE)["pc.saves"], false, "folded again once the panel closes");
  });

  test("a section its panel does not fold there is left alone", () => {
    const r = room();
    r.go({ panel: "dm", section: "walls" });
    r.go({ panel: "menu", page: "settings", section: "theme" });
    r.go({ panel: "characters", section: "page.stats" });
    r.go({ panel: "token", section: "page.stats" });
    assert.equal(r.scope.get(dmPanelFoldsSlot).get(390, ROOM).check, false);
    assert.equal(r.scope.get(thisDeviceFoldsSlot).get(390, ROOM).theme, false, "This device's folds are its page's alone");
    assert.equal(r.scope.get(panelFoldsSlot).get(PHONE)["page.stats"], false, "a character's page's folds need its page");
  });

  test("routeFolds names each surface's sections, for the catalog's test", () => {
    assert.ok(routeFolds("dm").includes("screens"));
    assert.ok(routeFolds("scenes").includes("light"));
    assert.deepEqual(routeFolds("sound"), ["upnext"]);
    assert.ok(routeFolds("menu", "device").includes("rolls"));
    assert.deepEqual(routeFolds("menu"), []);
    assert.deepEqual(routeFolds("token").filter((k) => k.startsWith("other.") || k.startsWith("page.")), []);
    assert.ok(routeFolds("token").includes("statBlock"));
    assert.deepEqual(routeFolds("characters"), []);
    assert.ok(routeFolds("characters", recordPage("character", "c")).includes("page.combat"));
    assert.deepEqual(routeFolds("tracker"), []);
    assert.deepEqual(routeFolds("dice"), ["saves", "skills", "recent"]);
  });
});

describe("the token panel's and a character's page's fold store keeps reveals apart from taps", () => {
  test("a reveal shows open, a tap ends it as the viewer's own choice, and endReveals folds the rest", () => {
    const folds = createPanelFolds(localStorage);
    const before = folds.get(PHONE);
    folds.reveal("stats");
    folds.reveal("settings");
    const open = folds.get(PHONE);
    assert.deepEqual([open.stats, open.settings], [true, true]);
    assert.equal(folds.get(PHONE), open, "the same answer while nothing changes, as useSyncExternalStore needs");
    folds.tap("stats", false, true);
    assert.equal(folds.get(PHONE).stats, false, "the tap folds it and ends its reveal");
    assert.deepEqual(writes, ["rvtt.tokenPanelFolds"], "only the tap is written");
    folds.endReveals();
    assert.equal(folds.get(PHONE).settings, false);
    assert.deepEqual(folds.get(PHONE), before);
  });

  test("listeners hear a reveal and its end, and nothing for a reveal already shown", () => {
    const folds = createPanelFolds(null);
    let heard = 0;
    folds.subscribe(() => heard++);
    folds.reveal("owners");
    folds.reveal("owners");
    folds.endReveals();
    folds.endReveals();
    assert.equal(heard, 2);
  });
});

describe("one request at a time, by seq", () => {
  test("a second request replaces the first: a panel takes only the newest, once", () => {
    const r = room();
    const slot = r.scope.get(routeSlot);
    r.go({ panel: "menu", page: "settings" });
    r.go({ panel: "menu", page: "device" });
    assert.deepEqual(r.asks.map((a) => a.seq), [1, 2]);
    assert.deepEqual(takeRequest(slot, "menu"), { panel: "menu", page: "device", seq: 2 });
    assert.equal(takeRequest(slot, "menu"), null, "taken once, so a remount never turns the page again");
  });

  test("the same route asked again acts again", () => {
    const r = room();
    const slot = r.scope.get(routeSlot);
    r.go({ panel: "menu", page: "device" });
    assert.equal(takeRequest(slot, "menu")?.seq, 1);
    r.go({ panel: "menu", page: "device" });
    assert.equal(takeRequest(slot, "menu")?.seq, 2);
  });

  test("a request for another panel is not this one's, and a panel that mounts later still takes its own", () => {
    const r = room();
    const slot = r.scope.get(routeSlot);
    r.go({ panel: "scenes", page: recordPage("scene", "s1") });
    assert.equal(takeRequest(slot, "menu"), null);
    assert.equal(takeRequest(slot, "scenes")?.page, "scene:s1");
    r.go({ panel: "menu", page: "about" });
    assert.equal(takeRequest(slot, "scenes"), null, "replaced by the Menu's");
  });
});

describe("record pages", () => {
  test("the route reads the pages the index writes", () => {
    for (const kind of ["scene", "srd", "monster", "playlist", "track", "page", "handout", "doc", "character"] as const) {
      assert.equal(recordPage(kind, "a:b"), indexPage(kind, "a:b"));
      assert.equal(recordId(kind, indexPage(kind, "a:b")), "a:b", "an id may hold a colon");
    }
    assert.equal(recordId("scene", "page:x"), null);
    assert.equal(recordId("scene", "scene:"), null);
    assert.equal(recordId("scene", undefined), null);
  });
});

/* Fake elements and boxes: what the landing reads of the DOM. */

type Fake = HTMLElement & { focused: number; clicked: number; rung: number };

function fake(opts: { self?: boolean; disabled?: boolean; ariaDisabled?: boolean; inside?: Record<string, Fake>; attrs?: Record<string, string>; in?: Scroller; top?: number } = {}): Fake {
  const el = {
    focused: 0,
    clicked: 0,
    rung: 0,
    parentElement: opts.in ?? null,
    getBoundingClientRect: () => ({ top: opts.top ?? 0, bottom: (opts.top ?? 0) + 44 }),
    matches: (selector: string) => (selector === ":disabled" ? opts.disabled === true : opts.self === true),
    querySelector: (selector: string) => opts.inside?.[selector] ?? null,
    getAttribute: (name: string) => (name === "aria-disabled" && opts.ariaDisabled ? "true" : (opts.attrs?.[name] ?? null)),
    dispatchEvent: () => true,
    animate() {
      el.rung++;
    },
    // A disabled control refuses focus, as the browser's does.
    focus() {
      if (opts.disabled !== true) el.focused++;
    },
    click() {
      el.clicked++;
    },
  };
  return el as unknown as Fake;
}

/** A panel's body that scrolls, 400 px tall over 2,000 px, at the screen's top, its scroll tops kept. */
type Scroller = { scrolled: number[] };

function scroller(): Scroller {
  const box = {
    scrolled: [] as number[],
    parentElement: null,
    scrollTop: 0,
    scrollHeight: 2_000,
    clientHeight: 400,
    offsetHeight: 400,
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    scrollTo(to: { top: number }) {
      box.scrolled.push(to.top);
    },
  };
  return box;
}

function box(marks: Record<string, Fake>): RouteView["container"] {
  return { querySelector: (selector: string) => marks[selector] ?? null } as RouteView["container"];
}

const anchor = (id: string) => `[data-search="${id}"]`;

/** What inside an anchor takes its focus (route.ts focusTarget). */
const INNER = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

describe("where a route lands (Room's focus kind anchor)", () => {
  const control = fake({ self: true });

  test("nothing until the panel draws on screen", () => {
    assert.deepEqual(landing({ panel: "tracker", anchor: "tracker.auto" }, { container: null, subpage: null }), { t: "wait" });
  });

  test("an anchor lands once it is drawn, and waits while it is not", () => {
    assert.deepEqual(landing({ panel: "dm", anchor: "dm.screens.blackout" }, { container: box({}), subpage: null }), { t: "wait" });
    assert.deepEqual(landing({ panel: "dm", anchor: "dm.screens.blackout" }, { container: box({ [anchor("dm.screens.blackout")]: control }), subpage: null }), { t: "land", el: control });
  });

  test("a page comes first: its subpage's header must name it, so the subpage's own focus never takes the landing back", () => {
    const drawn = box({ [anchor("menu.device.theme")]: control });
    const route = { panel: "menu", page: "device", anchor: "menu.device.theme" };
    assert.deepEqual(landing(route, { container: drawn, subpage: null }), { t: "wait" });
    assert.deepEqual(landing(route, { container: drawn, subpage: "settings" }), { t: "wait" });
    assert.deepEqual(landing(route, { container: drawn, subpage: "device" }), { t: "land", el: control });
    const page = recordPage("character", "bree");
    assert.deepEqual(landing({ panel: "characters", page, anchor: "characters.page.senses" }, { container: box({ [anchor("characters.page.senses")]: control }), subpage: page }), { t: "land", el: control });
  });

  test("a control on a paged panel's first page waits for the panel to leave its subpage", () => {
    const drawn = box({ [anchor("characters.party.long-rest")]: control });
    const route = { panel: "characters", anchor: "characters.party.long-rest" };
    assert.deepEqual(landing(route, { container: drawn, subpage: "character:bree" }), { t: "wait" });
    assert.deepEqual(landing(route, { container: drawn, subpage: null }), { t: "land", el: control });
  });

  test("a page alone lands on the panel, whose own focus goes to the page's title", () => {
    assert.deepEqual(landing({ panel: "menu", page: "settings" }, { container: box({}), subpage: "settings" }), { t: "panel" });
    assert.deepEqual(landing({ panel: "tracker" }, { container: box({}), subpage: null }), { t: "panel" });
  });

  test("a scene's page is its row in Scenes, on the panel's first page", () => {
    const row = fake();
    const page = recordPage("scene", "cave");
    const mark = `[data-search-page="${page}"]`;
    assert.deepEqual(landing({ panel: "scenes", page }, { container: box({}), subpage: null }), { t: "wait" });
    assert.deepEqual(landing({ panel: "scenes", page }, { container: box({ [mark]: row }), subpage: "Rename" }), { t: "wait" });
    assert.deepEqual(landing({ panel: "scenes", page }, { container: box({ [mark]: row }), subpage: null }), { t: "land", el: row });
    assert.deepEqual(landing({ panel: "scenes", page, anchor: "scenes.light.level" }, { container: box({ [mark]: row, [anchor("scenes.light.level")]: control }), subpage: null }), { t: "land", el: control });
  });

  test("Sound's view must show before its control lands, on Sound's first page", () => {
    const view = fake();
    const route = { panel: "sound", page: "now", anchor: "sound.now.volume" };
    const drawn = { [anchor("sound.now.volume")]: control };
    assert.deepEqual(landing(route, { container: box(drawn), subpage: null }), { t: "wait" });
    assert.deepEqual(landing(route, { container: box({ ...drawn, '[data-sound-view="now"]': view }), subpage: "Tavern" }), { t: "wait" });
    assert.deepEqual(landing(route, { container: box({ ...drawn, '[data-sound-view="now"]': view }), subpage: null }), { t: "land", el: control });
    assert.deepEqual(landing(NOW_PLAYING, { container: box({ '[data-sound-view="now"]': view }), subpage: null }), { t: "panel" });
  });

  test("a page the route does not turn is the panel's to show, and never holds the landing", () => {
    assert.deepEqual(landing({ panel: "dm", section: "handouts", page: recordPage("handout", "h1") } as SearchRoute, { container: box({}), subpage: null }), { t: "panel" });
    assert.deepEqual(landing({ panel: "dm", section: "handouts", page: recordPage("doc", "d1") } as SearchRoute, { container: box({}), subpage: null }), { t: "panel" });
  });

  test("a monster's card is its subpage: the landing waits for it, an SRD monster's by its own id and the room's by its list's", () => {
    const place = fake({ self: true });
    const drawn = box({ [anchor("monsters.card.place")]: place });
    const srd = { panel: "monsters", page: recordPage("srd", "goblin"), anchor: "monsters.card.place" };
    assert.deepEqual(landing(srd, { container: drawn, subpage: null }), { t: "wait" });
    assert.deepEqual(landing(srd, { container: drawn, subpage: "room:goblin" }), { t: "wait" });
    assert.deepEqual(landing(srd, { container: drawn, subpage: "srd:goblin" }), { t: "land", el: place });
    const own = { panel: "monsters", page: recordPage("monster", "m1"), anchor: "monsters.card.place" };
    assert.deepEqual(landing(own, { container: drawn, subpage: "monster:m1" }), { t: "wait" });
    assert.deepEqual(landing(own, { container: drawn, subpage: "room:m1" }), { t: "land", el: place });
    assert.deepEqual(landing({ panel: "monsters", page: recordPage("srd", "goblin") }, { container: box({}), subpage: "srd:goblin" }), { t: "panel" });
    assert.deepEqual([monsterPageKey("srd:goblin"), monsterPageKey("monster:m1"), monsterPageKey("scene:s1"), monsterPageKey(undefined)], ["srd:goblin", "room:m1", null, null]);
  });
});

describe("the landing: focus, ring and press (design-v1-qol.md 5, The route)", () => {
  test("a control takes focus, and a route that presses presses it once", () => {
    const button = fake({ self: true });
    assert.equal(landOn(button, false), button);
    assert.deepEqual([button.focused, button.clicked], [1, 0], "a setting is focused, never changed");
    landOn(button, true);
    assert.deepEqual([button.focused, button.clicked], [2, 1]);
  });

  test("an action whose control is off is not pressed, and one marked off takes focus", () => {
    for (const off of [fake({ self: true, disabled: true }), fake({ self: true, ariaDisabled: true })]) {
      assert.equal(pressable(off), false);
      landOn(off, true);
      assert.equal(off.clicked, 0);
    }
    const marked = fake({ self: true, ariaDisabled: true });
    assert.equal(landOn(marked, true), marked);
    assert.equal(marked.focused, 1);
  });

  test("a disabled control refuses focus, so it goes to the field the control names as why it is off, and the control wears the ring (se-10)", () => {
    const style = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "", overflowY: "auto" }) });
    try {
      const body = scroller();
      const input = fake({ self: true, in: body, top: 900 });
      const field = fake({ inside: { [INNER]: input }, in: body, top: 880 });
      const off = { [OFF_ATTR]: "menu.members.password.new" };
      const change = fake({ self: true, disabled: true, attrs: off, in: body, top: 1_000 });
      assert.equal(landOn(change, true, box({ [anchor("menu.members.password.new")]: field })), input, "New player password, empty, is why Change the password is off");
      assert.deepEqual([input.focused, change.clicked, change.rung, field.rung], [1, 0, 1, 0]);
      assert.deepEqual(body.scrolled, [880 - theme.space(3)], "the field, its label included, comes near the top, with the control under it");

      // Naming none, or a field not drawn or off itself, nothing on the route takes focus, and Room focuses the panel (D-261106-311).
      const bare = fake({ self: true, disabled: true });
      assert.equal(landOn(bare, true, box({})), null);
      assert.equal(bare.rung, 1, "still ringed");
      assert.equal(landOn(fake({ self: true, disabled: true, attrs: off }), true, box({})), null, "the field is not drawn");
      assert.equal(landOn(fake({ self: true, disabled: true, attrs: off }), true, null), null, "no box");
      const shut = fake({ self: true, disabled: true });
      assert.equal(landOn(fake({ self: true, disabled: true, attrs: off }), true, box({ [anchor("menu.members.password.new")]: shut })), null, "the field is off too");
      assert.equal(shut.focused, 0);

      // A control that is on keeps its focus and its place, whatever it names.
      const on = fake({ self: true, attrs: off, in: body, top: 1_000 });
      body.scrolled.length = 0;
      assert.equal(landOn(on, false, box({ [anchor("menu.members.password.new")]: field })), on);
      assert.deepEqual([on.focused, input.focused], [1, 1]);
      assert.deepEqual(body.scrolled, [1_000 - theme.space(3)]);
    } finally {
      if (style) Object.defineProperty(globalThis, "getComputedStyle", style);
      else delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });

  test("a group's focus goes to its chosen option, else its first control, else the group itself", () => {
    const chosen = fake({ self: true });
    const first = fake({ self: true });
    assert.equal(focusTarget(fake({ inside: { "input:checked": chosen, 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])': first } })), chosen);
    assert.equal(focusTarget(fake({ inside: { 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])': first } })), first);
    const bare = fake();
    assert.equal(focusTarget(bare), bare);
    const header = fake({ self: true, inside: { "input:checked": chosen } });
    assert.equal(focusTarget(header), header, "a control is its own target");
  });

  test("a group's press goes to its first control", () => {
    const first = fake({ self: true });
    landOn(fake({ inside: { 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])': first } }), true);
    assert.deepEqual([first.focused, first.clicked], [1, 1]);
  });
});
