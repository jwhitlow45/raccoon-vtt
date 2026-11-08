import type { ClientOp } from "#shared/protocol.ts";
import { TRINKETS } from "#shared/srd/trinkets.ts";
import { BAND_NAMES } from "../traps/rules.ts";
import { DAIS_RISE } from "./heights.ts";
import { blockPlaceholder, PAGE_PLACEHOLDER, pinPlaceholder } from "./ops.ts";
import type { DungeonPlan, KeyDoor, KeyRoom } from "./plan.ts";
import { CHOICE_NAMES, HEIGHT_PRESETS, LIT_PRESETS, SECRET_PRESETS, SIZE_SIDES, TRAP_PRESETS, type DungeonSettings } from "./settings.ts";
import { sizeLine } from "./words.ts";

/*
 * The DM key (phase 2, 5.6 and section 6): a DM-only journal page in
 * "Dungeon keys" describing each room by number, and a DM-only numbered pin
 * in each room linked to it. Its lengths are in the room's feet per square,
 * and it never holds the seed (D-261102-023).
 */

/** What the key needs of the room and the dialog: the scene's name, the DM's color for the pins, and the feet per square its lengths read in. */
export type KeyInput = { name: string; color: string; feetPerCell: number };

/** The folder the key's page is filed in. */
export const KEY_FOLDER = "Dungeon keys";

/** The longest name kept whole before " key", so the title fits a page title's 80 characters (D-261107-266). */
const NAME_UNITS = 76;
/** How far back from the cut a space is looked for, so the title ends on a whole word where one is near. */
const WORD_BACK = 20;

/**
 * The page's title: the name cut to at most 76 UTF-16 units, one less
 * where the cut would split a surrogate pair, back to a space where one
 * falls in the last 20, trimmed, then " key", so it fits the 80-character
 * title whole and never holds half a character (D-261107-266).
 */
export function keyTitle(name: string): string {
  let base = name.trim();
  if (base.length > NAME_UNITS) {
    let cut = NAME_UNITS;
    const before = base.charCodeAt(cut - 1);
    if (before >= 0xd800 && before <= 0xdbff) cut--;
    const space = base.lastIndexOf(" ", cut);
    if (space >= cut - WORD_BACK && space > 0) cut = space;
    base = base.slice(0, cut).trim();
  }
  return `${base || "Dungeon"} key`;
}

const SIDE_WORDS: Record<KeyDoor["side"], string> = { n: "north", e: "east", s: "south", w: "west" };

/** A slider's value as the "Made with" line says it: its mark's name, or the value itself off the marks. */
function onMarks(marks: Readonly<Record<string, number>>, value: number, off: (v: number) => string): string {
  const mark = Object.entries(marks).find(([, v]) => v === value);
  return mark ? mark[0] : off(value);
}

/** A share in twelfths of the rooms, as the Traps and Secret doors sliders hold it. */
const twelfths = (v: number) => `${v} in 12 rooms`;
const percent = (v: number) => `${v}%`;

/** The Size choice the sides came from: a preset's name, or Custom. */
function sizeName(w: number, h: number): string {
  const preset = (Object.entries(SIZE_SIDES) as [keyof typeof SIZE_SIDES, number][]).find(([, side]) => side === w && side === h);
  return preset ? `${preset[0][0]!.toUpperCase()}${preset[0].slice(1)}` : "Custom";
}

/**
 * "Made with: Crypt, Medium, Normal, Bending, Narrow, extra ways around,
 * dead ends, Heights Some, Traps Few at levels 1–4, Secret doors Few, Lit
 * rooms Few, Dressing Some, 5 ft squares.", every choice that shapes the
 * dungeon but the seed, so the DM can make another like it.
 */
export function madeWith(s: DungeonSettings, feetPerCell: number): string {
  const traps = onMarks(TRAP_PRESETS, s.traps, twelfths);
  const parts = [
    CHOICE_NAMES.theme[s.theme],
    sizeName(s.w, s.h),
    CHOICE_NAMES.density[s.density],
    CHOICE_NAMES.corridors[s.corridors],
    s.wide ? "Wide" : "Narrow",
    ...(s.loops ? ["extra ways around"] : []),
    ...(s.deadEnds ? ["dead ends"] : []),
    `Heights ${onMarks(HEIGHT_PRESETS, s.heights, percent)}`,
    s.traps > 0 ? `Traps ${traps} at ${BAND_NAMES[s.band].toLowerCase()}` : `Traps ${traps}`,
    `Secret doors ${onMarks(SECRET_PRESETS, s.secrets, twelfths)}`,
    `Lit rooms ${onMarks(LIT_PRESETS, s.lit, percent)}`,
    `Dressing ${CHOICE_NAMES.dressing[s.dressing]}`,
    `${feetPerCell} ft squares`,
  ];
  return `Made with: ${parts.join(", ")}.`;
}

/** The page's first block: what the dungeon is, how to read the key, how secret doors work when it has any, and the choices it was made with. */
export function keyIntro(plan: DungeonPlan, settings: DungeonSettings, feetPerCell: number): string {
  const n = plan.key?.length ?? plan.rooms.length;
  const paragraphs = [`A generated ${CHOICE_NAMES.theme[plan.theme]} of ${n} ${n === 1 ? "room" : "rooms"} on ${sizeLine(plan.w, plan.h, feetPerCell)}. Room 1 is the way in. Each room's pin carries its number.`];
  if (plan.doors.some((d) => d.state === "secret")) {
    paragraphs.push("Players see a secret door as plain wall until you mark it found: tap it with the Select tool. The Search action finds one with a DC 15 (Medium) Wisdom (Perception) check.");
  }
  paragraphs.push(madeWith(settings, feetPerCell));
  return paragraphs.join("\n\n");
}

function doorWords(d: KeyDoor): string {
  const to = d.to === "edge" ? "the stairs at the map's edge" : String(d.to);
  const state = d.state === "locked" ? " (locked)" : d.state === "secret" ? " (secret)" : "";
  return `${SIDE_WORDS[d.side]} to ${to}${state}`;
}

/** "a fire pit" from the light's label "Fire pit". */
function withArticle(label: string): string {
  const lower = `${label[0]?.toLowerCase() ?? ""}${label.slice(1)}`;
  return /^[aeiou]/.test(lower) ? `an ${lower}` : `a ${lower}`;
}

/**
 * One room's block: "**3.** 6 × 8 squares (30 by 40 ft), 10 ft up. Doors:
 * north to 1 (locked), east to 5 (secret). A dais 5 ft up. Lit by a
 * candelabra. Trap: Spiked Pit. Trinket: <the SRD line>." The entrance
 * starts "The way in," and a secret room "A secret room,". A cave's
 * doorways are openings. A part with nothing to say is left out.
 */
export function roomLine(plan: DungeonPlan, k: KeyRoom, feetPerCell: number): string {
  const room = plan.rooms[k.room];
  if (!room) throw new Error(`the key names room ${k.room}, which the plan does not hold`);
  const lead = room.entrance ? "The way in, " : k.secret ? "A secret room, " : "";
  const ground = room.ground > 0 ? `, ${room.ground} ft up` : room.ground < 0 ? `, ${-room.ground} ft down` : "";
  const parts = [`**${k.n}.** ${lead}${room.w} × ${room.h} squares (${room.w * feetPerCell} by ${room.h * feetPerCell} ft)${ground}.`];
  if (k.doors.length > 0) parts.push(`${plan.theme === "cave" ? "Openings" : "Doors"}: ${k.doors.map(doorWords).join(", ")}.`);
  if (k.dais) parts.push(`A dais ${DAIS_RISE} ft up.`);
  if (k.pit) parts.push("A pit.");
  if (k.cistern) parts.push("A cistern.");
  if (k.light) parts.push(`Lit by ${withArticle(k.light)}.`);
  if (k.traps.length > 0) parts.push(`${k.traps.length === 1 ? "Trap" : "Traps"}: ${k.traps.join(", ")}.`);
  const trinket = TRINKETS[k.trinket];
  if (trinket !== undefined) parts.push(`Trinket: ${trinket}.`);
  return parts.join(" ");
}

/**
 * The key's `journal.create` and one `pin.put` per room, or none with DM
 * key off. The page is the DM's alone and so is every pin, which stands in
 * the middle of its room's pin square in the DM's color, labeled with the
 * room's number and linked to the page.
 */
export function keyOps(plan: DungeonPlan, settings: DungeonSettings, key: KeyInput, sceneId: string): ClientOp[] {
  if (!settings.key || plan.key === null) return [];
  const rooms = plan.key;
  const blocks = [keyIntro(plan, settings, key.feetPerCell), ...rooms.map((k) => roomLine(plan, k, key.feetPerCell))].map((text, i) => ({ id: blockPlaceholder(i), text }));
  const page: ClientOp = { t: "journal.create", page: { id: PAGE_PLACEHOLDER, title: keyTitle(key.name), folder: KEY_FOLDER, access: "dm", blocks } };
  const pins = rooms.map((k, i): ClientOp => {
    const [x, y] = plan.rooms[k.room]!.pin;
    return { t: "pin.put", pin: { id: pinPlaceholder(i), sceneId, x: x + 0.5, y: y + 0.5, label: String(k.n), pageId: PAGE_PLACEHOLDER, color: key.color, visibility: "dm" } };
  });
  return [page, ...pins];
}
