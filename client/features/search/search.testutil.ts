import { readFileSync } from "node:fs";
import type { Character, RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { actor, character, DM, handoutPage, member, P1, room, scene, token } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { DEFAULT_KEYS, keyText, type ShortcutEnv } from "../../state/shortcuts.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions, RoomView } from "../../state/types.ts";
import { DM_CATALOG } from "./catalog/dm.ts";
import { EVERYONE } from "./catalog/everyone.ts";
import type { Catalog, CatalogEntry } from "./catalog/types.ts";
import { buildIndex, searchResults, searchRole, SUGGEST, type KeySource, type SearchIndex } from "./index.ts";

/**
 * Test fixtures for the room search: the seeded room the design's flows
 * and golden queries use (designs/qol/search.md 2 and 7), stand-in
 * catalogs for the index's own tests, and the real catalogs each role
 * holds, which the golden queries run on. Nothing here ships.
 */

export const SRD: readonly SrdMonster[] = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];

const OPEN = { t: "open" as const };

/** Everyone's stand-in: This device's sound rows, the fields, Initiative's words and a player's You menu. */
export const EVERYONE_FIXTURE: Catalog = {
  entries: [
    { id: "section:menu.this-device.sounds", kind: "section", title: "Sounds", where: "Menu · This device", icon: "volume", act: { ...OPEN, route: { panel: "menu", page: "this-device", section: "sounds", anchor: "menu.this-device.sounds" } } },
    { id: "setting:menu.this-device.sounds.music", kind: "setting", title: "Music volume", where: "Menu · This device · Sounds", icon: "volume", act: { ...OPEN, route: { panel: "menu", page: "this-device", section: "sounds", anchor: "menu.this-device.sounds.music" } } },
    { id: "setting:menu.this-device.sounds.room", kind: "setting", title: "Room sound", names: ["music on this device", "mute"], where: "Menu · This device · Sounds", icon: "volume", act: { ...OPEN, route: { panel: "menu", page: "this-device", section: "sounds", anchor: "menu.this-device.sounds.room" } } },
    { id: "setting:menu.this-device.sounds.turn", kind: "setting", title: "Turn sound", names: ["chime"], where: "Menu · This device · Sounds", icon: "volume", act: { ...OPEN, route: { panel: "menu", page: "this-device", section: "sounds", anchor: "menu.this-device.sounds.turn" } } },
  ],
  fields: [
    { key: "hp", title: "Hit Points", icon: "combat", token: { section: "combat", anchor: "token.hp" }, page: { section: "page.combat", anchor: "character.hp" }, everyCharacter: true, value: (a) => (a.hp ? `${a.hp.cur} of ${a.hp.max}` : undefined) },
    { key: "ac", title: "Armor Class", icon: "stats", token: { section: "stats", anchor: "token.ac" }, page: { section: "page.stats", anchor: "character.ac" }, everyCharacter: true, value: (a) => (a.ac === undefined ? undefined : String(a.ac)) },
    { key: "pp", title: "Passive Perception", icon: "stats", token: { section: "stats", anchor: "token.pp" }, page: { section: "page.stats", anchor: "character.pp" }, everyCharacter: true, value: (a) => (a.passivePerception === undefined ? undefined : String(a.passivePerception)) },
    { key: "senses", title: "Senses", icon: "stats", token: { section: "stats", anchor: "token.senses" }, page: { section: "page.stats", anchor: "character.senses" }, everyCharacter: true, value: (a) => a.senses || undefined },
    { key: "long-rest", title: "Long Rest", icon: "time", page: { section: "page.combat", anchor: "character.long-rest" }, everyCharacter: true },
    { key: "short-rest", title: "Short Rest", icon: "time", page: { section: "page.combat", anchor: "character.short-rest" }, everyCharacter: true },
    { key: "walk", title: "Walk Speed", icon: "speed", token: { section: "stats", anchor: "token.walk" }, page: { section: "page.stats", anchor: "character.walk" }, value: (a) => (a.speeds ? `${a.speeds.walk} ft.` : undefined) },
  ],
  panels: { tracker: { bets: ["init", "initiative"] } },
  items: (ctx) =>
    ctx.role === "player"
      ? [{ id: "item:you.xcard", kind: "action", title: "X-card…", names: ["safety"], where: "You menu", icon: "about", act: { t: "item", itemId: "you.xcard", twin: { panel: "menu", anchor: "menu.xcard" } }, suggest: SUGGEST.xCard }]
      : [],
};

const inFight = (state: RoomView) => (state.view?.encounter?.entries.length ?? 0) > 0;

/** The DM's stand-in: the actions, sections and settings the case table names, the DM menu's items and a DM-only token row. */
export const DM_FIXTURE: Catalog = {
  entries: [
    { id: "action:characters.party-long-rest", kind: "action", title: "Long Rest for the party", names: ["party rest"], bets: ["rest", "long rest", "lr"], where: "Characters", icon: "characters", suggest: SUGGEST.longRest, act: { ...OPEN, route: { panel: "characters", anchor: "characters.party-long-rest", press: true } } } satisfies CatalogEntry,
    { id: "action:tracker.start-fight", kind: "action", title: "Start a fight", names: ["roll initiative", "encounter"], bets: ["init", "initiative", "fight"], where: "Initiative", icon: "combat", suggest: SUGGEST.startFight, when: (ctx) => !inFight(ctx.state), act: { ...OPEN, route: { panel: "tracker", anchor: "tracker.start-fight" } } },
    { id: "section:sound.now", kind: "section", title: "Now playing", names: ["music player"], bets: ["music"], where: "Sound", icon: "music", act: { ...OPEN, route: { panel: "sound", page: "now", anchor: "sound.now" } } },
    { id: "section:menu.room-settings.combat", kind: "section", title: "Combat", names: ["initiative rules"], where: "Menu · Room settings", icon: "settings", act: { ...OPEN, route: { panel: "menu", page: "room-settings", section: "combat", anchor: "menu.room-settings.combat" } } },
    { id: "setting:menu.room-settings.combat.init-scores", kind: "setting", title: "Use Initiative scores for monsters", where: "Menu · Room settings · Combat", icon: "settings", act: { ...OPEN, route: { panel: "menu", page: "room-settings", section: "combat", anchor: "menu.room-settings.combat.init-scores" } } },
    { id: "setting:menu.room-settings.combat.skip", kind: "setting", title: "Skip defeated creatures", names: ["initiative"], where: "Menu · Room settings · Combat", icon: "settings", act: { ...OPEN, route: { panel: "menu", page: "room-settings", section: "combat", anchor: "menu.room-settings.combat.skip" } } },
    { id: "setting:scenes.light.level", kind: "setting", title: "Light level", names: ["bright", "dim", "darkness"], bets: ["dark"], where: "Scenes · Light and weather", icon: "light", act: { ...OPEN, route: { panel: "scenes", section: "light", anchor: "scenes.light.level" } } },
    {
      id: "setting:menu.room-settings.players.party-hp",
      kind: "setting",
      title: "Players see the party's HP",
      where: "Menu · Room settings · Players",
      icon: "settings",
      valueNow: (ctx) => (ctx.state.view?.meta.settings.pcHpVisibleToParty ? "On" : "Off"),
      act: { ...OPEN, route: { panel: "menu", page: "room-settings", section: "players", anchor: "menu.room-settings.players.party-hp" } },
    },
  ],
  fields: [{ key: "hidden", title: "Hidden from players", names: ["hide", "invisible"], icon: "hidden", token: { section: "settings", anchor: "token.hidden" } }],
  panels: { monsters: { names: ["creatures"] } },
  items: () => [
    { id: "item:dm.screens.blackout", kind: "action", title: "Black out players' screens", bets: ["pause", "blackout"], where: "DM menu · Players' screens", icon: "dm", suggest: SUGGEST.blackout, act: { t: "item", itemId: "dm.screens.blackout", twin: { panel: "dm", section: "screens", anchor: "dm.screens.blackout" } } },
    { id: "item:dm.handouts.show", kind: "action", title: "Show a handout…", names: ["picture", "image", "pdf", "letter"], where: "DM menu · Handouts", icon: "library", suggest: SUGGEST.showHandout, act: { t: "item", itemId: "dm.handouts.show", twin: { panel: "dm", section: "handouts", anchor: "dm.handouts.show" } } },
  ],
};

/**
 * The seeded room (search.md 2): Pat plays Bree, who has Darkvision, and
 * Kel is another player's. On the Battle mat, the players' scene, stand
 * Goblin 1 and 2, a hidden Goblin Boss and Count Varo under the name
 * Hooded figure. The DM holds a Goblin cave, Goblin war drums, a page for
 * themselves and one for everyone, and a document in the library.
 */
export function seededRoom(): RoomState {
  const bree: Character = character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ hp: { cur: 24, max: 24, temp: 0 }, ac: 15, senses: "Darkvision 60 ft.", passivePerception: 13 }) });
  const kel: Character = character("kel", { name: "Kel", ownerIds: ["p2"], actor: actor({ hp: { cur: 9, max: 18, temp: 0 }, ac: 12 }) });
  return room({
    members: { dm1: { ...member("dm1", "dm"), name: "DM" }, p1: { ...member("p1"), name: "Pat" }, p2: { ...member("p2"), name: "Sam" } },
    scenes: { s1: scene("s1", { name: "Battle mat" }), s2: scene("s2", { name: "Goblin cave", order: 1 }) },
    characters: { bree, kel },
    tokens: {
      g1: token("g1", { name: "Goblin", number: 1, x: 4, y: 4 }),
      g2: token("g2", { name: "Goblin", number: 2, x: 5, y: 4 }),
      boss: token("boss", { name: "Goblin Boss", visibility: "dm", x: 6, y: 6 }),
      varo: token("varo", { name: "Count Varo", nameHidden: true, publicName: "Hooded figure", kind: "npc", x: 8, y: 8 }),
      tbree: token("tbree", { name: "Bree", kind: "pc", ownerIds: [], actor: { ref: "bree" }, x: 2, y: 2 }),
      tkel: token("tkel", { name: "Kel", kind: "pc", ownerIds: [], actor: { ref: "kel" }, x: 2, y: 3 }),
      far: token("far", { name: "Goblin scout", sceneId: "s2" }),
    },
    playlists: { drums: { id: "drums", rev: 0, name: "Goblin war drums", sounds: ["song"], repeat: "all", fade: 0 } },
    sounds: { song: { id: "song", rev: 0, name: "Tavern song", assetId: "a1", ms: 60_000, use: "music" } },
    journal: {
      plans: { id: "plans", rev: 0, title: "Villain plans", access: "dm", blocks: [] },
      town: { id: "town", rev: 0, title: "Town map", access: "all", blocks: [] },
    },
    handoutDocs: { letter: { id: "letter", rev: 0, title: "Belak's letter", pages: [handoutPage("page1")], createdAt: "2026-10-12T20:00:00.000Z" } },
  });
}

/** The room as a viewer's device holds it: the projection the server sends, with the local parts the index reads. */
export function viewOf(state: RoomState, viewer: Viewer, local: { selectedId?: string | null; sceneId?: string } = {}): RoomView {
  const sceneId = viewer.role === "dm" ? (local.sceneId ?? state.meta.playerSceneId ?? "s1") : state.meta.playerSceneId;
  const projected = projectState(state, viewer, { sceneId: viewer.role === "dm" ? sceneId : null });
  return {
    you: { memberId: viewer.memberId, role: viewer.role },
    roomId: "room1",
    view: projected as unknown as RoomView["view"],
    sceneId,
    local: { selectedId: local.selectedId ?? null, selectedIds: local.selectedId ? [local.selectedId] : [], tool: "select" },
  } as unknown as RoomView;
}

/** The keys as the room has them, each `when` read with a stand-in env, the default keys written as the sheet writes them. */
export function keysOf(state: RoomView): KeySource {
  const role = searchRole(state);
  const tools = role === "dm" ? ["select", "ruler", "area", "draw", "ping", "add-token", "pin", "trap", "fog", "build", "grid"] : ["select", "ruler", "area", "draw", "ping"];
  const env: ShortcutEnv = { role, tools: tools.map((id) => ({ id })), getState: () => state, actions: {} as RoomActions, ui: {} as RoomUi, scope: new RoomScope() };
  return { applies: (s) => !s.when || s.when(env), text: (id) => keyText(id, DEFAULT_KEYS) };
}

/** A viewer's catalogs, the real ones, as catalogsFor gives them once the DM's has loaded. */
export const DM_CATALOGS: readonly Catalog[] = [EVERYONE, DM_CATALOG];
export const PLAYER_CATALOGS: readonly Catalog[] = [EVERYONE];

/** A viewer's index of the room, from the fixture catalogs their role holds. */
export function indexOf(state: RoomView, options: { wide?: boolean; monsters?: readonly SrdMonster[] | null } = {}): SearchIndex {
  const dm = searchRole(state) === "dm";
  return buildIndex({ state, wide: options.wide ?? true, keys: keysOf(state), catalogs: dm ? DM_CATALOGS : PLAYER_CATALOGS, monsters: options.monsters === undefined ? (dm ? SRD : null) : options.monsters });
}

/** The typed list's rows for a query. */
export function rowsOf(index: SearchIndex, text: string, recent: readonly string[] = []) {
  const out = searchResults(index, text, recent);
  if (out.t !== "typed") throw new Error(`"${text}" read as an empty field`);
  return out.rows;
}

export const DM_VIEW = () => viewOf(seededRoom(), DM);
export const PAT_VIEW = () => viewOf(seededRoom(), P1);
