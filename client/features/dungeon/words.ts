import { playersSeeFields, withPlayersSee, type NewScenePick, type SceneInput } from "../scenes/create.ts";
import type { DungeonPlan } from "./plan.ts";
import { versionChar } from "./seed.ts";
import { litCount, raisedCount, secretCount, trapCount, type Theme } from "./settings.ts";
import type { DungeonOutcome } from "./send.ts";
import type { Summary } from "./client.ts";

/**
 * Every sentence the Generate a dungeon dialog shows
 * (docs/design/design-v1-dungeon-generator.md 4.1 to 4.4), apart from React so
 * the tests read them as the DM does.
 */

export const GENERATE_LEAD = "Or start from a generated dungeon";
export const HEX_NOTE = "Generated dungeons are squares for now. Pick Squares above to make one.";

export const THEME_HELP = {
  dungeon: "Stone and wood rooms, closed and locked doors, rubble and pits.",
  crypt: "Stone halls with pillars, more locked doors.",
  cave: "Rough caverns of cave floor joined by tunnels, with no doors. The Fog tool's Builder room then reveals every cave the tunnels join.",
  mine: "Dirt chambers and tunnels, wooden doors, rubble from old collapses and open shafts.",
  sewer: "Stone halls, cisterns and corridors that run with water. Wide corridors keep a dry walkway beside the channel.",
} as const;
export const DENSITY_HELP = "How much of the map the rooms fill.";
export const WIDE_HELP = "Wide corridors and their doorways are 2 squares across, with double doors, so Large creatures walk them without squeezing once the doors are open.";
export const LOOPS_HELP = "Adds loops, so the way back is not always the way in.";
export const HEIGHTS_HELP = "Rooms raised or sunk 5 or 10 ft, with stairs to them. The entrance room stays flat.";
export const TRAPS_HELP = "Example traps from the SRD. Players see one only once it is found.";
/** Party level picks the SRD's column for each example trap, as the Trap tool's does: nothing else in the dungeon reads it. */
export const PARTY_LEVEL_HELP = "How strong the traps are: their save DCs, damage and pit depths follow the SRD for a party of these levels.";
export const DEAD_ENDS_HELP = "Adds corridors that end in rock, so not every dead end hides a secret door.";
export const SECRETS_HELP = "Some lead to a secret room. Players see plain wall there until it is found.";
export const SECRETS_CAVE = "Caves have no doors, so none are secret.";
/** While the landing holds secret doors at None (ops.ts `SECRET_DOORS_HELD`), until drules lane B lets a hidden one reach players as plain wall. */
export const SECRETS_LATER = "Secret doors come in a later version of the app.";
export const DRESSING_HELP = "Furniture, bones and clutter from the shipped stamps, kept off the ways through each room.";
export const KEY_HELP = "A DM-only journal page describing each room by number, and a DM-only numbered pin in each room.";
export const KEY_FULL = "The journal is full, so there is no room for a key.";
export const SEED_HELP = "A seed makes the same dungeon again on this version of the app, at the same feet per square.";
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

/** "30 × 30 squares (150 by 150 ft)", in the room's feet per square. */
export function sizeLine(w: number, h: number, feetPerCell: number): string {
  return `${w} × ${h} squares (${w * feetPerCell} by ${h * feetPerCell} ft)`;
}

/** The cap is what the size could take at best. A Wide, Sparse or small map fits fewer, and the status line says how many did (DG-ROOMS-CAP). */
export function roomsHint(max: number): string {
  return `2 to ${max} on this size. Fewer fit when the layout is tight.`;
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
  return `${rooms}, ${doors}, ${traps}.`;
}

/** Said when fewer rooms fit than were asked for, else null. */
export function fitLine(s: Pick<Summary, "rooms" | "asked">): string | null {
  return s.rooms < s.asked ? `Fit ${s.rooms} of ${s.asked} rooms. A larger size or fewer rooms fits them all.` : null;
}

export function makingLine(answered: number, of: number): string {
  return `Making the dungeon… ${answered} of ${of}`;
}

export type Side = "west" | "north" | "east" | "south";

/** The scene edge nearest the entrance room, ties going west, north, east, south, as the generator picks it. */
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
export function previewName(s: Pick<Summary, "rooms"> & Partial<Pick<Summary, "secretDoors" | "lights">>, side: Side): string {
  const secret = s.secretDoors ? [counted(s.secretDoors, "secret door", "secret doors")] : [];
  const lit = s.lights ? [counted(s.lights, "lit room", "lit rooms")] : [];
  return `Preview of the dungeon: ${[counted(s.rooms, "room", "rooms"), ...secret, ...lit].join(", ")}, entrance on the ${side} side.`;
}

/**
 * How Make ended, in one sentence (4.4). `opened` says whether the new
 * scene is on screen. Delete and Undo setup are both refused for the
 * players' scene (shared/permissions.ts), and Undo setup's step may be
 * split or gone (a co-DM's edit, a restart), so every way back says to
 * move the players and only Delete is promised.
 */
export function outcomeText(outcome: DungeonOutcome, name: string, opened: boolean): { text: string; tone: "info" | "error" } {
  const goTo = opened ? "" : " Open it from the Scenes panel.";
  switch (outcome.k) {
    case "complete":
      return outcome.checked
        ? { text: `The connection dropped while making ${name}, but it is complete. Undo setup in Setup history usually takes it back, and Delete in the scene's menu always does, once the players are on another scene.${goTo}`, tone: "info" }
        : { text: `Made ${name}.${goTo}`, tone: "info" };
    case "none":
      return { text: outcome.lost ? "The connection dropped, and no scene was made. Try again." : "The server refused the dungeon, so no scene was made.", tone: "error" };
    case "partial":
      return {
        text: `The server refused part of ${name}, so it may be missing rooms, doors or traps. Once the players are on another scene, Undo setup in Setup history or Delete in the scene's menu takes it back.${goTo}`,
        tone: "error",
      };
    case "unconfirmed":
      return {
        text: `The connection dropped while making ${name}, and it could not be confirmed complete. To start again, Delete it from the scene's menu once the players are on another scene.${goTo}`,
        tone: "error",
      };
  }
}
