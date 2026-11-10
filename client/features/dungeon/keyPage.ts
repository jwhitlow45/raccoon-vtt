import type { Pin } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { TRINKETS } from "#shared/srd/trinkets.ts";
import { BAND_NAMES } from "../traps/rules.ts";
import { DAIS_RISE } from "./heights.ts";
import { latticeFor } from "./lattice.ts";
import { blockPlaceholder, PAGE_PLACEHOLDER, pinPlaceholder } from "./ops.ts";
import type { DungeonPlan, KeyCorridorTrap, KeyDoor, KeyRoom } from "./plan.ts";
import { CHOICE_NAMES, HEIGHT_PRESETS, LIT_PRESETS, SECRET_PRESETS, SIZE_SIDES, TRAP_PRESETS, type DungeonSettings } from "./settings.ts";
import { THEME_SPECS } from "./themes.ts";
import { sizeLine } from "./words.ts";

/*
 * The DM key (phase 2, 5.6 and section 6): a DM-only journal page in
 * "Dungeon keys" describing each room by number, and a DM-only numbered pin
 * in each room linked to it. Its lengths are in the room's feet per square,
 * and it never holds the seed (D-261102-023).
 */

/**
 * What the key needs of the room and the dialog: the scene's name, the DM's
 * color for the pins, and the feet per square its lengths read in. A wing's
 * key (phase 3, 3.3, D-261110-095 and 165) also takes the scene's highest W
 * pin, its pages' titles, so its own is numbered while one is taken, and
 * the pins the scene has room for.
 */
export type KeyInput = { name: string; color: string; feetPerCell: number; wing?: WingKey };
export type WingKey = { from: number; titles: readonly string[]; pins: number };

/** The folder the key's page is filed in. */
export const KEY_FOLDER = "Dungeon keys";

/** A page title's length, which the name and " key" fit whole (D-261107-266). */
const TITLE_UNITS = 80;
/** How far back from the cut a space is looked for, so the title ends on a whole word where one is near. */
const WORD_BACK = 20;

/**
 * The page's title: the name cut to at most 76 UTF-16 units, one less
 * where the cut would split a surrogate pair, back to a space where one
 * falls in the last 20, trimmed, then " key", so it fits the 80-character
 * title whole and never holds half a character (D-261107-266).
 */
export function keyTitle(name: string, suffix = " key"): string {
  let base = name.trim();
  const units = TITLE_UNITS - suffix.length;
  if (base.length > units) {
    let cut = units;
    const before = base.charCodeAt(cut - 1);
    if (before >= 0xd800 && before <= 0xdbff) cut--;
    const space = base.lastIndexOf(" ", cut);
    if (space >= cut - WORD_BACK && space > 0) cut = space;
    base = base.slice(0, cut).trim();
  }
  return `${base || "Dungeon"}${suffix}`;
}

/**
 * A wing key's title (phase 3, 3.3): "<scene name> wing key", numbered "2",
 * "3" and on while a page already has the title, each cut to fit 80
 * characters as `keyTitle` cuts.
 */
export function wingKeyTitle(name: string, titles: readonly string[]): string {
  const taken = new Set(titles);
  for (let n = 1; ; n++) {
    const title = keyTitle(name, n === 1 ? " wing key" : ` wing key ${n}`);
    if (!taken.has(title)) return title;
  }
}

/** The scene's highest W pin number, 0 with none, which a new wing's pins number on from (D-261110-165). */
export function highestWingPin(pins: Readonly<Record<string, Pin | undefined>>, sceneId: string): number {
  let most = 0;
  for (const p of Object.values(pins)) {
    const n = p && p.sceneId === sceneId ? /^W([1-9][0-9]*)$/.exec(p.label ?? "")?.[1] : undefined;
    if (n !== undefined) most = Math.max(most, Number(n));
  }
  return most;
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
    // The held pick stays in the settings on a Cave, which has no doors to hold it.
    `Secret doors ${THEME_SPECS[s.theme].doors ? onMarks(SECRET_PRESETS, s.secrets, twelfths) : "None"}`,
    `Lit rooms ${onMarks(LIT_PRESETS, s.lit, percent)}`,
    `Dressing ${CHOICE_NAMES.dressing[s.dressing]}`,
    `${feetPerCell} ft squares`,
  ];
  return `Made with: ${parts.join(", ")}.`;
}

/** How a room is named in the key and on its pin: its number, and on a wing W and its number from the scene's highest W pin. */
function label(n: number, wing: WingKey | undefined): string {
  return wing ? `W${wing.from + n}` : String(n);
}

/** A hex scene's size as the size line counts it (phase 3, 2.1): "250 by 250 ft: 50 hexes across and 57 rows down". */
function hexSize(plan: DungeonPlan, feetPerCell: number): string {
  const L = latticeFor(plan.grid!, { w: plan.w, h: plan.h });
  const counts = plan.grid === "hexRows" ? `${L.W} hexes across and ${L.H} rows down` : `${L.H} columns across and ${L.W} hexes down`;
  return `${plan.w * feetPerCell} by ${plan.h * feetPerCell} ft: ${counts}`;
}

/** The page's first block: what the dungeon is, how to read the key, how secret doors work when it has any, and the choices it was made with. */
export function keyIntro(plan: DungeonPlan, settings: DungeonSettings, feetPerCell: number, wing?: WingKey): string {
  const n = plan.key?.length ?? plan.rooms.length;
  const rooms = `${n} ${n === 1 ? "room" : "rooms"}`;
  const theme = CHOICE_NAMES.theme[plan.theme];
  const paragraphs = [
    wing
      ? `A generated ${theme} wing of ${rooms}. Room ${label(1, wing)} joins the scene. Each room's pin carries its number.`
      : `A generated ${theme} of ${rooms} on ${plan.grid ? hexSize(plan, feetPerCell) : sizeLine(plan.w, plan.h, feetPerCell)}. Room 1 is the way in. Each room's pin carries its number.`,
  ];
  if (plan.doors.some((d) => d.state === "secret")) {
    paragraphs.push("Players see a secret door as plain wall until you mark it found: tap it with the Select tool. The Search action finds one with a DC 15 (Medium) Wisdom (Perception) check.");
  }
  paragraphs.push(madeWith(settings, feetPerCell));
  return paragraphs.join("\n\n");
}

function doorWords(d: KeyDoor, wing: WingKey | undefined): string {
  const to = d.to === "edge" ? "the stairs at the map's edge" : d.to === "join" ? "the room it joins" : label(d.to, wing);
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
export function roomLine(plan: DungeonPlan, k: KeyRoom, feetPerCell: number, wing?: WingKey): string {
  const room = plan.rooms[k.room];
  if (!room) throw new Error(`the key names room ${k.room}, which the plan does not hold`);
  const lead = room.entrance ? (wing ? "Joined to the scene, " : "The way in, ") : k.secret ? "A secret room, " : "";
  const ground = room.ground > 0 ? `, ${room.ground} ft up` : room.ground < 0 ? `, ${-room.ground} ft down` : "";
  // On hexes a room is a block of hexes across a run of rows, the rows lattice mirrored on Hex columns.
  const size =
    plan.grid === "hexRows"
      ? `${room.w} hexes across and ${room.h} rows down`
      : plan.grid === "hexColumns"
        ? `${room.h} columns across and ${room.w} hexes down`
        : `${room.w} × ${room.h} squares (${room.w * feetPerCell} by ${room.h * feetPerCell} ft)`;
  const parts = [`**${label(k.n, wing)}.** ${lead}${size}${ground}.`];
  if (k.doors.length > 0) parts.push(`${plan.theme === "cave" ? "Openings" : "Doors"}: ${k.doors.map((d) => doorWords(d, wing)).join(", ")}.`);
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
 * The key's closing part for the traps no room holds: "**In the corridors.**
 * Collapsing Roof between 5 and 6, Poisoned Darts between 1 and the stairs at
 * the map's edge." Left out when the plan has none (LP33-B-KEY-1).
 */
export function corridorLine(plan: DungeonPlan, wing?: WingKey): string | null {
  const traps = plan.corridorTraps ?? [];
  if (traps.length === 0) return null;
  const where = (t: KeyCorridorTrap) => {
    if (t.between === "deadEnd") return " in a dead end";
    if (t.between === null) return "";
    const [a, b] = t.between;
    return ` between ${label(a, wing)} and ${b === "edge" ? (wing ? "the room it joins" : "the stairs at the map's edge") : label(b, wing)}`;
  };
  return `**In the corridors.** ${traps.map((t) => `${t.name}${where(t)}`).join(", ")}.`;
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
  const wing = key.wing;
  const closing = corridorLine(plan, wing);
  const blocks = [keyIntro(plan, settings, key.feetPerCell, wing), ...rooms.map((k) => roomLine(plan, k, key.feetPerCell, wing)), ...(closing ? [closing] : [])].map((text, i) => ({ id: blockPlaceholder(i), text }));
  const page: ClientOp = { t: "journal.create", page: { id: PAGE_PLACEHOLDER, title: wing ? wingKeyTitle(key.name, wing.titles) : keyTitle(key.name), folder: KEY_FOLDER, access: "dm", blocks } };
  // On hexes a pin stands on its hex's center (phase 3, 2.4), and a wing's stop at the pins its scene has room for.
  const L = latticeFor(plan.grid ?? "squares", { w: plan.w, h: plan.h });
  const pins = rooms.slice(0, wing ? wing.pins : rooms.length).map((k, i): ClientOp => {
    const [px, py] = plan.rooms[k.room]!.pin;
    const [x, y] = L.pointOf(px, py);
    return { t: "pin.put", pin: { id: pinPlaceholder(i), sceneId, x, y, label: label(k.n, wing), pageId: PAGE_PLACEHOLDER, color: key.color, visibility: "dm" } };
  });
  return [page, ...pins];
}
