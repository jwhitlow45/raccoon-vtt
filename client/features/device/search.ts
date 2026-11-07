import { fullscreenSupported } from "../../lib/fullscreen.ts";
import { isSoundOn } from "../encounter/alerts.ts";
import { soundEnabled } from "../pings/feedback.ts";
import { serverAnimatedMapsNow } from "../animmap/status.ts";
import { ANIMATED_MAPS_LABEL } from "../animmap/words.ts";
import { inside, onOff, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry } from "../search/catalog/types.ts";
import { lowPower, rollAnimation, roomSoundChoice, roomSoundOnFor, themeChoice, THEME_CHOICE_WORDS, uiScale, uiScaleLabel } from "./settings.ts";

/*
 * This device's part of the room search (docs/design/design-v1-qol.md 5, What
 * it finds and What keeps it current), for both roles, so it ships in the
 * room's chunk through catalog/everyone.ts. Each anchor is the `search=` id
 * on its control in ThisDevice.tsx. A setting a device does not draw now,
 * such as Full screen where the browser has none, is not offered, so Enter
 * never waits for a control that will not come.
 */

const DEVICE: Place = { panel: "menu", page: "device", where: "Menu · This device", icon: "device" };

const SIZE = inside(DEVICE, "Interface size", "size");
const THEME = inside(DEVICE, "Theme", "theme");
const SCREEN = inside(DEVICE, "Screen", "screen");
const BATTERY = inside(DEVICE, "Battery", "battery");
const MAP_DETAIL = inside(DEVICE, "Map detail", "mapDetail");
const WEATHER = inside(DEVICE, "Weather", "weather");
const SOUNDS = inside(DEVICE, "Sounds", "sounds");
const ROLLS = inside(DEVICE, "Rolls", "rolls");
const SHORTCUTS = inside(DEVICE, "Shortcuts", "shortcuts");
const HANDLE = inside(DEVICE, "Sheet handle", "handle");
const TAB_ROW = inside(DEVICE, "Tab row", "tabRow");

/** Music, Background and Effects stand under Room sound only while it is on (ThisDevice.tsx RoomSoundControls). */
const roomSoundOn = (role: "dm" | "player") => roomSoundOnFor(roomSoundChoice(), role);

/** The section's own place is the page with its fold: a group's where is the page's, its settings' the group's. */
const at = (group: Place): Place => ({ ...group, where: DEVICE.where });

export const DEVICE_ENTRIES: readonly CatalogEntry[] = [
  section(at(SIZE), "menu.this-device.size", "Interface size", { names: ["text size", "ui size"] }),
  setting(SIZE, "menu.this-device.size.scale", "Interface size", { names: ["text size", "ui size"], valueNow: () => uiScaleLabel(uiScale()) }),
  section(at(THEME), "menu.this-device.theme", "Theme", { names: ["dark mode", "light mode"] }),
  setting(THEME, "menu.this-device.theme.choice", "Theme", { names: ["dark mode", "light mode", "colors"], valueNow: () => THEME_CHOICE_WORDS[themeChoice()] }),
  section(at(SCREEN), "menu.this-device.screen", "Screen", { when: () => fullscreenSupported() }),
  setting(SCREEN, "menu.this-device.screen.fullscreen", "Full screen", { names: ["fullscreen"], when: () => fullscreenSupported() }),
  section(at(BATTERY), "menu.this-device.battery", "Battery"),
  setting(BATTERY, "menu.this-device.battery.low-power", "Low power", { names: ["battery saver"], valueNow: () => onOff(lowPower()) }),
  section(at(MAP_DETAIL), "menu.this-device.map-detail", "Map detail"),
  setting(MAP_DETAIL, "menu.this-device.map-detail.images", "Map images", { names: ["map detail", "map resolution"] }),
  setting(MAP_DETAIL, "menu.this-device.map-detail.animated", ANIMATED_MAPS_LABEL, { names: ["moving maps"], when: () => serverAnimatedMapsNow() === true }),
  section(at(WEATHER), "menu.this-device.weather", "Weather"),
  setting(WEATHER, "menu.this-device.weather.mode", "Weather on the map", { names: ["weather effects"] }),
  section(at(SOUNDS), "menu.this-device.sounds", "Sounds"),
  setting(SOUNDS, "menu.this-device.sounds.room", "Room sound", { names: ["music on this device", "mute"], valueNow: (ctx) => onOff(roomSoundOn(ctx.role)) }),
  setting(SOUNDS, "menu.this-device.sounds.music", "Music volume", { when: (ctx) => roomSoundOn(ctx.role) }),
  setting(SOUNDS, "menu.this-device.sounds.loops", "Background volume", { names: ["background sounds", "ambience"], when: (ctx) => roomSoundOn(ctx.role) }),
  setting(SOUNDS, "menu.this-device.sounds.effects", "Effects volume", { names: ["sound effects"], when: (ctx) => roomSoundOn(ctx.role) }),
  setting(SOUNDS, "menu.this-device.sounds.turn", "Turn sound", { names: ["chime"], valueNow: () => onOff(isSoundOn()) }),
  setting(SOUNDS, "menu.this-device.sounds.ping", "Ping sound", { valueNow: () => onOff(soundEnabled()) }),
  section(at(ROLLS), "menu.this-device.rolls", "Rolls"),
  setting(ROLLS, "menu.this-device.rolls.toasts", "Show others' rolls as they happen", { names: ["roll notes"] }),
  setting(ROLLS, "menu.this-device.rolls.animation", "Roll animation", { names: ["3d dice", "dice animation"], valueNow: () => onOff(rollAnimation()) }),
  setting(ROLLS, "menu.this-device.rolls.dice-set", "Dice set", { names: ["dice color", "dice look"] }),
  section(at(SHORTCUTS), "menu.this-device.shortcuts", "Shortcuts", { names: ["keys", "keyboard"] }),
  section(at(HANDLE), "menu.this-device.handle", "Sheet handle"),
  setting(HANDLE, "menu.this-device.handle.design", "Sheet handle", { names: ["grabber"] }),
  // The side panel's row of tabs is a wide screen's alone (ThisDevice.tsx tabRole).
  section(at(TAB_ROW), "menu.this-device.tab-row", "Tab row", { names: ["tabs"], when: (ctx) => ctx.wide }),
  setting(TAB_ROW, "menu.this-device.tab-row.panels", "Panels that may be tabs", { names: ["tabs", "more"], when: (ctx) => ctx.wide }),
];
