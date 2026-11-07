import type { RoomSettings } from "#shared/model.ts";
import { timerChoices } from "../encounter/timer.ts";
import { SHAPE_CHOICES } from "../grid/words.ts";
import { action, inside, onOff, page, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";
import {
  CHOSEN_PLAYERS,
  choiceOf,
  drawersOf,
  groupAnchor,
  moveAnyMode,
  newScenesChoice,
  newScenesOptions,
  newScenesShape,
  SETTING_GROUPS,
  settingAnchor,
  settingGroups,
  toggleOn,
  type SettingField,
} from "./form.ts";

/*
 * Room settings in the room search (designs/qol/search.md 4 and 5.10), a
 * DM's page alone, so these entries load with the DM's catalog only
 * (catalog/dm.ts): nothing but that file imports this one. They come from
 * the form's own data (form.ts), each with its value now, so a setting
 * added there is found with no entry to write, and only its other names
 * are written here.
 */

const SETTINGS: Place = { panel: "menu", page: "settings", where: "Menu · Room settings", icon: "settings" };
const BACKUP = inside(SETTINGS, "Backup");

/** The other names a DM types for a setting, beside its label. */
const NAMES: Partial<Record<SettingField["key"], readonly string[]>> = {
  playersMoveAny: ["move any token"],
  playersDraw: ["players draw", "drawing"],
  playersCreateCharacters: ["new characters"],
  playersApplyDamage: ["players apply hp"],
  playersTypeTotals: ["type totals", "physical dice"],
  playersSeeAoeOfOthers: ["others' areas"],
  monstersDieAtZero: ["dead monsters"],
  healRevives: ["revive"],
  skipDefeated: ["skip dead"],
  monsterInitScore: ["initiative score", "fixed initiative"],
  revealHiddenOnTurn: ["hidden combatants"],
  playersSeeOrder: ["turn order", "initiative order"],
  critRule: ["crit", "critical hits"],
  turnTimerSec: ["timer"],
  feetPerCell: ["grid scale"],
  diagonal: ["diagonals"],
  newScenes: ["grid shape", "squares"],
  aoeCoverage: ["area coverage"],
  aoeInclusion: ["area targets"],
  newScenePlayers: ["fog on new scenes"],
};

/** The label a room with hexes reads (form.ts HEX_WORDS), found as another name. */
const HEX_LABELS: ReadonlyMap<string, string> = new Map(settingGroups(true).flatMap((g) => g.fields.map((f) => [f.key, f.label] as const)));

const settingsOf = (ctx: SearchContext): RoomSettings | undefined => ctx.state.view?.meta.settings;

/** A setting's value as its control shows it now: a switch's On or Off, a choice's picked words, the feet per square. */
export function settingValue(field: SettingField, settings: RoomSettings): string | undefined {
  switch (field.kind) {
    case "toggle":
      return onOff(toggleOn(settings, field.key));
    case "choice":
      return (field.options as readonly { value: string; label: string }[]).find((o) => o.value === choiceOf(settings, field.key))?.label;
    case "number":
      return `${settings.feetPerCell} ft.`;
    case "seconds": {
      const value = settings[field.key] ?? 0;
      return timerChoices(value).find((o) => o.value === value)?.label;
    }
    case "movers":
      return field.options.find((o) => o.value === moveAnyMode(settings.playersMoveAny))?.label;
    case "drawers":
      return field.options.find((o) => o.value === moveAnyMode(drawersOf(settings)))?.label;
    case "newScenes":
      return newScenesOptions(field, settings).find((o) => o.value === newScenesChoice(settings))?.label;
    case "gridShape":
      return SHAPE_CHOICES.find((c) => c.value === newScenesShape(settings))?.label;
  }
}

function fieldEntries(field: SettingField, place: Place): CatalogEntry[] {
  const hex = HEX_LABELS.get(field.key);
  const names = [...(NAMES[field.key] ?? []), ...(hex && hex !== field.label ? [hex] : [])];
  const anchor = settingAnchor(field.key);
  const out = [
    setting(place, anchor, field.label, {
      ...(names.length > 0 ? { names } : null),
      valueNow: (ctx) => {
        const settings = settingsOf(ctx);
        return settings ? settingValue(field, settings) : undefined;
      },
    }),
  ];
  // The players' ticks show while the DM picks Chosen players (SettingsPanel.tsx ChosenPlayers).
  if (field.kind === "movers" || field.kind === "drawers") {
    const key = field.key;
    out.push(setting(place, `${anchor}.chosen`, CHOSEN_PLAYERS[key], { when: (ctx) => Array.isArray(settingsOf(ctx)?.[key]) }));
  }
  return out;
}

export const ROOM_SETTINGS_ENTRIES: readonly CatalogEntry[] = [
  page({ ...SETTINGS, where: "Menu" }, "menu.room-settings", "Room settings", { names: ["room options", "house rules"] }),
  setting(SETTINGS, "menu.room-settings.name", "Room name", { names: ["rename the room"], valueNow: (ctx) => ctx.state.view?.meta.name }),
  ...SETTING_GROUPS.flatMap((g) => [section(SETTINGS, groupAnchor(g.heading), g.heading), ...g.fields.flatMap((f) => fieldEntries(f, inside(SETTINGS, g.heading)))]),
  section(SETTINGS, "menu.room-settings.backup", "Backup", { names: ["export the room"] }),
  // Offered while the room holds sounds: the panel offers the tick only for a room with sounds (ExportSection.tsx).
  setting(BACKUP, "menu.room-settings.backup.sounds", "Include sounds", { when: (ctx) => Object.keys(ctx.state.view?.sounds ?? {}).length > 0 }),
  action(BACKUP, "menu.room-settings.backup.download", "Download a backup", { names: ["export the room", "save the room"] }),
];
