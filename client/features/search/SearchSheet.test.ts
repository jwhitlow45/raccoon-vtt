import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ReactNode } from "react";
import { DM } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import type { SearchEntry } from "./entry.ts";
import { searchResults } from "./index.ts";
import { DM_VIEW, indexOf, PAT_VIEW, seededRoom, viewOf } from "./search.testutil.ts";

/*
 * The room search's sheet (designs/qol/search.md 5.2, 5.5, 5.6, 5.8 and
 * 6): what its list says in each state, the keys inside it, what a pick
 * does by kind, a menu item's row, and the ways in. Its pieces are drawn
 * to markup. The browser check and the stack's e2e drive the whole sheet.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const {
  conditionOp,
  itemLook,
  listGroups,
  loadRows,
  markedTitle,
  PanelsSearchField,
  pickStep,
  ResultRow,
  rowDetail,
  SearchButton,
  SEARCH_WORDS,
  SearchList,
  sheetKey,
  statusWords,
  stepActive,
  BAR_FIELD_PX,
} = await import("./SearchSheet.tsx");

const ROW = (entry: SearchEntry, at: number): ReactNode => createElement(ResultRow, { key: entry.id, id: `r${at}`, at, entry, title: entry.title, active: at === 0, words: [], onHover() {}, onPick() {} });

function list(results: ReturnType<typeof searchResults>, text: string, load = loadRows({ status: "ready", catalog: { entries: [], fields: [], panels: {} } }, { status: "in", tries: 0 }, results.t === "typed")): string {
  return renderToStaticMarkup(createElement(SearchList, { ids: "s", listId: "s-list", results, text, load, row: ROW, retry() {}, focusTo: () => null, reload: createElement("button", null, "Reload"), loadDelay: 0 }));
}

/** The rows' ids in the order the markup draws them. */
const drawnIds = (html: string) => [...html.matchAll(/data-search-row="([^"]+)"/g)].map((m) => m[1]);

describe("the list's states", () => {
  test("an empty field shows Recent, newest first, then Suggested without them, each a named group", () => {
    const index = indexOf(DM_VIEW());
    const results = searchResults(index, "", ["token:g2", "panel:dice"]);
    const html = list(results, "");
    assert.deepEqual(
      listGroups(results).map((g) => [g.label, g.from]),
      [
        ["Recent", 0],
        ["Suggested", 2],
      ],
    );
    assert.match(html, /role="group" aria-labelledby="s-recent"><div id="s-recent" role="presentation"[^>]*>Recent</);
    assert.match(html, /role="group" aria-labelledby="s-suggested"><div id="s-suggested" role="presentation"[^>]*>Suggested</);
    const ids = drawnIds(html);
    assert.deepEqual(ids.slice(0, 2), ["token:g2", "panel:dice"]);
    // The DM's catalog suggests Start a fight first outside a fight.
    assert.equal(ids[2], "action:tracker.new-fight");
    assert.ok(!html.includes("data-search-none"), "no No match on an empty field");
  });

  test("an empty field with no recent picks shows Suggested alone, and a player's suggests their own character", () => {
    const html = list(searchResults(indexOf(PAT_VIEW()), "", []), "");
    assert.ok(!html.includes(">Recent<"));
    assert.match(html, />Suggested</);
    assert.equal(drawnIds(html)[0], "character:bree");
  });

  test("typed, one ranked list with no headings, its first row highlighted", () => {
    const results = searchResults(indexOf(DM_VIEW()), "goblin", []);
    const html = list(results, "goblin");
    assert.equal(listGroups(results).length, 1);
    assert.ok(!html.includes('role="group"'), "one flat list, never groups by kind (D-261106-143)");
    assert.deepEqual(drawnIds(html).slice(0, 3), ["token:g1", "token:g2", "token:boss"]);
    assert.match(html, /aria-selected="true" data-search-at="0" data-search-row="token:g1"/);
  });

  test("no match says so in the same words for every role, with the typed words", () => {
    for (const view of [DM_VIEW(), PAT_VIEW()]) {
      const html = list(searchResults(indexOf(view), "  zzqx ", []), "  zzqx ");
      assert.match(html, /data-search-none=""[^>]*>No match for “zzqx”\.<\/p>/);
      assert.equal(drawnIds(html).length, 0);
    }
  });

  test("while the DM's results load, the list shows what it has and says so, and the monsters only once something is typed", () => {
    const loading = loadRows({ status: "loading" }, { status: "loading", tries: 0 }, false);
    assert.deepEqual(loading, { loading: [SEARCH_WORDS.loadingDm], failed: null });
    assert.deepEqual(loadRows({ status: "idle" }, { status: "loading", tries: 0 }, true).loading, [SEARCH_WORDS.loadingDm, SEARCH_WORDS.loadingMonsters]);
    assert.deepEqual(loadRows({ status: "none" }, { status: "none", tries: 0 }, true), { loading: [], failed: null }, "a player's search loads nothing");
    const html = list(searchResults(indexOf(DM_VIEW()), "", []), "", loading);
    assert.match(html, /data-search-loading=""><span role="status"[^>]*>.*Loading the DM&#x27;s results…/);
    assert.ok(drawnIds(html).length > 0, "the rest still lists");
  });

  test("a failed part says so with Try again, and with Reload once a try failed again at once", () => {
    const first = loadRows({ status: "failed", tries: 1 }, { status: "in", tries: 0 }, true);
    assert.deepEqual(first, { loading: [], failed: "retry" });
    assert.equal(loadRows({ status: "ready", catalog: { entries: [], fields: [], panels: {} } }, { status: "failed", tries: 1 }, false).failed, "retry", "the monsters too");
    assert.equal(loadRows({ status: "failed", tries: 2 }, { status: "in", tries: 0 }, false).failed, "reload");
    assert.equal(loadRows({ status: "ready", catalog: { entries: [], fields: [], panels: {} } }, { status: "failed", tries: 2 }, false).failed, "reload");
    const retry = list(searchResults(indexOf(DM_VIEW()), "", []), "", first);
    assert.match(retry, /data-search-failed="retry"[^>]*><div role="alert"[^>]*><span[^>]*>Some results could not load\.<\/span>.*Try again/);
    const reload = list(searchResults(indexOf(DM_VIEW()), "", []), "", { loading: [], failed: "reload" });
    assert.match(reload, /data-search-failed="reload"[^>]*>.*Some results could not load\..*Reload/);
    assert.ok(!reload.includes("Try again"));
  });

  test("the status says the count, never what is left out, and a row's own words at once", () => {
    assert.equal(statusWords(searchResults(indexOf(DM_VIEW()), "zzqx", []), null), "No match");
    assert.equal(statusWords({ t: "typed", rows: indexOf(DM_VIEW()).items.slice(0, 1).map((i) => i.entry) }, null), "1 result");
    assert.equal(statusWords({ t: "typed", rows: indexOf(DM_VIEW()).items.slice(0, 5).map((i) => i.entry) }, null), "5 results");
    assert.equal(statusWords(searchResults(indexOf(DM_VIEW()), "", []), null), "", "an empty field counts nothing");
    assert.equal(statusWords(searchResults(indexOf(DM_VIEW()), "x", []), "Moving players…"), "Moving players…");
  });
});

describe("a row (search.md 5.2)", () => {
  test("its second line is its kind, then where it lives or its description, with its value", () => {
    assert.equal(rowDetail({ kind: "setting", where: "Menu · Room settings · Combat" }), "Setting · Menu · Room settings · Combat");
    assert.equal(rowDetail({ kind: "field", where: "Bree", value: "Darkvision 60 ft." }), "Field · Bree: Darkvision 60 ft.");
    assert.equal(rowDetail({ kind: "setting", where: "Menu · Room settings · Players", value: "On" }), "Setting · Menu · Room settings · Players: On");
    assert.equal(rowDetail({ kind: "action", where: "DM menu · Players' screens", description: "Only on Crypt" }), "Action · Only on Crypt");
    assert.equal(rowDetail({ kind: "character", where: "" }), "Character");
  });

  test("each typed word's start is bold in the title, through accents and apostrophes", () => {
    assert.deepEqual(markedTitle("Goblin 1", ["gob"]), [
      { text: "Gob", bold: true },
      { text: "lin 1", bold: false },
    ]);
    assert.deepEqual(markedTitle("Long Rest for the party", ["rest", "lon"]), [
      { text: "Lon", bold: true },
      { text: "g ", bold: false },
      { text: "Rest", bold: true },
      { text: " for the party", bold: false },
    ]);
    assert.deepEqual(markedTitle("Bree's Senses", ["brees"]), [
      { text: "Bree's", bold: true },
      { text: " Senses", bold: false },
    ]);
    assert.deepEqual(markedTitle("Élan", ["el"]), [
      { text: "Él", bold: true },
      { text: "an", bold: false },
    ]);
    assert.deepEqual(markedTitle("(Goblinoid)", ["gob"]), [
      { text: "(", bold: false },
      { text: "Gob", bold: true },
      { text: "linoid)", bold: false },
    ]);
    assert.deepEqual(markedTitle("Ruler", ["zz"]), [{ text: "Ruler", bold: false }]);
    assert.deepEqual(
      markedTitle("Initiative", ["in", "init"]),
      [
        { text: "Init", bold: true },
        { text: "iative", bold: false },
      ],
      "the longest typed start that fits",
    );
  });

  test("it is an option with its icon, its mark after the title, the key that does the same, and a line under for a menu item", () => {
    const entry: SearchEntry = { id: "token:boss", kind: "token", title: "Goblin Boss", where: "Monster on Battle mat", icon: "token", mark: "Hidden", keys: "F", act: { t: "token", tokenId: "boss" } };
    const html = renderToStaticMarkup(createElement(ResultRow, { id: "r0", at: 0, entry, title: entry.title, active: false, words: ["goblin"], onHover() {}, onPick() {} }));
    assert.match(html, /^<div id="r0" role="option" aria-selected="false" data-search-at="0" data-search-row="token:boss" data-search-kind="token"/);
    assert.match(html, /<strong[^>]*>Goblin<\/strong><span> Boss<\/span><span[^>]*>Hidden<\/span>/);
    assert.match(html, />Token · Monster on Battle mat</);
    assert.match(html, /<kbd[^>]*>F<\/kbd>/);
    assert.match(html, /min-height:52px/, "a touch target");
    const warned = renderToStaticMarkup(createElement(ResultRow, { id: "r1", at: 1, entry, title: "Move anyway", under: { text: "Fog is off on Crypt.", tone: "warning" }, active: true, words: ["goblin"], onHover() {}, onPick() {} }));
    assert.match(warned, /aria-selected="true"/);
    assert.match(warned, /<span>Move anyway<\/span>/, "an asked item's confirm in its title's place");
    assert.match(warned, />Fog is off on Crypt\.</);
  });
});

describe("keys inside the search (search.md 5.6)", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, code = "") => ({ key: k, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  const opts = { composing: false, apple: false, inField: true };

  test("Up and Down move, Enter goes or does, Shift+Enter only goes, Escape closes", () => {
    assert.equal(sheetKey(key("ArrowDown"), opts), "down");
    assert.equal(sheetKey(key("ArrowUp"), opts), "up");
    assert.equal(sheetKey(key("Enter"), opts), "go");
    assert.equal(sheetKey(key("Enter", { shiftKey: true }), opts), "goOnly");
    assert.equal(sheetKey(key("Escape"), opts), "close");
  });

  test("the field keeps its own keys, and an input method's Enter is its own", () => {
    for (const k of ["Home", "End", "ArrowLeft", "ArrowRight", "a", " ", "Backspace", "Tab"]) assert.equal(sheetKey(key(k), opts), null, k);
    assert.equal(sheetKey(key("ArrowDown", { shiftKey: true }), opts), null, "Shift+Down selects in the field");
    assert.equal(sheetKey(key("ArrowUp", { altKey: true }), opts), null);
    assert.equal(sheetKey(key("Enter", { ctrlKey: true }), opts), null);
    assert.equal(sheetKey(key("Enter"), { ...opts, composing: true }), null);
    assert.equal(sheetKey(key("ArrowDown"), { ...opts, composing: true }), null);
  });

  test("the key that opened it closes it, but a Mac's Ctrl+K in the field deletes to the line's end there", () => {
    assert.equal(sheetKey(key("k", { ctrlKey: true }, "KeyK"), opts), "close");
    assert.equal(sheetKey(key("k", { metaKey: true }, "KeyK"), { ...opts, apple: true }), "close");
    assert.equal(sheetKey(key("k", { ctrlKey: true }, "KeyK"), { ...opts, apple: true }), null);
    assert.equal(sheetKey(key("k", { ctrlKey: true }, "KeyK"), { ...opts, apple: true, inField: false }), "close", "on its Close button");
    assert.equal(sheetKey(key("л", { ctrlKey: true }, "KeyK"), opts), "close", "by the key's place on a Cyrillic layout");
    assert.equal(sheetKey(key("k", { ctrlKey: true, shiftKey: true }, "KeyK"), opts), null);
    assert.equal(sheetKey(key("k"), opts), null, "a K is typing");
  });

  test("the highlight stops at the ends, and there is none with no rows", () => {
    assert.equal(stepActive(0, 3, "down"), 1);
    assert.equal(stepActive(2, 3, "down"), 2);
    assert.equal(stepActive(0, 3, "up"), 0);
    assert.equal(stepActive(2, 3, "up"), 1);
    assert.equal(stepActive(7, 3, "up"), 1, "a highlight past a list that shrank");
    assert.equal(stepActive(-1, 3, "down"), 1);
    assert.equal(stepActive(0, 0, "down"), -1);
  });
});

describe("what a pick does (search.md 5.5, D-261106-144)", () => {
  const route = { panel: "characters", anchor: "characters.party-long-rest", press: true };

  test("an action presses its control on Enter and only goes there on Shift+Enter", () => {
    assert.deepEqual(pickStep({ t: "open", route }, false), { t: "route", route });
    assert.deepEqual(pickStep({ t: "open", route }, true), { t: "route", route: { panel: "characters", anchor: "characters.party-long-rest" } });
    const setting = { panel: "menu", page: "settings", section: "combat", anchor: "menu.settings.combat.skip" };
    assert.deepEqual(pickStep({ t: "open", route: setting }, false), { t: "route", route: setting }, "a setting only goes, either way");
    assert.equal(pickStep({ t: "open", route: setting }, true).t, "route");
  });

  test("a menu item runs its own function, and Shift+Enter goes to its twin without pressing it", () => {
    const twin = { panel: "dm", section: "screens", anchor: "dm.screens.blackout", press: true };
    assert.deepEqual(pickStep({ t: "item", itemId: "blackout", twin }, false), { t: "item", itemId: "blackout" });
    assert.deepEqual(pickStep({ t: "item", itemId: "blackout", twin }, true), { t: "route", route: { panel: "dm", section: "screens", anchor: "dm.screens.blackout" } });
  });

  test("a token is selected and framed, or its panel opens, and a key, a character and a field act the same either way", () => {
    assert.deepEqual(pickStep({ t: "token", tokenId: "g1" }, false), { t: "token", tokenId: "g1" });
    assert.deepEqual(pickStep({ t: "token", tokenId: "g1" }, true), { t: "tokenPanel", tokenId: "g1" });
    for (const only of [false, true]) {
      assert.deepEqual(pickStep({ t: "key", shortcut: "tool:fog" }, only), { t: "key", shortcut: "tool:fog" });
      assert.deepEqual(pickStep({ t: "character", characterId: "bree" }, only), { t: "route", route: { panel: "characters", page: "character:bree" } });
      const field = { panel: "characters", page: "character:bree", section: "page.stats", anchor: "character.senses" };
      assert.deepEqual(pickStep({ t: "character", characterId: "bree", route: field }, only), { t: "route", route: field });
    }
  });

  test("a condition goes on or off the selection, or its Conditions open, and a dice formula rolls, or goes into the Dice field unrolled", () => {
    assert.deepEqual(pickStep({ t: "condition", condition: "prone", remove: true }, false), { t: "condition", condition: "prone", remove: true });
    assert.deepEqual(pickStep({ t: "condition", condition: "prone", remove: false }, true), { t: "route", route: { panel: "token", section: "combat" } });
    assert.deepEqual(pickStep({ t: "roll", formula: "2d6+3" }, false), { t: "roll", formula: "2d6+3" });
    assert.deepEqual(pickStep({ t: "roll", formula: "2d6+3" }, true), { t: "fill", formula: "2d6+3" });
  });

  test("a condition sends the token bar picker's op, read against the creature now, and never one that changes nothing", () => {
    const target = { tokenId: "g1" };
    const id = () => "e9";
    assert.deepEqual(conditionOp([], { condition: "prone", remove: false }, target, id), { t: "actor.effect.add", target, effect: { id: "e9", key: "prone" } });
    assert.deepEqual(conditionOp([], { condition: "exhaustion", remove: false }, target, id), { t: "actor.effect.add", target, effect: { id: "e9", key: "exhaustion", level: 1 } });
    assert.deepEqual(conditionOp([{ id: "e1", key: "prone" }], { condition: "prone", remove: true }, target, id), { t: "actor.effect.remove", target, effectId: "e1" });
    assert.equal(conditionOp([{ id: "e1", key: "prone" }], { condition: "prone", remove: false }, target, id), null, "already on");
    assert.equal(conditionOp([], { condition: "prone", remove: true }, target, id), null, "already off");
  });

  test("a menu item's row draws it as the menu does: asked, refused, waiting or off", () => {
    const item = { id: "movePlayers", busy: false, disabled: false };
    const asked = { id: "movePlayers", warning: "Fog is off on Crypt.", anyway: "Move anyway" };
    assert.equal(itemLook(undefined, asked, new Map()), null, "a row that is no menu item");
    assert.deepEqual(itemLook(item, null, new Map()), { inert: false });
    assert.deepEqual(itemLook(item, asked, new Map()), { title: "Move anyway", under: { text: "Fog is off on Crypt.", tone: "warning" }, inert: false });
    assert.deepEqual(itemLook(item, null, new Map([["movePlayers", "Players not moved: the scene was deleted."]])), { under: { text: "Players not moved: the scene was deleted.", tone: "danger" }, inert: false });
    const busy = { ...item, busy: true, under: { text: "Moving players…", tone: "busy" as const } };
    assert.deepEqual(itemLook(busy, asked, new Map([["movePlayers", "no"]])), { under: { text: "Moving players…", tone: "busy" }, inert: true }, "a second Enter is refused while it waits");
    assert.deepEqual(itemLook({ ...item, disabled: true }, null, new Map()), { inert: true }, "an item that is off is not pressed");
  });
});

describe("the ways in (search.md 5.1)", () => {
  const inRoom = (node: ReactNode) => renderToStaticMarkup(createElement(RoomScopeProvider, { scope: new RoomScope(), children: node }));

  test("the top bar's Search is a field-like button of a fixed width, or its 44 px magnifier, named Search", () => {
    const field = inRoom(createElement(SearchButton, { form: "field" }));
    assert.match(field, /^<button type="button" aria-label="Search" data-search-open="bar" data-search-form="field"/);
    assert.match(field, new RegExp(`(?<![-a-z])width:${BAR_FIELD_PX}px`), "fixed, so the give-way and not a squeeze makes it an icon");
    assert.match(field, /height:28px/, "its pill the chips' height");
    assert.match(field, />Search<\/span>/);
    assert.ok(!field.includes("<kbd"), "no key on a device that has shown no keyboard");
    const icon = inRoom(createElement(SearchButton, { form: "icon" }));
    assert.match(icon, /data-search-form="icon"/);
    assert.match(icon, /width:44px;height:44px/);
    assert.match(icon, /d="m21 21-4\.34-4\.34"/);
  });

  test("the Panels list's field says what it finds, 44 px tall with 16 px words", () => {
    const html = inRoom(createElement(PanelsSearchField, { onOpen() {} }));
    assert.match(html, /^<button type="button" data-search-open="panels"/);
    assert.match(html, /height:44px/);
    assert.match(html, /font-size:16px/);
    assert.match(html, />Search panels, settings and the room<\/span>/);
  });

  test("the field's words name what each role may find", () => {
    assert.equal(SEARCH_WORDS.placeholder("dm"), "Search panels, settings, actions, tokens…");
    assert.equal(SEARCH_WORDS.placeholder("player"), "Search panels, settings, your character…");
    assert.equal(SEARCH_WORDS.keycap(true), "⌘K");
    assert.equal(SEARCH_WORDS.keycap(false), "Ctrl K");
  });
});

describe("the index the sheet lists", () => {
  test("a DM's on another scene still lists the scene's tokens by the view, for the same rows the sheet draws", () => {
    const html = list(searchResults(indexOf(viewOf(seededRoom(), DM, { sceneId: "s2" })), "goblin scout", []), "goblin scout");
    assert.equal(drawnIds(html)[0], "token:far");
  });
});
