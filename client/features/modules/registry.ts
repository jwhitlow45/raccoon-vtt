/**
 * The parts of the app a device may hide (docs/design/design-v1-features.md 3):
 * 23 modules in five groups, each with the role defaults, its homes, the
 * parts it needs and what it claims in the app's registries. Hiding is
 * this device's and UI only: it never changes game state, what anyone
 * else sees, the rules or what the server sends (D-261127-127).
 *
 * Why claims: the panels, tools, keys, sheet rows, top bar parts, search
 * entries and builder modes each keep their own registry, and a module
 * names its entries there instead of every registry growing a module
 * field (D-261127-125). The gate (gate.ts) reads the claims, and the
 * ownership golden records them, so a new entry a module should own shows
 * up in review.
 *
 * This file holds data and plain derivations only. It imports nothing of
 * the room, the socket or the protocol, so every registry may read it.
 */

import { ddbCharacterId } from "#shared/ddb/link.ts";

export type ModuleId =
  | "spellSlots"
  | "hitDice"
  | "classResources"
  | "companions"
  | "ddb"
  | "ruler"
  | "areas"
  | "draw"
  | "ping"
  | "pins"
  | "traps"
  | "builder"
  | "dungeon"
  | "floors"
  | "sound"
  | "time"
  | "journal"
  | "encounters"
  | "outliner"
  | "tableDisplay"
  | "isometric"
  | "weather"
  | "diceAnimation";

export type Role = "dm" | "player";

export type ModuleGroup = "characters" | "tools" | "maps" | "panels" | "visuals";

/** The Features page's groups, in its order (D-261127-317). */
export const MODULE_GROUPS: readonly { id: ModuleGroup; name: string }[] = [
  { id: "characters", name: "Characters" },
  { id: "tools", name: "Tools" },
  { id: "maps", name: "Maps" },
  { id: "panels", name: "Panels" },
  { id: "visuals", name: "Visuals" },
];

/**
 * Where a hidden part's way back stands (design section 6): a quiet
 * "Hidden on this device:" line where the part lived. The creature homes
 * (uses, rest, companions, statBlock) name a part only where the creature
 * holds it (`holds`, D-261127-391).
 */
export type Home = "uses" | "rest" | "companions" | "statBlock" | "tools" | "panels" | "menu" | "sceneSettings" | "newScene" | "dmPanel" | "thisDevice";

export const HOMES: readonly Home[] = ["uses", "rest", "companions", "statBlock", "tools", "panels", "menu", "sceneSettings", "newScene", "dmPanel", "thisDevice"];

/** The homes on a creature's surface, where `holds` decides. */
export const CREATURE_HOMES: ReadonlySet<Home> = new Set<Home>(["uses", "rest", "companions", "statBlock"]);

/**
 * The registries a claim names an entry of:
 * - `panel`: features/panels.ts PANELS ids.
 * - `tool`: features/tools.ts TOOLS ids.
 * - `shortcut`: state/shortcuts.ts SHORTCUTS ids, the keys.
 * - `behavior`: state/shortcuts.ts BEHAVIORS ids, the sheet's other rows.
 * - `surface`: state/shortcuts.ts SURFACES, a sheet section named for a surface.
 * - `topBar`: pages/topBarFit.ts TopBarPart.
 * - `search`: a prefix of a search entry's id (features/search), `field:<key>` for a creature's field.
 * - `deviceSection`: a This device section whose body the part takes, its heading kept for the way back.
 * - `builderMode`: features/builder/store.ts BUILD_MODES values.
 * - `anchor`: a control's `data-search` id outside the part's own panel, which the e2e probes look for.
 */
export type ClaimKind = "panel" | "tool" | "shortcut" | "behavior" | "surface" | "topBar" | "search" | "deviceSection" | "builderMode" | "anchor";

export const CLAIM_KINDS: readonly ClaimKind[] = ["panel", "tool", "shortcut", "behavior", "surface", "topBar", "search", "deviceSection", "builderMode", "anchor"];

/**
 * A named condition a claim holds under (D-261127-311). A claim with one
 * hides its entry only while the condition holds, and only where the
 * caller knows it holds: a caller that cannot tell leaves the entry shown.
 */
export type ConditionName = "oneFloor";

export const CLAIM_CONDITIONS: Readonly<Record<ConditionName, string>> = {
  oneFloor: "The scene in view has one floor",
};

export type Claim = { kind: ClaimKind; id: string; when?: ConditionName };

/**
 * What a creature's surface knows of the creature, for a creature home's
 * `holds`. A character passes as it is (its `classes`, `resources`,
 * `ddbSync` and sheet link), with `mayAdd` where this viewer may add classes or class
 * resources on that page (D-261127-423).
 */
export type Holder = {
  classes?: readonly unknown[];
  resources?: readonly unknown[];
  ddbSync?: unknown;
  actor?: { sheetUrl?: string };
  mayAdd?: boolean;
};

export type RoleDefault = { shown: boolean; simple: boolean; homes: readonly Home[] };

export type ModuleDef = {
  id: ModuleId;
  /** As the app names the part (D-261127-131). */
  name: string;
  /** The switch's help, or one per role where they differ. */
  help: string | { dm: string; player: string };
  group: ModuleGroup;
  /** The roles that have the part, each with its default, whether Simple keeps it, and its homes. A role left out has no such part. */
  roles: Partial<Record<Role, RoleDefault>>;
  /** "menu" where a table display's own menu decides it as today, "no" where a display never shows it. A display ignores this device's choices (D-261127-126). */
  display: "menu" | "no";
  /** Parts that must show for this one to show (D-261127-115, 308). */
  needs?: readonly ModuleId[];
  /** Other names the page's search and the room search find it by. */
  names?: readonly string[];
  claims: readonly Claim[];
  /** On a creature home, whether the creature holds the part, so a fighter with no slots never reads "Show Spell slots" (D-261127-391). Left out, every creature does. */
  holds?(holder: Holder): boolean;
};

const BOTH = (homes: readonly Home[], simple: { dm: boolean; player: boolean }): Partial<Record<Role, RoleDefault>> => ({
  dm: { shown: true, simple: simple.dm, homes },
  player: { shown: true, simple: simple.player, homes },
});
const DM_ONLY = (homes: readonly Home[], simple = false): Partial<Record<Role, RoleDefault>> => ({ dm: { shown: true, simple, homes } });
const NEITHER = { dm: false, player: false };

const hasAny = (list: readonly unknown[] | undefined) => (list?.length ?? 0) > 0;
/** The slot parts on a character's page: held with classes, or where the viewer may add them (D-261127-423). */
const classesHeld = (h: Holder) => hasAny(h.classes) || h.mayAdd === true;

const tool = (id: string): Claim[] => [
  { kind: "tool", id },
  { kind: "shortcut", id: `tool:${id}` },
];

/** Every part, in the Features page's order (registry order, never by use). */
export const MODULES: readonly ModuleDef[] = [
  {
    id: "spellSlots",
    name: "Spell slots",
    help: "Slots by level and Pact Magic, spent with Use and back on a rest.",
    group: "characters",
    roles: BOTH(["uses"], NEITHER),
    display: "no",
    names: ["slots", "pact magic", "spell slot"],
    claims: [
      { kind: "anchor", id: "character.slots" },
      { kind: "search", id: "field:spell-slots" },
    ],
    holds: classesHeld,
  },
  {
    id: "hitDice",
    name: "Hit Point Dice",
    help: "The count of dice left. A Short Rest still rolls them.",
    group: "characters",
    roles: BOTH(["rest"], NEITHER),
    display: "no",
    names: ["hit dice", "hd"],
    claims: [
      { kind: "anchor", id: "character.hit-dice" },
      { kind: "search", id: "field:hit-dice" },
    ],
    holds: classesHeld,
  },
  {
    id: "classResources",
    name: "Class resources",
    help: "Counted features such as Rage, Channel Divinity and Lay on Hands.",
    group: "characters",
    roles: BOTH(["uses"], NEITHER),
    display: "no",
    names: ["resources", "rage", "channel divinity", "lay on hands"],
    claims: [],
    holds: (h) => hasAny(h.resources) || h.mayAdd === true,
  },
  {
    id: "companions",
    name: "Companions",
    help: "Familiars, summoned creatures and effects that belong to a character.",
    group: "characters",
    roles: BOTH(["companions"], NEITHER),
    display: "no",
    names: ["familiar", "summons", "pets"],
    claims: [
      { kind: "anchor", id: "character.companions" },
      { kind: "search", id: "field:companions" },
    ],
  },
  {
    id: "ddb",
    name: "D&D Beyond",
    help: "Import and re-sync characters from D&D Beyond.",
    group: "characters",
    roles: BOTH(["statBlock"], NEITHER),
    display: "no",
    names: ["dnd beyond", "ddb", "re-sync", "import"],
    claims: [],
    // As the stat block's Re-sync stands (pcstats/resync.ts resyncNumber): synced, or linked to a D&D Beyond sheet and never synced (D-261127-712).
    holds: (h) => (h.ddbSync !== undefined && h.ddbSync !== null) || (h.actor?.sheetUrl ? ddbCharacterId(h.actor.sheetUrl) !== null : false),
  },
  {
    id: "ruler",
    name: "Ruler",
    help: "Measure distances and plan a walk.",
    group: "tools",
    roles: BOTH(["tools"], { dm: true, player: true }),
    display: "no",
    names: ["measure", "distance"],
    claims: tool("ruler"),
  },
  {
    id: "areas",
    name: "Areas",
    help: "Spheres, cones, lines and more, placed or cast.",
    group: "tools",
    roles: BOTH(["tools"], { dm: true, player: false }),
    display: "no",
    names: ["area of effect", "aoe", "templates"],
    claims: [...tool("area"), { kind: "panel", id: "areas" }],
  },
  {
    id: "draw",
    name: "Draw",
    help: "Freehand, shapes, arrows and text on the map.",
    group: "tools",
    roles: BOTH(["tools"], { dm: true, player: false }),
    display: "no",
    names: ["drawing", "pen", "sketch"],
    claims: tool("draw"),
  },
  {
    id: "ping",
    name: "Ping and laser",
    help: "Ping a spot, point with the laser, and Look here.",
    group: "tools",
    roles: BOTH(["tools"], { dm: true, player: true }),
    display: "no",
    names: ["laser", "pointer", "look here"],
    claims: tool("ping"),
  },
  {
    id: "pins",
    name: "Map pins",
    help: "The Pin tool for notes and pages on the map.",
    group: "tools",
    roles: DM_ONLY(["tools"]),
    display: "no",
    names: ["pin", "pins"],
    claims: tool("pin"),
  },
  {
    id: "traps",
    name: "Traps",
    help: "The Trap tool. Traps already placed still go off and reach you.",
    group: "tools",
    roles: DM_ONLY(["tools"]),
    display: "no",
    names: ["trap"],
    claims: tool("trap"),
  },
  {
    id: "builder",
    name: "Map builder",
    help: "Paint floors, walls, doors, heights, lights and stamps, and place stairs between floors.",
    group: "maps",
    roles: DM_ONLY(["tools", "newScene"]),
    display: "no",
    names: ["builder", "walls", "doors", "stamps"],
    claims: [
      ...tool("build"),
      { kind: "behavior", id: "linkMove" },
      { kind: "behavior", id: "linkResize" },
      { kind: "anchor", id: "scenes.walls.builder" },
      { kind: "search", id: "action:scenes.walls.builder" },
    ],
  },
  {
    id: "dungeon",
    name: "Dungeon generator",
    help: "Generate a dungeon for a new scene, or add a wing.",
    group: "maps",
    roles: DM_ONLY(["newScene"]),
    display: "no",
    needs: ["builder"],
    names: ["dungeon", "generate", "wing"],
    claims: [
      { kind: "builderMode", id: "wing" },
      { kind: "behavior", id: "roomEdits" },
      { kind: "behavior", id: "wingArea" },
      { kind: "behavior", id: "wingJoin" },
      { kind: "behavior", id: "dungeonMarks" },
    ],
  },
  {
    id: "floors",
    name: "Floors",
    help: "Add floors above and below a scene. A scene with floors still shows them.",
    group: "maps",
    roles: DM_ONLY(["sceneSettings"]),
    display: "no",
    names: ["levels", "stories", "upstairs"],
    claims: [
      { kind: "anchor", id: "scenes.floors", when: "oneFloor" },
      { kind: "anchor", id: "scenes.floors.add-above", when: "oneFloor" },
      { kind: "anchor", id: "scenes.floors.add-below", when: "oneFloor" },
      { kind: "anchor", id: "scenes.floors.map", when: "oneFloor" },
      { kind: "search", id: "section:scenes.floors", when: "oneFloor" },
      { kind: "search", id: "setting:scenes.floors.map", when: "oneFloor" },
      { kind: "search", id: "action:scenes.floors.add-above", when: "oneFloor" },
      { kind: "search", id: "action:scenes.floors.add-below", when: "oneFloor" },
    ],
  },
  {
    id: "sound",
    name: "Sound",
    help: {
      dm: "Music, background sounds and effects the DM plays. Hidden, this device plays none. Players still hear what plays.",
      player: "Music, background sounds and effects the DM plays. Hidden, this device plays none.",
    },
    group: "panels",
    roles: BOTH(["panels"], { dm: false, player: true }),
    display: "menu",
    names: ["music", "audio", "ambiance", "sound effects"],
    claims: [
      { kind: "panel", id: "sound" },
      { kind: "topBar", id: "nowPlaying" },
      { kind: "topBar", id: "volume" },
      { kind: "shortcut", id: "mute" },
      { kind: "surface", id: "Music" },
      { kind: "anchor", id: "scenes.sound" },
      { kind: "anchor", id: "menu.this-device.sounds.volume" },
      { kind: "anchor", id: "menu.this-device.sounds.music" },
      { kind: "anchor", id: "menu.this-device.sounds.loops" },
      { kind: "anchor", id: "menu.this-device.sounds.effects" },
      { kind: "search", id: "section:sound." },
      { kind: "search", id: "setting:sound." },
      { kind: "search", id: "action:sound." },
      { kind: "search", id: "section:scenes.sound" },
      { kind: "search", id: "setting:menu.this-device.sounds.volume" },
      { kind: "search", id: "setting:menu.this-device.sounds.music" },
      { kind: "search", id: "setting:menu.this-device.sounds.loops" },
      { kind: "search", id: "setting:menu.this-device.sounds.effects" },
      { kind: "search", id: "playlist:" },
      { kind: "search", id: "action:play:" },
      { kind: "search", id: "track:" },
    ],
  },
  {
    id: "time",
    name: "Date and time",
    help: "The Time panel, the clock chip and its notes.",
    group: "panels",
    roles: BOTH(["panels"], { dm: false, player: true }),
    display: "menu",
    names: ["clock", "calendar", "date", "time"],
    claims: [
      { kind: "panel", id: "time" },
      { kind: "topBar", id: "clock" },
      { kind: "search", id: "section:time." },
      { kind: "search", id: "setting:time." },
      { kind: "search", id: "action:time." },
    ],
  },
  {
    id: "journal",
    name: "Journal",
    help: "Pages, folders and secrets the DM writes.",
    group: "panels",
    roles: BOTH(["panels"], { dm: false, player: true }),
    display: "no",
    names: ["pages", "notes", "lore"],
    claims: [
      { kind: "panel", id: "journal" },
      { kind: "search", id: "page:" },
    ],
  },
  {
    id: "encounters",
    name: "Encounters",
    help: "Build encounters with XP budgets and place them.",
    group: "panels",
    roles: DM_ONLY(["panels"]),
    display: "no",
    names: ["xp budget", "encounter builder"],
    claims: [{ kind: "panel", id: "encounters" }],
  },
  {
    id: "outliner",
    name: "Outliner",
    help: "Everything on the scene in one list.",
    group: "panels",
    roles: DM_ONLY(["panels"]),
    display: "no",
    names: ["scene list", "search the scene"],
    claims: [
      { kind: "panel", id: "outliner" },
      { kind: "shortcut", id: "outliner" },
    ],
  },
  {
    id: "tableDisplay",
    name: "Table display",
    help: "Show the players' view on a TV.",
    group: "panels",
    roles: DM_ONLY(["dmPanel"]),
    display: "no",
    names: ["tv", "second screen"],
    claims: [
      { kind: "anchor", id: "dm.display" },
      { kind: "anchor", id: "dm.display.show-view" },
      { kind: "anchor", id: "dm.display.add" },
      { kind: "anchor", id: "dm.display.open" },
      { kind: "search", id: "section:dm.display" },
      { kind: "search", id: "setting:dm.display." },
      { kind: "search", id: "action:dm.display." },
    ],
  },
  {
    id: "isometric",
    name: "Isometric view",
    help: "Tilt the map and stand creatures up. Hidden, the map stays top-down.",
    group: "visuals",
    roles: BOTH(["menu"], NEITHER),
    display: "menu",
    names: ["iso", "3d view", "tilt", "standees"],
    claims: [
      { kind: "topBar", id: "view" },
      { kind: "shortcut", id: "view" },
      { kind: "shortcut", id: "turnLeft" },
      { kind: "shortcut", id: "turnRight" },
      { kind: "behavior", id: "tapAgain" },
    ],
  },
  {
    id: "weather",
    name: "Weather",
    help: "Rain, snow and fog over the map. Rolls still follow the weather.",
    group: "visuals",
    roles: {
      dm: { shown: true, simple: false, homes: ["sceneSettings", "thisDevice"] },
      player: { shown: true, simple: true, homes: ["thisDevice"] },
    },
    display: "menu",
    names: ["rain", "snow", "storm"],
    claims: [
      { kind: "deviceSection", id: "weather" },
      { kind: "anchor", id: "menu.this-device.weather.mode" },
      { kind: "anchor", id: "scenes.light.weather" },
      { kind: "search", id: "setting:menu.this-device.weather.mode" },
      { kind: "search", id: "setting:scenes.light.weather" },
    ],
  },
  {
    id: "diceAnimation",
    name: "Dice animation",
    help: "Your rolls throw dice that land on the result.",
    group: "visuals",
    roles: BOTH(["thisDevice"], { dm: true, player: true }),
    display: "no",
    names: ["3d dice", "roll animation", "dice throw"],
    claims: [
      { kind: "behavior", id: "diceThrowEnd" },
      { kind: "anchor", id: "menu.this-device.rolls.dice-set" },
      { kind: "search", id: "setting:menu.this-device.rolls.dice-set" },
    ],
  },
];

export const MODULE_IDS: readonly ModuleId[] = MODULES.map((m) => m.id);

const BY_ID: ReadonlyMap<string, ModuleDef> = new Map(MODULES.map((m) => [m.id, m]));

export function isModuleId(id: string): id is ModuleId {
  return BY_ID.has(id);
}

export function moduleById(id: ModuleId): ModuleDef {
  return BY_ID.get(id)!;
}

/** The parts a role has, in registry order: 23 for a DM, 15 for a player. */
export function modulesFor(role: Role): ModuleDef[] {
  return MODULES.filter((m) => m.roles[role] !== undefined);
}

export function helpFor(m: ModuleDef, role: Role): string {
  return typeof m.help === "string" ? m.help : m.help[role];
}

/** Every part `id` needs, its needs' needs included, in registry order. */
export function needsOf(id: ModuleId): ModuleId[] {
  const found = new Set<ModuleId>();
  const walk = (at: ModuleId) => {
    for (const n of moduleById(at).needs ?? []) {
      if (found.has(n)) continue;
      found.add(n);
      walk(n);
    }
  };
  walk(id);
  return MODULE_IDS.filter((m) => found.has(m));
}

/** The parts that need `id`, directly or through another, derived from `needs` and never written twice. */
export function dependentsOf(id: ModuleId): ModuleId[] {
  return MODULE_IDS.filter((m) => needsOf(m).includes(id));
}

/** The parts Simple keeps for a role. Every other part of the role hides there. */
export function simpleFor(role: Role): ReadonlySet<ModuleId> {
  return new Set(modulesFor(role).flatMap((m) => (m.roles[role]?.simple ? [m.id] : [])));
}

/**
 * The parts that never hide (design section 2, D-261127-107, 319), for the
 * page's "Always shown" group and its search: each line as the page shows
 * it, and the names a search for one of them matches ("The X-card always
 * shows.").
 */
export const CORE_PARTS: readonly { line: string; names: readonly string[] }[] = [
  {
    line: "The map and scenes, fog, vision and light, and the walls, doors, lights and labels on the map, with doors opened and closed from the map. Making and editing the build is Map builder's.",
    names: ["Map", "Scenes", "Fog", "Vision", "Light", "Walls", "Doors", "Lights", "Labels"],
  },
  { line: "Tokens with HP, AC, conditions, elevation and movement, the Select tool, Add token and Line up grid.", names: ["Tokens", "HP", "AC", "Conditions", "Elevation", "Movement", "Select tool", "Add token", "Line up grid"] },
  {
    line: "Dice, roll requests and answers, group saves, Initiative, turns, turn cards, death saves, concentration and rests, whose prompts must reach everyone.",
    names: ["Dice", "Roll requests", "Group saves", "Initiative", "Turns", "Turn cards", "Death saves", "Concentration", "Rests"],
  },
  { line: "Characters and Monsters panels, the party bar, Library, Scenes and the DM panel (less its Table display section).", names: ["Characters", "Monsters", "Party bar", "Library", "DM panel"] },
  { line: "The Log, chat, whispers and handouts: the Log is where every hidden part still reports.", names: ["Log", "Chat", "Whispers", "Handouts"] },
  {
    line: "Joining, Members, kicking, DM devices and the player link, the X-card with Pause the game and Stop the sound, blackouts and View as a player.",
    names: ["Joining", "Members", "DM devices", "Player link", "X-card", "Blackouts", "View as a player"],
  },
  { line: "Search, Undo, Setup history, the Menu, This device and Features, the shortcut sheet, the DM guide and About.", names: ["Search", "Undo", "Setup history", "Menu", "This device", "Features", "Shortcuts", "DM guide", "About"] },
];
