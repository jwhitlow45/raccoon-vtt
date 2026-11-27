import { playersSeeFields, withPlayersSee, type NewScenePick, type SceneInput } from "../scenes/create.ts";
import { openFloorLine } from "../scenes/floorWords.ts";
import type { DungeonPlan } from "./plan.ts";
import { versionChar } from "./seed.ts";
import { isHexGrid, litCount, raisedCount, secretCount, trapCount, type GridKind, type Theme } from "./settings.ts";
import { sceneHexSpan } from "#shared/rules/hex.ts";
import { hexGridOf } from "./lattice.ts";
import type { DungeonOutcome } from "./send.ts";
import type { Summary } from "./client.ts";
import type { PartyGroup } from "#shared/model.ts";
import type { Difficulty } from "#shared/srd/xp-budget.ts";
import type { LevelBand } from "#shared/srd/traps.ts";
import { DIFFICULTY_LABEL, partySize, xpText } from "../encounters/budget.ts";

/**
 * Every sentence the Generate a dungeon dialog shows
 * (docs/design/design-v1-dungeon-generator.md 4.1 to 4.4), apart from React so
 * the tests read them as the DM does.
 */

export const GENERATE_LEAD = "Or start from a generated dungeon";

export const THEME_HELP = {
  dungeon: "Stone and wood rooms, closed and locked doors, rubble and pits.",
  crypt: "Stone halls with pillars, more locked doors.",
  cave: "Rough caverns of cave floor joined by tunnels, with no doors. The Fog tool's Builder room then reveals every cave the tunnels join.",
  mine: "Dirt chambers and tunnels, wooden doors, rubble from old collapses and open shafts.",
  sewer: "Stone halls, cisterns and corridors that run with water. Wide corridors keep a dry walkway beside the channel.",
} as const;
export const DENSITY_HELP = "How much of the map the rooms fill.";
export const WIDE_HELP = "Wide corridors and their doorways are 2 squares across, with double doors, so Large creatures walk them without squeezing once the doors are open.";
/** Corridor width's help on hexes (phase 3, 7). */
export const WIDE_HELP_HEX = "Wide corridors and their doorways are 2 hexes across, with a door on each of a doorway's three sides, so Large creatures walk them without squeezing once the doors are open.";
/** Under Theme on hexes (phase 3, 7, D-261110-160). */
export const HEX_THEME_NOTE = "On hexes rooms are drawn with wall lines: no painted floors, and rubble and water are difficult ground.";
/** Heights' help on a wing whose scene's stairs make no walls (phase 3, 3.2, D-261110-235). */
export const WING_FLAT = "Stairs make no walls on this scene, so the wing stays flat.";
export const LOOPS_HELP = "Adds loops, so the way back is not always the way in.";
export const HEIGHTS_HELP = "Rooms raised or sunk 5 or 10 ft, with stairs to them. The entrance room stays flat.";
export const TRAPS_HELP = "Example traps from the SRD. Players see one only once it is found.";
/** Party level picks the SRD's column for each example trap, as the Trap tool's does: nothing else in the dungeon reads it. */
export const PARTY_LEVEL_HELP = "How strong the traps are: their save DCs, damage and pit depths follow the SRD for a party of these levels.";
export const DEAD_ENDS_HELP = "Adds corridors that end in rock, so not every dead end hides a secret door.";
export const SECRETS_HELP = "Some lead to a secret room. Players see plain wall there until it is found.";
export const SECRETS_CAVE = "Caves have no doors, so none are secret.";
export const DRESSING_HELP = "Furniture, bones and clutter from the shipped stamps, kept off the ways through each room.";
export const KEY_HELP = "A DM-only journal page describing each room by number, and a DM-only numbered pin in each room.";
export const KEY_FULL = "The journal is full, so there is no room for a key.";
export const SEED_HELP = "A seed makes the same dungeon again on this version of the app, at the same feet per square.";
/** The seed's promise while Monsters is above None, since the party shapes each fight (docs/design/design-v1-dungeon-stock.md 4, D-261127-062). */
export const SEED_HELP_STOCKED = "A seed makes the same dungeon again on this version of the app, at the same feet per square, for the same party.";
export const NO_FOG_WARNING = "Players see this scene without fog, so every room shows at once. Explore or Reveal by hand keeps rooms dark until found.";
export const NO_FOG_SECRET_WARNING = "Players see this scene without fog, so every room shows at once, secret rooms too. Explore or Reveal by hand keeps rooms dark until found.";

/** The Lit rooms help, by theme: what the room's light stamp is and which light it gives. */
export const LIT_HELP: Readonly<Record<Theme, string>> = {
  dungeon: "Each lit room has a fire pit that lights it as a torch does.",
  crypt: "Each lit room has a candelabra that lights it as a candle does.",
  cave: "Each lit room has a campfire that lights it as a torch does.",
  mine: "Each lit room has a lantern that lights it as a hooded lantern does.",
  sewer: "Each lit room has a lantern that lights it as a hooded lantern does.",
};

/** The warning above the foot when the form's Players see leaves fog off (Everything, or Like a scene without fog), else null. */
export function fogLine(pick: NewScenePick, secretRooms = false): string | null {
  if (playersSeeFields(pick).fogEnabled) return null;
  return secretRooms ? NO_FOG_SECRET_WARNING : NO_FOG_WARNING;
}

/**
 * The light line while Lit rooms is above None, mirroring the import's
 * (vision/uvttLight.ts `lightsLead`). `kept` is the DM's tap of Keep it lit,
 * which the dialog holds until it closes.
 */
export function lightLine(kept: boolean): { text: string; action: string } {
  return kept
    ? { text: "Start the scene dark with party vision on, so its lights light it for the party.", action: "Start it dark" }
    : { text: "The scene starts dark with party vision on, so its lights light it for the party.", action: "Keep it lit" };
}

/**
 * The scene Make sends: Players see from the form, or Explore with the light
 * Dark when the lights are to light it for the party (4.1 row 7, as the
 * import does). Keep it lit is the form's pick with the default Bright.
 */
export function startScene(scene: SceneInput, pick: NewScenePick, dark: boolean): SceneInput {
  return dark ? withPlayersSee(scene, { preset: "explore" }, "dark") : withPlayersSee(scene, pick);
}

/** Secret doors in words, for the Rooms asked: "No secret doors", or "About 2 secret doors". */
export function secretsWords(twelfths: number, rooms: number): string {
  const n = secretCount(twelfths, rooms);
  return n === 0 ? "No secret doors" : `About ${n} secret ${n === 1 ? "door" : "doors"}`;
}

/** Lit rooms in words, for the Rooms asked: "No lights", or "About 3 of 12 rooms lit". */
export function litWords(share: number, rooms: number): string {
  const n = litCount(share, rooms);
  return n === 0 ? "No lights" : `About ${n} of ${rooms} rooms lit`;
}

/*
 * The Monsters rows (docs/design/design-v1-dungeon-stock.md 1).
 */

export const MONSTERS_HELP = "Each of those rooms holds one fight for the party at this difficulty, from the SRD monsters that suit the theme. They stand hidden from players until you show them.";
export const MONSTERS_HELD = "Give the party a level to stock rooms: set one on a character's card, or edit the party below.";
export const MONSTERS_LOADING = "Loading monsters…";
/** What each theme stocks its rooms from (stockPools.ts `THEME_FAMILIES`). */
export const MONSTERS_THEME: Readonly<Record<Theme, string>> = {
  dungeon: "Goblins, bandits, cultists, beasts of the deep, oozes and constructs.",
  crypt: "The undead and the constructs that guard them.",
  cave: "Beasts, swarms, oozes, fungi and the things that lair in the dark.",
  mine: "Elementals, constructs, burrowers, goblins and kobolds.",
  sewer: "Rats, snakes, crocodiles, swarms, oozes, otyughs and wererats.",
};

/** Monsters in words, for the Rooms asked, as Heights rounds: "No monsters", or "About 3 rooms of 12 get monsters". */
export function monstersWords(share: number, rooms: number): string {
  const n = raisedCount(share, rooms);
  return n === 0 ? "No monsters" : `About ${n} ${n === 1 ? "room" : "rooms"} of ${rooms} ${n === 1 ? "gets" : "get"} monsters`;
}

/** "4 characters at level 3", or "5 characters: 4 at level 3, 1 at level 4". */
export function partyWords(groups: readonly PartyGroup[]): string {
  const size = partySize(groups);
  const who = `${size} ${size === 1 ? "character" : "characters"}`;
  const only = groups.length === 1 ? groups[0] : undefined;
  return only ? `${who} at level ${only.level}` : `${who}: ${groups.map((g) => `${g.count} at level ${g.level}`).join(", ")}`;
}

/** Difficulty's help from the live budget: "Moderate: 900 XP a room for 4 characters at level 3." */
export function difficultyHelp(d: Difficulty, budget: number, groups: readonly PartyGroup[]): string {
  return `${DIFFICULTY_LABEL[d]}: ${xpText(budget)} a room for ${partyWords(groups)}.`;
}

const bandWords = (band: LevelBand) => `levels ${band.replace("-", " to ")}`;

/**
 * The Party level row's lines while it follows the party (D-261127-229):
 * where the band was set from, and when a live level-up has put the party
 * in another band since, what the party is now and when the band moves.
 */
export function bandLines(band: LevelBand, now: LevelBand | null, level: number | null): string[] {
  const lines = [`Set from the party: ${bandWords(band)}.`];
  if (now !== null && now !== band && level !== null) lines.push(`The party is now level ${level}. The band moves when you next change the party or Monsters.`);
  return lines;
}

/** The over-limit line in the Monsters area (D-261127-280). */
export function overLimitLine(by: number): string {
  return `Over the creature limit by ${by}. Turn a room's monsters off, or lower Monsters.`;
}

/**
 * The Monsters line for a wing whose creatures did not land with the
 * count within the limit: another of the scene's caps refused them, so
 * the same two ways out stand (D-261127-602).
 */
export const NO_ROOM_FOR_MONSTERS = "This scene has no room for these monsters. Turn a room's monsters off, or lower Monsters.";

/** "Goblin Boss, Goblin Warrior × 3": each kind by its SRD name, a count past one as sizes write it, so no plural is made. The key and the room panel both write a fight so. */
export function fightWords(lines: readonly (readonly [string, number])[]): string {
  return lines.map(([name, n]) => (n > 1 ? `${name} × ${n}` : name)).join(", ");
}

/** A room's fight as the room panel lists it: "Goblin Boss, Goblin Warrior × 3 · 350 XP". */
export function fightLine(lines: readonly (readonly [string, number])[], xp: number): string {
  return `${fightWords(lines)} · ${xpText(xp)}`;
}

export const OTHER_MONSTERS = "Other monsters";

export const LOOK_CLOSER = "Look closer";
export const LOOK_CLOSER_DETAILS = "The DM view: secret doors, traps and room numbers show only here.";
export const LOOK_CLOSER_FAILED = "This device could not draw the dungeon larger.";

export const DRAWING = "Drawing the dungeon…";
export const WAITING = "Waiting for the server…";
export const FIT_NONE = "Could not fit two rooms. Try a larger size, fewer rooms or Sparse.";
export const NOT_MADE = "This dungeon could not be made. Reroll for another.";
export const PICTURE_FAILED = "This device could not draw the preview, so Make is off. Reroll or change a choice to try again.";
/** Its example is a seed of this version, so typing it draws a dungeon rather than the note for another version's. */
export const SEED_BAD = `A seed is 16 letters and digits, like ${versionChar()}K7Q-H2MX-A9F3-TWQ5.`;
export const SEED_OTHER_VERSION = "This seed is from another version of the generator, so it makes a different dungeon now.";

/**
 * "30 × 30 squares (150 by 150 ft)", in the room's feet per square. On
 * hexes it counts what the size holds as the Size row's words do
 * (grid/words.ts `sizeWords`): "250 by 250 ft: 50 hexes across and 57 rows
 * down", or on Hex columns "57 columns across and 50 hexes down" (2.1).
 */
export function sizeLine(w: number, h: number, feetPerCell: number, grid: GridKind = "squares"): string {
  if (!isHexGrid(grid)) return `${w} × ${h} squares (${w * feetPerCell} by ${h * feetPerCell} ft)`;
  const span = sceneHexSpan(hexGridOf(grid), { w, h });
  const counts = grid === "hexRows" ? `${span.cols} hexes across and ${span.rows} rows down` : `${span.cols} columns across and ${span.rows} hexes down`;
  return `${w * feetPerCell} by ${h * feetPerCell} ft: ${counts}`;
}

/** The cap is what the size could take at best. A Wide, Sparse or small map fits fewer, and the status line says how many did (DG-ROOMS-CAP). A wing's is its area's (phase 3, 3.3). */
export function roomsHint(max: number, wing = false): string {
  return `2 to ${max} ${wing ? "in this area" : "on this size"}. Fewer fit when the layout is tight.`;
}

/** Heights' value in words, for the Rooms asked: "Flat", or "About 3 rooms of 12 off flat ground". */
export function heightsWords(share: number, rooms: number): string {
  const n = raisedCount(share, rooms);
  return share <= 0 ? "Flat" : `About ${n} ${n === 1 ? "room" : "rooms"} of ${rooms} off flat ground`;
}

/** Traps' value in words, for the Rooms asked: "No traps", or "About 4 traps". */
export function trapsWords(twelfths: number, rooms: number): string {
  const n = trapCount(twelfths, rooms);
  return n === 0 ? "No traps" : `About ${n} ${n === 1 ? "trap" : "traps"}`;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The foot's status: "12 rooms (1 secret), 18 doors (3 locked, 2 secret), 4 traps." A count of none says
 * so rather than "(0 locked)", and a dungeon with no doors, a cave, says "no doors".
 */
export function statusLine(s: Summary): string {
  const rooms = counted(s.rooms, "room", "rooms") + (s.secretRooms > 0 ? ` (${s.secretRooms} secret)` : "");
  const kinds = [...(s.locked > 0 ? [`${s.locked} locked`] : []), ...(s.secretDoors > 0 ? [`${s.secretDoors} secret`] : [])];
  const doors = s.doors === 0 ? "no doors" : counted(s.doors, "door", "doors") + (kinds.length > 0 ? ` (${kinds.join(", ")})` : "");
  const traps = s.traps === 0 ? "no traps" : counted(s.traps, "trap", "traps");
  // A stocked dungeon counts its creatures and the rooms that hold them. At None the line is as it always was.
  const monsters = s.monsters === undefined ? "" : s.monsters === 0 ? ", no monsters" : `, ${counted(s.monsters, "monster", "monsters")} in ${counted(s.stockedRooms ?? 0, "room", "rooms")}`;
  return `${rooms}, ${doors}, ${traps}${monsters}.`;
}

/** Said when fewer rooms fit than were asked for, else null. On hexes the walls are what bind (phase 3, 7). */
export function fitLine(s: Pick<Summary, "rooms" | "asked">, grid: GridKind = "squares"): string | null {
  if (s.rooms >= s.asked) return null;
  return isHexGrid(grid)
    ? `Fit ${s.rooms} of ${s.asked} rooms. On hexes every wall is a wall line, so fewer fit: Sparse or Narrow fits more.`
    : `Fit ${s.rooms} of ${s.asked} rooms. A larger size or fewer rooms fits them all.`;
}

/** Why no hex dungeon came (phase 3, 2.5 and 7): under two rooms with walls to spare, or past the plans a fit tries. */
export const FIT_NONE_HEX = "Could not fit two rooms with walls to spare on hexes. Try fewer rooms or Sparse.";
export const TOO_MANY_HEX = "Too many rooms for the walls a hex scene holds. Try fewer rooms or Sparse.";

export function makingLine(answered: number, of: number): string {
  return `Making the dungeon… ${answered} of ${of}`;
}

export type Side = "west" | "north" | "east" | "south";

/** The scene edge nearest the entrance room, ties going west, north, east, south, as the generator picks it. On hexes `entrance` is the room's box in the scene (marks.ts `roomBox`). */
export function entranceSide(plan: Pick<DungeonPlan, "w" | "h" | "entrance">): Side {
  const e = plan.entrance;
  const gaps: [Side, number][] = [
    ["west", e.x],
    ["north", e.y],
    ["east", plan.w - (e.x + e.w)],
    ["south", plan.h - (e.y + e.h)],
  ];
  let best = gaps[0]!;
  for (const g of gaps) if (g[1] < best[1]) best = g;
  return best[0];
}

/** The preview image's name: "Preview of the dungeon: 12 rooms, 2 secret doors, 3 lit rooms, entrance on the west side." */
export function previewName(s: Pick<Summary, "rooms"> & Partial<Pick<Summary, "secretDoors" | "lights" | "monsters">>, side: Side): string {
  const secret = s.secretDoors ? [counted(s.secretDoors, "secret door", "secret doors")] : [];
  const lit = s.lights ? [counted(s.lights, "lit room", "lit rooms")] : [];
  const monsters = s.monsters ? [counted(s.monsters, "monster", "monsters")] : [];
  return `Preview of the dungeon: ${[counted(s.rooms, "room", "rooms"), ...secret, ...lit, ...monsters].join(", ")}, entrance on the ${side} side.`;
}

/**
 * How Make ended, in one sentence (4.4). `opened` says whether the new
 * scene is on screen. Delete of the players' scene asks first, since it
 * leaves them with no map (client/features/scenes/afterDelete.ts
 * leavesPlayers), and Undo setup is refused for it (shared/permissions.ts).
 * Undo setup's step may also be split or gone (a co-DM's edit, a restart),
 * so every way back says Delete asks first there and only Delete is
 * promised.
 */
export function outcomeText(outcome: DungeonOutcome, name: string, opened: boolean): { text: string; tone: "info" | "error" } {
  const goTo = opened ? "" : " Open it from the Scenes panel.";
  switch (outcome.k) {
    case "complete":
      return outcome.checked
        ? { text: `The connection dropped while making ${name}, but it is complete. Delete in the scene's menu always takes it back, asking first while the players are on it, and Undo setup in Setup history usually does once the players are on another scene.${goTo}`, tone: "info" }
        : { text: `Made ${name}.${goTo}`, tone: "info" };
    case "none":
      return { text: outcome.lost ? "The connection dropped, and no scene was made. Try again." : "The server refused the dungeon, so no scene was made.", tone: "error" };
    case "partial":
      return {
        text: `The server refused part of ${name}, so it may be missing rooms, doors or traps. Delete in the scene's menu takes it back, asking first while the players are on it, and so does Undo setup in Setup history once the players are on another scene.${goTo}`,
        tone: "error",
      };
    case "unconfirmed":
      return {
        text: `The connection dropped while making ${name}, and it could not be confirmed complete. To start again, Delete it from the scene's menu, which asks first while the players are on it.${goTo}`,
        tone: "error",
      };
  }
}

/*
 * Generate a dungeon aimed at a floor (docs/design/design-v1-floors.md
 * phase 3, 3.7): its title, Make's words, the key page's name and how Make
 * ended, each naming the floor by the name the server stored, which the
 * reducer numbers while taken ("Crypt 2").
 */

/** "Generate a dungeon below Ground floor". */
export function floorTitle(side: "above" | "below", besideName: string): string {
  return `Generate a dungeon ${side} ${besideName}`;
}

export const MAKE_SCENE = "Make the scene";
export const MAKE_FLOOR = "Make the floor";
/** Hide's busy words while the floor's create waits for its answer, when no close may split the floor from its key (D-261110-183). */
export const MAKING_FLOOR = "Making the floor…";

/** The key page's name for a floor, "Tower · Crypt 2", which keyTitle makes "Tower · Crypt 2 key". */
export function floorKeyName(sceneName: string, floorName: string): string {
  return `${sceneName} · ${floorName}`;
}

/**
 * How Make of a floor ended, in one sentence. `name` is the floor's stored
 * name, `scene` its scene's, and `opened` whether the floor is on screen.
 * Remove floor on its page always takes it back. Undo setup does too,
 * though a lost answer may leave its key page a step of its own.
 */
export function floorOutcomeText(outcome: DungeonOutcome, name: string, scene: string, opened: boolean): { text: string; tone: "info" | "error" } {
  const goTo = opened ? "" : openFloorLine(scene, name);
  const back = "Undo setup in Setup history takes it back, its key page perhaps as a step of its own, and Remove floor on its page always does.";
  switch (outcome.k) {
    case "complete":
      return outcome.checked ? { text: `The connection dropped while making ${name}, but it is complete. ${back}${goTo}`, tone: "info" } : { text: `Added ${name} to ${scene}.${goTo}`, tone: "info" };
    case "none":
      return { text: outcome.lost ? "The connection dropped, and no floor was added. Try again." : "The server refused the dungeon, so no floor was added.", tone: "error" };
    case "partial":
      return { text: `The server refused part of ${name}, so it may be missing rooms, doors or traps. ${back}${goTo}`, tone: "error" };
    case "unconfirmed":
      return { text: `The connection dropped while making ${name}, and it could not be confirmed complete. To start again, remove it with Remove floor on its page.${goTo}`, tone: "error" };
  }
}

/*
 * Per-room edits (docs/design: dungeon generator phase 3, 4.1 to 4.4): the
 * room panel's rows, the reports a pin leaves on the next plan, and the
 * edits line under the seed.
 */

export const EDIT_ROOMS = "Edit rooms";
export const HEIGHT_HELP = "Each door gets a straight flight of stairs. Where they do not fit, the room stays flat.";
export const ENTRANCE_FLAT = "The entrance room stays flat.";
export const NO_TRAP_FITS = "No trap fits in this room.";
export const ROOM_GONE = { title: "Room gone", line: "This room is gone in this dungeon." } as const;
/** An edit that took a hex plan past its wall budget, undone (4.2). */
export const EDIT_OVER_WALLS = "That change needs more walls than a hex scene holds, so it was undone.";
export const EDITS_DROPPED = "Room edits dropped.";
/** A wing's base posted again with other geometry (4.2): no Bring them back. */
export const EDITS_GONE = "Room edits dropped: the scene changed under the wing.";
export const BRING_BACK = "Bring them back";
export const DROP_EDITS = "Drop edits";

/** "Room 3", or for a wing "Room W3", as its ghost numbers its rooms. */
export function roomTitle(n: number, wing = false): string {
  return `Room ${wing ? "W" : ""}${n}`;
}

const SIDE_NAMES = { n: "North", e: "East", s: "South", w: "West" } as const;

/** A door's row name: "West, to room 1" ("to room W1" in a wing), or "South, to the way in" for the entrance's way out of the map or a wing's join. */
export function doorName(side: keyof typeof SIDE_NAMES, to: number | "edge" | "join", wing = false): string {
  return `${SIDE_NAMES[side]}, to ${typeof to === "number" ? `room ${wing ? "W" : ""}${to}` : "the way in"}`;
}

/** The seed row's line while edits stand: "Edited: 1 room. The seed alone makes this dungeon without your edits." */
export function editedLine(rooms: number): string {
  return `Edited: ${rooms} ${rooms === 1 ? "room" : "rooms"}. The seed alone makes this dungeon without your edits.`;
}

/** The rows a report stands under in the room panel. */
export type ReportRow = "height" | "doors" | "trap" | "dressing" | "lit" | "monsters" | "other";

/**
 * Which row each report belongs under, by what it speaks of (4.1): stairs
 * under Height, doors under Doors, traps under Trap, stamps under Dressing
 * and lights under Lit. A room gone and the wall budget's undo stand under
 * every row.
 */
export function reportRow(line: string): ReportRow {
  if (line.startsWith("No room for its stairs")) return "height";
  if (/\bmonsters\b/.test(line)) return "monsters";
  if (/\bdoor\b/.test(line)) return "doors";
  if (/\btrap\b/.test(line)) return "trap";
  if (/\bstamp\b/.test(line)) return "dressing";
  if (/\blight\b/.test(line)) return "lit";
  return "other";
}

export function reportsByRow(lines: readonly string[]): Record<ReportRow, string[]> {
  const out: Record<ReportRow, string[]> = { height: [], doors: [], trap: [], dressing: [], lit: [], monsters: [], other: [] };
  for (const line of lines) out[reportRow(line)].push(line);
  return out;
}

/** The preview's name with a room picked: "Room 3 selected." after the dungeon's own (7). */
export function selectedName(name: string, n: number | null): string {
  return n === null ? name : `${name} Room ${n} selected.`;
}
