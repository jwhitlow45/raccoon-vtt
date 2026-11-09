import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DM, effect, P1 } from "#shared/testutil.ts";
import { keysInEffect, type KeyMap } from "../../state/keyBindings.ts";
import { DEFAULT_KEYS, keyText, SHORTCUTS } from "../../state/shortcuts.ts";
import type { RoomView } from "../../state/types.ts";
import { PANELS, panelsFor } from "../panels.ts";
import { EVERYONE } from "./catalog/everyone.ts";
import type { Catalog } from "./catalog/types.ts";
import type { DmCatalogState } from "./dmCatalog.ts";
import { buildIndex, catalogsFor, diceRow, OPEN_HANDOUT_ANCHOR, PLACE_MONSTER_ANCHOR, PLAY_PLAYLIST_ANCHOR, PLAYLIST_ANCHOR, searchResults, TRACK_ANCHOR, VIEW_ANCHORS } from "./index.ts";
import { DM_VIEW, EVERYONE_FIXTURE, indexOf, keysOf, PAT_VIEW, rowsOf, seededRoom, towerRoom, towerView, viewOf } from "./search.testutil.ts";

const ids = (state: RoomView, options?: Parameters<typeof indexOf>[1]) => new Set(indexOf(state, options).items.map((i) => i.entry.id));
const entryOf = (state: RoomView, id: string) => indexOf(state).byId.get(id)?.entry;

describe("the panels and keys (design-v1-qol.md 5, What keeps it current)", () => {
  test("every panel a role is offered is in its index, and no other", () => {
    for (const [view, role] of [[DM_VIEW(), "dm"], [PAT_VIEW(), "player"]] as const) {
      for (const wide of [true, false]) {
        const found = ids(view, { wide });
        const offered = new Set(panelsFor(role, wide).map((p) => p.id));
        for (const p of PANELS) assert.equal(found.has(`panel:${p.id}`), offered.has(p.id), `${role} ${wide} ${p.id}`);
      }
    }
  });

  test("every key a role has is in its index while it applies, but the arrows and Page keys", () => {
    for (const view of [DM_VIEW(), PAT_VIEW()]) {
      const role = view.you!.role;
      const all = buildIndex({ state: view, wide: true, keys: { applies: () => true, text: () => "K" }, catalogs: [], monsters: null, soundFiles: true });
      const found = new Set(all.items.map((i) => i.entry.id));
      for (const s of SHORTCUTS) {
        const expected = s.roles.includes(role) && !s.navigation;
        assert.equal(found.has(`key:${s.id}`), expected, `${role} ${s.id}`);
      }
      const none = buildIndex({ state: view, wide: true, keys: { applies: () => false, text: () => "K" }, catalogs: [], monsters: null, soundFiles: true });
      assert.ok(!none.items.some((i) => i.entry.kind === "key"));
    }
  });

  test("the digits that start an HP change read Change HP, with this device's digits, and their press goes to the HP field", () => {
    const row = (keys: KeyMap) => buildIndex({ state: DM_VIEW(), wide: true, keys: { applies: (s) => s.id === "hpDigit", text: (id) => keyText(id, keys) }, catalogs: [], monsters: null, soundFiles: true }).byId.get("key:hpDigit")?.entry;
    const plain = row(DEFAULT_KEYS)!;
    assert.deepEqual([plain.title, plain.keys], ["Change HP", "1 to 9"]);
    assert.deepEqual(plain.act, { t: "key", shortcut: "hpDigit" });
    assert.equal(row(keysInEffect(DEFAULT_KEYS, { "tool:ruler": "1", "tool:fog": "3" }))?.keys, "2, 4 to 9", "a digit this device moved leaves the row");
    const every = keysInEffect(DEFAULT_KEYS, Object.fromEntries(["tool:select", "tool:ruler", "tool:area", "tool:draw", "tool:ping", "tool:fog", "tool:pin", "tool:trap", "tool:build"].map((id, i) => [id, String(i + 1)])));
    assert.equal(row(every)?.keys, "", "no digit left: no key, not No key");
  });

  test("a key's row carries its key as the sheet writes it, and a tool reads as the tool", () => {
    const fog = entryOf(DM_VIEW(), "key:tool:fog")!;
    assert.equal(fog.title, "Fog tool");
    assert.equal(fog.keys, "F");
    assert.deepEqual(fog.act, { t: "key", shortcut: "tool:fog" });
  });
});

describe("the room's things (design-v1-qol.md 5, What it finds)", () => {
  test("tokens on the scene in view only, a DM's hidden one marked, a hidden name found by its public one", () => {
    const dm = DM_VIEW();
    const found = ids(dm);
    for (const id of ["g1", "g2", "boss", "varo", "tbree", "tkel"]) assert.ok(found.has(`token:${id}`), id);
    assert.ok(!found.has("token:far"), "a token on another scene");
    // A view may hold a token of another scene a moment before the scene's switch lands, and the search reads the scene in view.
    const held = { ...dm, view: { ...dm.view!, tokens: { ...dm.view!.tokens, far: { ...dm.view!.tokens.g1!, id: "far", sceneId: "s2" } } } } as RoomView;
    assert.ok(!ids(held).has("token:far"));
    assert.equal(entryOf(dm, "token:boss")?.mark, "Hidden");
    assert.equal(entryOf(dm, "token:g1")?.mark, undefined);
    assert.equal(entryOf(dm, "token:varo")?.title, "Count Varo");
    assert.deepEqual(entryOf(dm, "token:varo")?.names, ["Hooded figure"]);
    const room = seededRoom();
    room.tokens.g1!.publicName = "Masked one";
    assert.equal(entryOf(viewOf(room, DM), "token:g1")?.names, undefined, "a public name counts only while the true one is hidden");
  });

  test("a player's tokens are their view's, by the name it carries, with no mark", () => {
    const pat = PAT_VIEW();
    const found = ids(pat);
    assert.ok(!found.has("token:boss"));
    assert.equal(entryOf(pat, "token:varo")?.title, "Hooded figure");
    assert.equal(entryOf(pat, "token:varo")?.names, undefined);
    assert.ok(indexOf(pat).items.every((i) => i.entry.mark === undefined));
  });

  test("a DM finds every character and its few play fields with their values", () => {
    const dm = DM_VIEW();
    const found = ids(dm);
    assert.ok(found.has("character:bree") && found.has("character:kel"));
    assert.equal(entryOf(dm, "field:character:kel:hp")?.value, "9 of 18");
    assert.ok(!found.has("field:character:bree:walk"), "Walk Speed is not one a DM looks up for every character");
    assert.equal(entryOf(dm, "character:bree")?.near, undefined);
    assert.equal(entryOf(dm, "field:character:bree:hp")?.near, undefined, "nearness is the selection's and a player's own");
  });

  test("a player finds only their own characters, every field, ranked near", () => {
    const pat = PAT_VIEW();
    const found = ids(pat);
    assert.ok(found.has("character:bree") && !found.has("character:kel"));
    assert.ok(![...found].some((id) => id.includes(":kel")), "nothing of another player's character");
    assert.equal(entryOf(pat, "field:character:bree:walk")?.value, "30 ft.");
    assert.equal(entryOf(pat, "field:character:bree:senses")?.near, true);
    assert.equal(entryOf(pat, "character:bree")?.near, true);
    assert.deepEqual(entryOf(pat, "field:character:bree:hp")?.act, { t: "character", characterId: "bree", route: { panel: "characters", page: "character:bree", section: "page.combat", anchor: "character.hp" } });
  });

  test("the selection's fields and conditions, near, through the token panel, its character's twins left out", () => {
    const room = seededRoom();
    room.characters.bree!.actor.effects = [effect("ef1", { key: "prone" })];
    const view = viewOf(room, DM, { selectedId: "tbree" });
    const index = indexOf(view);
    const hp = index.byId.get("field:token:tbree:hp")?.entry;
    assert.deepEqual(hp?.act, { t: "open", route: { panel: "token", section: "combat", anchor: "token.hp" } });
    assert.equal(hp?.near, true);
    assert.equal(hp?.value, "24 of 24");
    assert.ok(!index.byId.has("field:character:bree:hp"), "the token's field stands for the character's");
    assert.ok(index.byId.has("field:character:bree:long-rest"), "a field the token panel lacks stays the page's");
    assert.ok(index.byId.has("field:token:tbree:hidden"), "the DM's own token rows");
    const prone = index.byId.get("condition:prone")?.entry;
    assert.deepEqual(prone && { where: prone.where, act: prone.act, near: prone.near }, { where: "Remove from Bree", act: { t: "condition", condition: "prone", remove: true }, near: true });
    assert.equal(index.byId.get("condition:poisoned")?.entry.where, "Add to Bree");
    assert.equal(index.byId.get("condition:concentrating")?.entry.title, "Concentrating");
  });

  test("a player's selection gives fields and conditions only for a token they own", () => {
    const own = indexOf(viewOf(seededRoom(), P1, { selectedId: "tbree" }));
    assert.ok(own.byId.has("field:token:tbree:hp") && own.byId.has("condition:prone"));
    assert.ok(!own.byId.has("field:token:tbree:hidden"), "the DM's token rows never");
    for (const other of ["g1", "tkel", "boss"]) {
      const index = indexOf(viewOf(seededRoom(), P1, { selectedId: other }));
      assert.ok(!index.items.some((i) => i.entry.kind === "condition" || i.entry.id.startsWith("field:token:")), other);
    }
  });

  test("scenes, monsters, music and the library's documents for a DM alone", () => {
    const dm = ids(DM_VIEW());
    for (const id of ["scene:s1", "scene:s2", "monster:srd:goblin-boss", "playlist:drums", "action:play:drums", "track:song", "handout:doc:letter"]) assert.ok(dm.has(id), id);
    const pat = indexOf(PAT_VIEW());
    for (const kind of ["scene", "monster", "playlist", "track"]) assert.ok(!pat.items.some((i) => i.entry.kind === kind), kind);
    assert.ok(!pat.byId.has("handout:doc:letter"));
  });

  test("with sound files off, a DM's room that holds a playlist and a track offers none of their rows, as Sound draws no Library (LP32-A-SRCH-2)", () => {
    const off = ids(DM_VIEW(), { soundFiles: false });
    for (const id of ["playlist:drums", "action:play:drums", "track:song"]) assert.ok(!off.has(id), id);
    assert.ok(off.has("scene:s1") && off.has("handout:doc:letter"), "the other records stay");
    const on = ids(DM_VIEW(), { soundFiles: true });
    for (const id of ["playlist:drums", "action:play:drums", "track:song"]) assert.ok(on.has(id), id);
  });

  test("a scene's where says who is on it", () => {
    const dm = DM_VIEW();
    assert.equal(entryOf(dm, "scene:s1")?.where, "You are here · Players are here");
    assert.equal(entryOf(viewOf(seededRoom(), DM, { sceneId: "s2" }), "scene:s1")?.where, "Players are here");
  });

  test("the SRD monsters only once their chunk is in", () => {
    const dm = indexOf(DM_VIEW(), { monsters: null });
    assert.ok(!dm.items.some((i) => i.entry.id.startsWith("monster:srd:")));
  });

  test("Play <playlist> presses the Play control on the playlist's page", () => {
    assert.deepEqual(entryOf(DM_VIEW(), "action:play:drums")?.act, { t: "open", route: { panel: "sound", page: "playlist:drums", anchor: PLAY_PLAYLIST_ANCHOR, press: true } });
    assert.ok(VIEW_ANCHORS.includes(PLAY_PLAYLIST_ANCHOR));
  });

  test("a playlist lands on its row and a track on its Play, neither pressed, in Library", () => {
    assert.deepEqual(entryOf(DM_VIEW(), "playlist:drums")?.act, { t: "open", route: { panel: "sound", page: "playlist:drums", anchor: PLAYLIST_ANCHOR } });
    assert.deepEqual(entryOf(DM_VIEW(), "track:song")?.act, { t: "open", route: { panel: "sound", page: "track:song", anchor: TRACK_ANCHOR } });
    assert.ok([PLAYLIST_ANCHOR, TRACK_ANCHOR, OPEN_HANDOUT_ANCHOR, PLACE_MONSTER_ANCHOR].every((a) => VIEW_ANCHORS.includes(a)));
  });

  test("while a playlist plays, Play <playlist> is not offered, since its row's button is Pause. Paused, Play resumes it", () => {
    const room = seededRoom();
    const run = { playlistId: "drums", soundIds: ["song"], at: 0, startAt: 0, run: "r1", repeat: "all", fade: 0 } as unknown as NonNullable<NonNullable<typeof room.playing>["music"]>;
    room.playing = { rev: 0, music: run, loops: {}, effects: [], volume: { music: 100, effects: 100 } };
    assert.equal(entryOf(viewOf(room, DM), "action:play:drums"), undefined);
    assert.ok(entryOf(viewOf(room, DM), "playlist:drums"), "the playlist's own row stays");
    room.playing = { ...room.playing, music: { ...run, paused: 1_000 } };
    assert.ok(entryOf(viewOf(room, DM), "action:play:drums"));
  });

  test("a monster lands on its card's Place, unpressed", () => {
    assert.deepEqual(entryOf(DM_VIEW(), "monster:srd:goblin-boss")?.act, { t: "open", route: { panel: "monsters", page: "srd:goblin-boss", anchor: PLACE_MONSTER_ANCHOR } });
  });

  test("pages and showing handouts for both, each where its role opens them", () => {
    const room = seededRoom();
    room.handouts = { h1: { id: "h1", rev: 0, assetId: "a1", title: "Map of the keep", to: "all", shownAt: "2026-10-12T20:00:00.000Z" } };
    assert.deepEqual(entryOf(viewOf(room, P1), "handout:h1")?.act, { t: "open", route: { panel: "library", page: "handout:h1", anchor: OPEN_HANDOUT_ANCHOR, press: true } });
    assert.deepEqual(entryOf(viewOf(room, DM), "handout:h1")?.act, { t: "open", route: { panel: "dm", section: "handouts", page: "handout:h1" } });
    assert.ok(ids(viewOf(room, DM)).has("page:plans") && !ids(viewOf(room, P1)).has("page:plans"));
  });

  test("no view yet: only the panels, keys and catalogs", () => {
    const view = { ...DM_VIEW(), view: null } as RoomView;
    const index = buildIndex({ state: view, wide: true, keys: keysOf(view), catalogs: [EVERYONE_FIXTURE], monsters: null, soundFiles: true });
    assert.ok(index.items.every((i) => ["panel", "key", "section", "setting"].includes(i.entry.kind)));
  });

  test("ids are unique in an index, the first source winning", () => {
    const twice: Catalog = { entries: [...EVERYONE_FIXTURE.entries, { ...EVERYONE_FIXTURE.entries[0]!, title: "Again" }], fields: [], panels: {} };
    const view = DM_VIEW();
    const index = buildIndex({ state: view, wide: true, keys: keysOf(view), catalogs: [twice], monsters: null, soundFiles: true });
    const all = index.items.map((i) => i.entry.id);
    assert.equal(new Set(all).size, all.length);
    assert.equal(index.byId.get(EVERYONE_FIXTURE.entries[0]!.id)?.entry.title, "Sounds");
  });
});

describe("the catalogs", () => {
  test("a catalog entry is offered while its when holds, with its value now", () => {
    let on = false;
    const catalog: Catalog = {
      entries: [{ id: "setting:x.y", kind: "setting", title: "Party vision", where: "", icon: "settings", when: () => on, valueNow: () => (on ? "On" : "Off"), act: { t: "open", route: { panel: "dm" } } }],
      fields: [],
      panels: { tracker: { names: ["turn order"], bets: ["init"] } },
    };
    const view = DM_VIEW();
    const build = () => buildIndex({ state: view, wide: true, keys: keysOf(view), catalogs: [catalog], monsters: null, soundFiles: true });
    assert.ok(!build().byId.has("setting:x.y"));
    on = true;
    assert.equal(build().byId.get("setting:x.y")?.entry.value, "On");
    assert.deepEqual(build().byId.get("panel:tracker")?.entry.names, ["turn order"]);
  });

  test("catalogsFor: a player's search never asks for the DM's catalog, nor one not yet known", () => {
    const asked: unknown[] = [];
    const ready: DmCatalogState = { status: "ready", catalog: { entries: [], fields: [], panels: {} } };
    const dm = { request: (role: unknown) => (asked.push(role), ready) };
    for (const you of [{ memberId: "p1", role: "player" as const }, null]) {
      const out = catalogsFor({ you }, dm);
      assert.deepEqual(out.catalogs, [EVERYONE]);
      assert.equal(out.dm.status, "none");
    }
    assert.deepEqual(asked, []);
    const out = catalogsFor({ you: { memberId: "dm1", role: "dm" } }, dm);
    assert.deepEqual(asked, ["dm"]);
    assert.equal(out.catalogs.length, 2);
    assert.equal(out.catalogs[1], ready.catalog);
    const loading = catalogsFor({ you: { memberId: "dm1", role: "dm" } }, { request: () => ({ status: "loading" }) });
    assert.deepEqual(loading.catalogs, [EVERYONE]);
  });
});

describe("recent picks on an empty field (design-v1-qol.md 5, Players)", () => {
  test("a pick shows only while the index built now holds it", () => {
    const out = searchResults(indexOf(DM_VIEW()), "", ["token:g2", "gone", "panel:tracker"]);
    assert.deepEqual(out.t === "empty" && out.recent.map((e) => e.id), ["token:g2", "panel:tracker"]);
  });

  test("a recent whose token is hidden since is not shown to a player", () => {
    const room = seededRoom();
    assert.ok(indexOf(viewOf(room, P1)).byId.has("token:g1"));
    room.tokens.g1!.visibility = "dm";
    const out = searchResults(indexOf(viewOf(room, P1)), "", ["token:g1", "token:g2"]);
    assert.deepEqual(out.t === "empty" && out.recent.map((e) => e.id), ["token:g2"]);
  });
});

describe("a typed dice formula", () => {
  test("rolls from the Dice panel, written as an op carries it", () => {
    assert.deepEqual(diceRow(" 2d6 + 3 "), { id: "dice:2d6+3", kind: "dice", title: "Roll 2d6+3", where: "Dice", icon: "dice", act: { t: "roll", formula: "2d6+3" } });
  });

  test("its row comes first, above the entries the words match", () => {
    const view = DM_VIEW();
    const catalog: Catalog = { entries: [{ id: "action:loot", kind: "action", title: "Roll 2d6 for loot", where: "", icon: "dice", act: { t: "open", route: { panel: "dice" } } }], fields: [], panels: {} };
    const index = buildIndex({ state: view, wide: true, keys: keysOf(view), catalogs: [catalog], monsters: null, soundFiles: true });
    const out = searchResults(index, "2d6", []);
    assert.deepEqual(out.t === "typed" && out.rows.map((e) => e.id), ["dice:2d6", "action:loot"]);
  });

  test("anything else is no row", () => {
    for (const text of ["dmg", "d", "2", "3d", "dex save", "1d20+5 fire", "d20 please", "2d0"]) assert.equal(diceRow(text), null, text);
  });
});

describe("several floors (design-v1-floors.md 18.7, D-261107-217)", () => {
  const all = ["ground", "upper", "attic"];

  test("a DM finds the tokens of every floor of the scene in view, each tagged by its floor, and none of another scene", () => {
    const room = towerRoom();
    room.tokens.cave = { ...room.tokens.g1!, id: "cave", name: "Cave rat", sceneId: "s2" };
    const dm = towerView(room, DM, "ground", all);
    const view = { ...dm, view: { ...dm.view!, tokens: { ...dm.view!.tokens, cave: room.tokens.cave } } } as RoomView;
    const index = indexOf(view);
    assert.deepEqual(["g1", "thorn", "moth"].map((id) => index.byId.get(`token:${id}`)?.entry.where), ["Monster on Tower · Ground floor", "NPC on Tower · Upper floor", "Monster on Tower · Attic"]);
    assert.ok(!index.byId.has("token:cave"));
  });

  test("a scene without floors words its tokens as before", () => {
    assert.equal(entryOf(DM_VIEW(), "token:g1")?.where, "Monster on Battle mat");
  });

  test("a Floor row for each held floor while two or more are held, the one in view marked, and none otherwise", () => {
    const room = towerRoom();
    const rows = (view: RoomView) => indexOf(view).items.map((i) => i.entry).filter((e) => e.kind === "floor");
    const dm = rows(towerView(room, DM, "upper", all));
    assert.deepEqual(dm.map((e) => [e.title, e.where, e.act]), [
      ["Ground floor", "Tower", { t: "floor", sceneId: "ground" }],
      ["Upper floor", "Tower · Showing", { t: "floor", sceneId: "upper" }],
      ["Attic", "Tower", { t: "floor", sceneId: "attic" }],
    ]);
    assert.deepEqual(new Set(dm.map((e) => e.icon)), new Set(["floors"]), "the Floor button's icon");
    assert.deepEqual(rows(towerView(room, P1, "ground", ["ground", "upper"])).map((e) => e.title), ["Ground floor", "Upper floor"]);
    assert.deepEqual(rows(towerView(room, P1, "ground", ["ground"])), [], "one floor held is no choice");
    assert.deepEqual(rows(DM_VIEW()), [], "a scene without floors");
  });

  test("typing a floor's name finds its row", () => {
    const dm = indexOf(towerView(towerRoom(), DM, "ground", all));
    assert.equal(rowsOf(dm, "attic").find((e) => e.kind === "floor")?.id, "floor:attic");
  });

  test("a scene with floors is one row by its main floor, 'you are here' and 'players are here' for any of its floors", () => {
    const room = towerRoom();
    const dm = indexOf(towerView(room, DM, "upper", all));
    const scenes = dm.items.map((i) => i.entry).filter((e) => e.kind === "scene");
    assert.deepEqual(scenes.map((e) => [e.id, e.title, e.where]), [
      ["scene:ground", "Tower", "You are here · Players are here"],
      ["scene:s2", "Goblin cave", ""],
    ]);
    room.meta.playerSceneId = "attic";
    const elsewhere = indexOf(towerView(room, DM, "ground", all)).byId.get("scene:ground")?.entry;
    assert.equal(elsewhere?.where, "You are here · Players are here", "the players on Attic are on Tower");
    assert.equal(indexOf(towerView(room, DM, "ground", all)).byId.get("scene:s2")?.entry.where, "");
  });

  test("a player who holds Ground alone finds nothing of Upper or Attic, and with two floors held finds both", () => {
    const room = towerRoom();
    const alone = indexOf(towerView(room, P1, "ground", ["ground"]));
    const text = JSON.stringify(alone.items.map((i) => i.entry)).toLowerCase();
    for (const w of ["thorn", "moth", "upper", "attic"]) assert.ok(!text.includes(w), w);
    const two = indexOf(towerView(room, P1, "ground", ["ground", "upper"]));
    assert.ok(two.byId.has("token:thorn") && two.byId.has("floor:upper") && !two.byId.has("token:moth") && !two.byId.has("floor:attic"));
  });
});
