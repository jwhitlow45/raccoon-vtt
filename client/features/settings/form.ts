import { critRuleOf } from "#shared/dice/crit.ts";
import type { AoeCoverage, AoeInclusion, CritRule, DiagonalRule, MemberId, MoveAnyToken, OrderReveal, RoomSettings, WhichPlayers } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { healRevivesDead } from "#shared/migrate.ts";
import { playersTypeTotals } from "#shared/permissions.ts";
import { orderRevealOf } from "#shared/rules/initiative.ts";
import { MAX_NAME, type ClientOp } from "#shared/protocol.ts";
import { TIMER_CHOICES } from "../encounter/timer.ts";

/**
 * The room settings form (design section 6, RoomSettings), as data: which
 * control each setting gets, its plain label and a short explanation. The
 * panel renders whatever is listed here, and the tests check that every
 * setting appears exactly once, so a setting added to the model cannot be
 * forgotten in the form without a failing test.
 */

type BoolKey = { [K in keyof RoomSettings]-?: NonNullable<RoomSettings[K]> extends boolean ? K : never }[keyof RoomSettings];
type ChoiceKey = "diagonal" | "aoeCoverage" | "aoeInclusion" | "critRule" | "playersSeeOrder";

export type Choice<V extends string> = { value: V; label: string; help: string };

export type SettingField =
  | { kind: "toggle"; key: BoolKey; label: string; help: string }
  | { kind: "choice"; key: "diagonal"; label: string; help: string; options: Choice<DiagonalRule>[] }
  | { kind: "choice"; key: "aoeCoverage"; label: string; help: string; options: Choice<AoeCoverage>[] }
  | { kind: "choice"; key: "aoeInclusion"; label: string; help: string; options: Choice<AoeInclusion>[] }
  | { kind: "choice"; key: "critRule"; label: string; help: string; options: Choice<CritRule>[] }
  | { kind: "choice"; key: "playersSeeOrder"; label: string; help: string; options: Choice<OrderReveal>[] }
  | { kind: "number"; key: "feetPerCell"; label: string; help: string; min: number; max: number }
  | { kind: "seconds"; key: "turnTimerSec"; label: string; help: string; options: { value: number; label: string }[] }
  | { kind: "movers"; key: "playersMoveAny"; label: string; help: string; options: Choice<MoveAnyMode>[] }
  | { kind: "drawers"; key: "playersDraw"; label: string; help: string; options: Choice<MoveAnyMode>[] };

export type SettingGroup = { heading: string; fields: SettingField[] };

export const FEET_PER_CELL = { min: 1, max: 100 } as const;

export const SETTING_GROUPS: SettingGroup[] = [
  {
    heading: "Players",
    fields: [
      {
        kind: "movers",
        key: "playersMoveAny",
        label: "Who can move any token",
        help: "Players always move their own tokens. This lets them also drag any other token they can see that is not locked.",
        options: [
          { value: "none", label: "No one", help: "Players move only their own tokens. The default." },
          { value: "all", label: "Every player", help: "Any player may move any visible, unlocked token." },
          { value: "some", label: "Chosen players", help: "Only the players you pick below." },
        ],
      },
      {
        kind: "drawers",
        key: "playersDraw",
        label: "Who can draw",
        help: "A player who may not draw cannot add drawings. Their drawings stay, and their Draw tool keeps only the eraser while they have any. Rulers, pings and the laser stay for everyone.",
        options: [
          { value: "none", label: "No one", help: "Only you draw on the map." },
          { value: "all", label: "Every player", help: "Any player may draw. The default." },
          { value: "some", label: "Chosen players", help: "Only the players you pick below." },
        ],
      },
      {
        kind: "toggle",
        key: "playersCreateCharacters",
        label: "Players can create their own characters",
        help: `Each player may make up to ${LIMITS.charactersPerPlayer} characters of their own and place their tokens on the players' scene. You can still edit, take over or delete them. On by default in new rooms.`,
      },
      {
        kind: "toggle",
        key: "playersApplyDamage",
        label: "Players can apply damage and healing",
        help: "Players may deal damage to or heal any creature they can see. Off by default.",
      },
      {
        kind: "toggle",
        key: "playersTypeTotals",
        label: "Players may type their roll totals",
        help: "Players may answer a roll you ask for, or set their initiative, with a total they rolled at the table. Off, they tap Roll and the app rolls for them. On by default.",
      },
      {
        kind: "toggle",
        key: "pcHpVisibleToParty",
        label: "Players see the party's HP",
        help: "Every player sees the exact HP of the other player characters. Off shows them only Healthy, Bloodied or Dying.",
      },
      {
        kind: "toggle",
        key: "playersSeeAoeOfOthers",
        label: "Players see each other's areas",
        help: "Players see the areas of effect other players place. Off hides them. The DM's areas follow their own visibility.",
      },
    ],
  },
  {
    heading: "Combat",
    fields: [
      {
        kind: "toggle",
        key: "monstersDieAtZero",
        label: "Monsters die at 0 HP",
        help: "Off makes monsters and NPCs fall Unconscious and make death saves at 0 HP, like player characters.",
      },
      {
        kind: "toggle",
        key: "healRevives",
        label: "Healing brings back the dead",
        help: "Healing a dead creature, or setting its HP above 0, brings it back with that HP. Off follows the rules as written: healing does nothing to the dead, and only the DM's Revive brings a creature back.",
      },
      {
        kind: "toggle",
        key: "skipDefeated",
        label: "Skip defeated creatures",
        help: "Next turn passes over dead creatures in the initiative order, player characters included.",
      },
      {
        kind: "toggle",
        key: "monsterInitScore",
        label: "Use initiative scores for monsters",
        help: "Monsters added to combat get their fixed initiative score (10 + Dexterity modifier) instead of a typed roll. You can still change it.",
      },
      {
        kind: "toggle",
        key: "revealHiddenOnTurn",
        label: "Reveal hidden combatants on their turn",
        help: "A hidden creature is revealed when its first turn comes. Players then see it as they see any creature: out of the fog, and in the party's sight when the scene has party vision.",
      },
      {
        kind: "choice",
        key: "playersSeeOrder",
        label: "Initiative order players see",
        help: "Which creatures players see in the order before those creatures act. A creature you hide stays out of their order either way.",
        options: [
          {
            value: "party",
            label: "Player characters, the rest on their turn",
            help: "Players see the creatures players play from the start. Every other creature joins their order when its first turn comes, and stays for the fight. The default for new rooms.",
          },
          { value: "allies", label: "Player characters and allies, the rest on their turn", help: "As above, and creatures with the Ally ring show from the start too." },
          { value: "all", label: "Everyone", help: "Players see the whole order from the start." },
        ],
      },
      {
        kind: "choice",
        key: "critRule",
        label: "Critical hit damage",
        help: "How a critical hit rolls its damage, riders included, for every attack in this room.",
        options: [
          { value: "rollTwice", label: "Roll the dice twice", help: "2d6+3 crits as 4d6+3. The 2024 rule." },
          { value: "maxPlusRoll", label: "Max plus a roll", help: "The dice at their highest, plus a roll: 12 + 2d6 + 3." },
          { value: "doubleDice", label: "Double the dice rolled", help: "The dice roll once and count twice: (2d6 × 2) + 3." },
          { value: "doubleTotal", label: "Double the total", help: "The whole damage counts twice: (2d6 + 3) × 2." },
        ],
      },
      {
        kind: "seconds",
        key: "turnTimerSec",
        label: "Turn timer",
        help: "Counts each turn down where everyone can see it, and nudges whoever acts when it runs out. It never ends a turn. Off by default.",
        options: [...TIMER_CHOICES],
      },
    ],
  },
  {
    heading: "Grid and distance",
    fields: [
      {
        kind: "number",
        key: "feetPerCell",
        label: "Feet per square",
        help: "How far one grid square is. 5 by default, 1 to 100.",
        min: FEET_PER_CELL.min,
        max: FEET_PER_CELL.max,
      },
      {
        kind: "choice",
        key: "diagonal",
        label: "Diagonal moves",
        help: "How the ruler and ranges count a diagonal step.",
        options: [
          { value: "five", label: "Every square is 5 ft", help: "Diagonals cost the same as straight moves. The 2024 rule." },
          { value: "fiveTen", label: "Alternate 5 ft and 10 ft", help: "Every second diagonal costs double. An optional rule." },
          { value: "euclid", label: "True distance", help: "Measures the straight line, rounded to the nearest foot." },
        ],
      },
    ],
  },
  {
    heading: "Areas of effect",
    fields: [
      {
        kind: "choice",
        key: "aoeCoverage",
        label: "Which squares an area covers",
        help: "Decides which grid squares are shaded as inside an area.",
        options: [
          { value: "half", label: "At least half the square", help: "The 2024 rule." },
          { value: "any", label: "Any part of the square", help: "Even a sliver of the area counts." },
          { value: "center", label: "The square's center", help: "Only squares whose center is inside." },
        ],
      },
      {
        kind: "choice",
        key: "aoeInclusion",
        label: "Which creatures an area catches",
        help: "Decides who is in an area, at the creature's own height.",
        options: [
          { value: "anyCell", label: "Any square the creature is in", help: "A creature is caught if any of its squares is covered. The default." },
          { value: "center", label: "The creature's center", help: "Only when the center of its space is inside." },
          { value: "majority", label: "Most of the creature", help: "When more than half of its space is inside." },
        ],
      },
    ],
  },
];

/**
 * The three answers the DM picks from, for who can move any token and who
 * can draw. "some" is a list, even an empty one, so the picks show while
 * none is ticked.
 */
export type MoveAnyMode = "none" | "all" | "some";

/** Who can draw, as the room reads it: absent, in rooms from before the setting, is every player (docs/design-v1-dm-tools.md 3.9). */
export function drawersOf(settings: Pick<RoomSettings, "playersDraw">): WhichPlayers {
  return settings.playersDraw ?? "all";
}

/**
 * Whether a switch shows on. A setting a room may lack reads as its rule
 * reads it, so "Healing brings back the dead" shows on in a room from
 * before it, as healing there does bring back the dead.
 */
export function toggleOn(settings: RoomSettings, key: BoolKey): boolean {
  if (key === "healRevives") return healRevivesDead(settings);
  if (key === "playersTypeTotals") return playersTypeTotals(settings);
  return settings[key] === true;
}

/**
 * Which choice shows picked. A choice a room may lack reads as its rule
 * reads it: the 2024 critical hit rule, and the whole order for players.
 */
export function choiceOf(settings: RoomSettings, key: ChoiceKey): string {
  if (key === "critRule") return critRuleOf(settings);
  if (key === "playersSeeOrder") return orderRevealOf(settings);
  return settings[key];
}

export function moveAnyMode(value: MoveAnyToken): MoveAnyMode {
  return Array.isArray(value) ? "some" : value;
}

/** The setting for a mode the DM picked. Choosing "Chosen players" again keeps the players already chosen. */
export function moveAnyFor(mode: MoveAnyMode, current: MoveAnyToken): MoveAnyToken {
  if (mode !== "some") return mode;
  return Array.isArray(current) ? current : [];
}

/** The chosen players with one player ticked or unticked. */
export function withMover(current: MoveAnyToken, memberId: MemberId, on: boolean): MoveAnyToken {
  const chosen = Array.isArray(current) ? current.filter((id) => id !== memberId) : [];
  return on ? [...chosen, memberId] : chosen;
}

export function allFields(): SettingField[] {
  return SETTING_GROUPS.flatMap((g) => g.fields);
}

/** The settings that differ from the current ones. Null when nothing changed, so no op is sent. */
export function settingsPatch(current: RoomSettings, next: Partial<RoomSettings>): Partial<RoomSettings> | null {
  const patch: Partial<RoomSettings> = {};
  let changed = false;
  for (const key of Object.keys(next) as (keyof RoomSettings)[]) {
    const value = next[key];
    // The one list among the settings compares by its contents.
    if (value === undefined || JSON.stringify(value) === JSON.stringify(current[key])) continue;
    (patch as Record<string, unknown>)[key] = value;
    changed = true;
  }
  return changed ? patch : null;
}

export function settingsOp(current: RoomSettings, next: Partial<RoomSettings>): Extract<ClientOp, { t: "room.update" }> | null {
  const patch = settingsPatch(current, next);
  return patch ? { t: "room.update", settings: patch } : null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A whole number of feet from 1 to 100, as the op schema bounds it. */
export function parseFeetPerCell(text: string): Parsed<number> {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Enter a whole number of feet." };
  const value = Number(trimmed);
  if (value < FEET_PER_CELL.min || value > FEET_PER_CELL.max) {
    return { ok: false, error: `Between ${FEET_PER_CELL.min} and ${FEET_PER_CELL.max} feet.` };
  }
  return { ok: true, value };
}

export function parseRoomName(text: string): Parsed<string> {
  const name = text.trim();
  if (name === "") return { ok: false, error: "The room needs a name." };
  if (name.length > MAX_NAME) return { ok: false, error: `At most ${MAX_NAME} characters.` };
  return { ok: true, value: name };
}
