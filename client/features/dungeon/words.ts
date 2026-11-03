import { playersSeeFields, type NewScenePick } from "../scenes/create.ts";
import type { DungeonPlan } from "./plan.ts";
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
} as const;
export const DENSITY_HELP = "How much of the map the rooms fill.";
export const WIDE_HELP = "Wide corridors and their doorways are 2 squares across, with double doors, so Large creatures walk them without squeezing once the doors are open.";
export const LOOPS_HELP = "Adds loops, so the way back is not always the way in.";
export const HEIGHTS_HELP = "Raises or sinks a few rooms, with stairs to them.";
export const TRAPS_HELP = "Example traps from the SRD. Players see one only once it is found.";
export const NO_FOG_WARNING = "Players see this scene without fog, so every room shows at once. Explore or Reveal by hand keeps rooms dark until found.";

/** The warning above the foot when the form's Players see leaves fog off (Everything, or Like a scene without fog), else null. */
export function fogLine(pick: NewScenePick): string | null {
  return playersSeeFields(pick).fogEnabled ? null : NO_FOG_WARNING;
}

export const DRAWING = "Drawing the dungeon…";
export const WAITING = "Waiting for the server…";
export const FIT_NONE = "Could not fit two rooms. Try a larger size, fewer rooms or Sparse.";
export const NOT_MADE = "This dungeon could not be made. Reroll for another.";
export const SEED_BAD = "A seed is 16 letters and digits, like 1K7Q-H2MX-A9F3-TWQ5.";
export const SEED_OTHER_VERSION = "This seed is from another version of the generator, so it makes a different dungeon now.";

/** "30 × 30 squares (150 by 150 ft)", in the room's feet per square. */
export function sizeLine(w: number, h: number, feetPerCell: number): string {
  return `${w} × ${h} squares (${w * feetPerCell} by ${h * feetPerCell} ft)`;
}

export function roomsHint(max: number): string {
  return `2 to ${max} on this size`;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The foot's status: "12 rooms, 18 doors (3 locked), 4 traps." A count of none says so rather than "(0 locked)". */
export function statusLine(s: Summary): string {
  const doors = counted(s.doors, "door", "doors") + (s.locked > 0 ? ` (${s.locked} locked)` : "");
  const traps = s.traps === 0 ? "no traps" : counted(s.traps, "trap", "traps");
  return `${counted(s.rooms, "room", "rooms")}, ${doors}, ${traps}.`;
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

/** The preview image's name: "Preview of the dungeon: 12 rooms, entrance on the west side." */
export function previewName(s: Pick<Summary, "rooms">, side: Side): string {
  return `Preview of the dungeon: ${counted(s.rooms, "room", "rooms")}, entrance on the ${side} side.`;
}

/**
 * How Make ended, in one sentence (4.4). `opened` says whether the new
 * scene is on screen. Delete is refused for the players' scene
 * (shared/permissions.ts), so every way back by Delete says to move them.
 */
export function outcomeText(outcome: DungeonOutcome, name: string, opened: boolean): { text: string; tone: "info" | "error" } {
  const goTo = opened ? "" : " Open it from the Scenes panel.";
  switch (outcome.k) {
    case "complete":
      return outcome.checked
        ? { text: `The connection dropped while making ${name}, but it is complete. Undo setup in Setup history takes it back.${goTo}`, tone: "info" }
        : { text: `Made ${name}.${goTo}`, tone: "info" };
    case "none":
      return { text: outcome.lost ? "The connection dropped, and no scene was made. Try again." : "The server refused the dungeon, so no scene was made.", tone: "error" };
    case "partial":
      return {
        text: `The server refused part of ${name}, so it may be missing rooms, doors or traps. Use Undo setup in Setup history, or Delete it from the scene's menu once the players are on another scene.${goTo}`,
        tone: "error",
      };
    case "unconfirmed":
      return {
        text: `The connection dropped while making ${name}, and it could not be confirmed complete. To start again, Delete it from the scene's menu once the players are on another scene.${goTo}`,
        tone: "error",
      };
  }
}
