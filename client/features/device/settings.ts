import { useSyncExternalStore } from "react";
import { parseGrabber, type GrabberId } from "../../components/grabberDesigns.ts";
import { setBoardInterfaceScale } from "../../lib/boardScale.ts";
import { theme } from "../../lib/theme.ts";
import { preferredMapVariant, readMapVariantSetting, type MapVariantSetting } from "../../lib/device.ts";
import { formatKeyChanges, parseKeyChanges, type KeyChanges } from "../../state/keyBindings.ts";
import { parseDiceSet } from "../dice/throw/sets.ts";
import type { AnimatedMapsChoice } from "../animmap/words.ts";

/**
 * This device's own settings (docs/design/design-v1-dm-tools.md 2.7): the
 * interface size, low power, the map detail and the keys. They belong to
 * one device, never to the room, so each lives in local storage, read and
 * written inside try and catch as every `rvtt.*` key is. A device that
 * blocks storage keeps a change until the page closes.
 *
 * Each follows the store pattern the sounds use (features/encounter/alerts.ts):
 * a module variable, a listener set and useSyncExternalStore, so every
 * component that reads one follows a change at once, the Room page behind
 * the menu included.
 */

export type Setting<T> = {
  get(): T;
  set(value: T): void;
  /** Takes a value for this page only, leaving the stored one as it is. */
  apply(value: T): void;
  /** Goes back to the device's own value: the stored one, or the one chosen on this page when storage could not keep it. */
  restore(): void;
  /**
   * Takes what another window of the app stored, from its `storage` event,
   * as the device's own. A value this page took for itself with `apply`
   * stays until `restore`, which then gives this one.
   */
  adopt(raw: string | null): void;
  subscribe(listener: () => void): () => void;
  use(): T;
};

/** One device setting kept in local storage under `key` (the store pattern above). Exported for lib/scheme.ts, which keeps the theme in one. */
export function setting<T>(key: string, parse: (raw: string | null) => T, format: (value: T) => string, onChange?: (value: T) => void): Setting<T> {
  const listeners = new Set<() => void>();
  let value = parse(read(key));
  /**
   * The device's own choice, kept apart from a value `apply` took for this
   * page only (a table display's text size), and whether storage holds it.
   * Going back reads storage again, which may hold a choice made since in
   * another window. But when the last write failed, or reads are blocked,
   * storage would give an older value or none, so this one is used.
   */
  let own = value;
  let saved = true;
  /** Whether `apply` took a value for this page only, which a value from another window must not replace. */
  let pageOnly = false;
  onChange?.(value);
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const get = () => value;
  const show = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    onChange?.(next);
    for (const listener of listeners) listener();
  };
  return {
    get,
    set(next) {
      own = next;
      try {
        localStorage.setItem(key, format(next));
        saved = true;
      } catch {
        // Private mode or storage full: the setting lasts until the page closes.
        saved = false;
      }
      pageOnly = false;
      show(next);
    },
    apply(next) {
      pageOnly = true;
      show(next);
    },
    restore() {
      const raw = saved ? read(key) : null;
      if (raw !== null) own = parse(raw);
      pageOnly = false;
      show(own);
    },
    adopt(raw) {
      own = parse(raw);
      saved = true;
      if (!pageOnly) show(own);
    },
    subscribe,
    // The same value for a render outside the browser, as a component's unit test makes: it reads the defaults.
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}

function read(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- interface size

/** "Interface size" (section 3.16): 85%, 100% (the default), 115% or 130%. */
export const UI_SCALES = [0.85, 1, 1.15, 1.3] as const;
export type UiScale = (typeof UI_SCALES)[number];

export function parseUiScale(raw: string | null): UiScale {
  const n = Number(raw);
  return UI_SCALES.find((s) => s === n) ?? 1;
}

/** "85%", for the setting's choices. */
export function uiScaleLabel(scale: UiScale): string {
  return `${Math.round(scale * 100)}%`;
}

// The names, chips and badges drawn on tokens follow the interface size too (lib/boardScale.ts).
const uiScaleSetting = setting("rvtt.uiScale", parseUiScale, String, setBoardInterfaceScale);

export const uiScale = uiScaleSetting.get;
export const setUiScale = uiScaleSetting.set;
/**
 * A table display keeps a text size of its own (features/display), so the
 * TV window that "Open on this device" opens in the DM's own browser never
 * resizes the DM's room, which reads the stored size. It takes its size for
 * its page only, and gives the stored one back when it closes.
 */
export const applyUiScale = uiScaleSetting.apply;
export const restoreUiScale = uiScaleSetting.restore;
export const subscribeUiScale = uiScaleSetting.subscribe;
export const useUiScale = uiScaleSetting.use;

// ---------------------------------------------------------------- low power

/** "Low power" (section 3.15), off by default. */
export function parseLowPower(raw: string | null): boolean {
  return raw === "on";
}

const lowPowerSetting = setting("rvtt.lowPower", parseLowPower, (on) => (on ? "on" : "off"));

export const lowPower = lowPowerSetting.get;
export const setLowPower = lowPowerSetting.set;
export const useLowPower = lowPowerSetting.use;
export const subscribeLowPower = lowPowerSetting.subscribe;

/** Device pixels per CSS pixel on the map canvas (canvas/konvaSetup.ts): at most 2, and 1 in low power. */
export function pixelRatioFor(low: boolean, devicePixelRatio: number): number {
  return low ? 1 : Math.min(devicePixelRatio || 1, 2);
}

/**
 * What the map canvas's stage is mounted for (canvas/Stage.tsx): a change
 * of low power or of the interface size remounts it, since Konva reads the
 * pixel ratio only as a layer's canvas is made.
 */
export function stageMountKey(low: boolean, scale: number): string {
  return `${low ? "low" : "full"}:${scale}`;
}

/**
 * Ephemeral frames a second this device sends (drags, rulers, the laser):
 * the socket's full 30 (state/socket.ts EPH_PER_SECOND), or 15 in low
 * power. The number is written here rather than imported, so the settings
 * every sheet and dialog reads do not pull the socket and the protocol in.
 */
export function ephRate(low: boolean): number {
  return low ? 15 : 30;
}

// ---------------------------------------------------------------- others' rolls

/** "Show others' rolls as they happen" (docs/design/design-v1-dice.md 8.5), on by default. */
export function parseRollToasts(raw: string | null): boolean {
  return raw !== "off";
}

const rollToastsSetting = setting("rvtt.rollToasts", parseRollToasts, (on) => (on ? "on" : "off"));

export const setRollToasts = rollToastsSetting.set;
export const useRollToastsOn = rollToastsSetting.use;

/** "Roll animation" (docs/design/design-v1-roll-animation.md 9.2): this device's own rolls in the Dice panel and from stat blocks throw dice. On by default. */
export function parseRollAnimation(raw: string | null): boolean {
  return raw !== "off";
}

const rollAnimationSetting = setting("rvtt.rollAnimation", parseRollAnimation, (on) => (on ? "on" : "off"));

export const rollAnimation = rollAnimationSetting.get;
export const setRollAnimation = rollAnimationSetting.set;
export const useRollAnimation = rollAnimationSetting.use;
export const subscribeRollAnimation = rollAnimationSetting.subscribe;

/** "Dice": the set this device throws, by id (features/dice/throw/sets.ts), Ivory when unset or unknown. */
export { parseDiceSet };
const diceSetSetting = setting("rvtt.diceSet", parseDiceSet, (id) => id);

export const diceSetId = diceSetSetting.get;
export const setDiceSetId = diceSetSetting.set;
export const useDiceSetId = diceSetSetting.use;
export const subscribeDiceSet = diceSetSetting.subscribe;

// ---------------------------------------------------------------- map detail

/**
 * "Map detail" (design.md 11.2's device setting, read by lib/device.ts):
 * "Phone size" or "Full size". Left alone it is "auto", which picks the
 * phone size on a touch phone and the full size elsewhere, and the page
 * shows the size that rule picked as the one chosen.
 */
const mapDetailSetting = setting<MapVariantSetting>("rvtt.mapVariant", () => readMapVariantSetting(), (v) => v);

export const setMapDetail = mapDetailSetting.set;
export const useMapDetail = mapDetailSetting.use;

/** The map size this device loads: the phone size in low power on every device, else the setting or its rule. */
export function mapVariantFor(input: { lowPower: boolean; setting: MapVariantSetting; coarsePointer: boolean; shortSidePx: number }): "full" | "mobile" {
  if (input.lowPower) return "mobile";
  return preferredMapVariant({ coarsePointer: input.coarsePointer, shortSidePx: input.shortSidePx, setting: input.setting });
}

/** The map size for this device as it is now. */
export function useMapVariant(): "full" | "mobile" {
  const low = useLowPower();
  const detail = useMapDetail();
  return mapVariantFor({
    lowPower: low,
    setting: detail,
    coarsePointer: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    shortSidePx: typeof screen === "undefined" ? 0 : Math.min(screen.width, screen.height),
  });
}

// ---------------------------------------------------------------- keys

/**
 * The shortcut sheet's changed keys (state/keyBindings.ts): only the
 * changes from the defaults, with the stored form's version, as
 * `{"v":1,"keys":{"tool:fog":"k"}}`. What they mean against the table is
 * state/shortcuts.ts's to say, since only it knows the defaults.
 */
const keyChangesSetting = setting<KeyChanges>("rvtt.keys", parseKeyChanges, formatKeyChanges);

export const keyChanges = keyChangesSetting.get;
export const setKeyChanges = keyChangesSetting.set;
export const useKeyChanges = keyChangesSetting.use;

// ---------------------------------------------------------------- sheet handle

/**
 * "Sheet handle" (docs/design/design-v1-sheet-swipe.md 4.8): the grabber a phone's
 * sheets that swipe show, by id (components/grabberDesigns.ts), Ringed
 * tail when unset or unknown. Every open sheet follows a change at once.
 */
const sheetHandleSetting = setting<GrabberId>("rvtt.sheetHandle", parseGrabber, (id) => id);

export const sheetHandle = sheetHandleSetting.get;
export const setSheetHandle = sheetHandleSetting.set;
export const useSheetHandle = sheetHandleSetting.use;

// ---------------------------------------------------------------- weather

/**
 * "Weather on the map" (docs/design/design-v1-weather.md 4.3): Moving, the
 * default, Still or Off. Reduced motion, Low power and a device that could
 * not keep up keep it still whatever this says (features/weather/store.ts).
 */
export const WEATHER_MODES = ["moving", "still", "off"] as const;
export type WeatherMode = (typeof WEATHER_MODES)[number];

/** Each choice's name, in This device's cards and the table display's menu. */
export const WEATHER_MODE_WORDS: Readonly<Record<WeatherMode, string>> = { moving: "Moving", still: "Still", off: "Off" };

export function parseWeatherMode(raw: string | null): WeatherMode {
  return raw === "still" || raw === "off" ? raw : "moving";
}

const weatherModeSetting = setting<WeatherMode>("rvtt.weather", parseWeatherMode, (m) => m);

export const weatherMode = weatherModeSetting.get;
export const setWeatherMode = weatherModeSetting.set;
export const useWeatherMode = weatherModeSetting.use;
export const subscribeWeatherMode = weatherModeSetting.subscribe;
/** A table display's own choice, for its page only, as its text size takes `applyUiScale` (features/display/remember.ts). */
export const applyWeatherMode = weatherModeSetting.apply;
export const restoreWeatherMode = weatherModeSetting.restore;

// ---------------------------------------------------------------- theme

/**
 * "Theme" (docs/design/design-v1-light-theme.md 4.1): Dark, the default,
 * Light, or Auto, which follows the device's own light or dark setting.
 * Anything else stored reads as dark. lib/scheme.ts resolves it and colors
 * the page, and every open window of the app follows a change.
 */
export const THEME_CHOICES = ["dark", "light", "auto"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Each choice's name, in This device's row. */
export const THEME_CHOICE_WORDS: Readonly<Record<ThemeChoice, string>> = { dark: "Dark", light: "Light", auto: "Auto" };

export function parseThemeChoice(raw: string | null): ThemeChoice {
  return raw === "light" || raw === "auto" ? raw : "dark";
}

/** The key, for lib/scheme.ts's `storage` listener. */
export const THEME_KEY = "rvtt.theme";

export const themeChoiceSetting = setting<ThemeChoice>(THEME_KEY, parseThemeChoice, (c) => c);

export const themeChoice = themeChoiceSetting.get;
export const setThemeChoice = themeChoiceSetting.set;
export const useThemeChoice = themeChoiceSetting.use;
export const subscribeThemeChoice = themeChoiceSetting.subscribe;

// ---------------------------------------------------------------- animated maps

/**
 * "Animated maps" (docs/design/design-v1-animated-maps.md 4.4): Moving, the
 * default, or Still, which shows each map's first frame and downloads no
 * video. Low power, reduced motion and a device that could not keep up
 * keep them still whatever this says (features/animmap/playback.ts).
 */
export function parseAnimatedMaps(raw: string | null): AnimatedMapsChoice {
  return raw === "still" ? "still" : "moving";
}

const animatedMapsSetting = setting<AnimatedMapsChoice>("rvtt.animatedMaps", parseAnimatedMaps, (c) => c);

export const animatedMaps = animatedMapsSetting.get;
export const setAnimatedMaps = animatedMapsSetting.set;
export const useAnimatedMaps = animatedMapsSetting.use;
export const subscribeAnimatedMaps = animatedMapsSetting.subscribe;
/** A table display's own choice, for its page only, as its weather takes `applyWeatherMode` (features/display/remember.ts). */
export const applyAnimatedMaps = animatedMapsSetting.apply;
export const restoreAnimatedMaps = animatedMapsSetting.restore;

// ---------------------------------------------------------------- room sound

/**
 * Whether this device is muted (docs/design/design-v1-volume.md 5), stored
 * as "Room sound" was (docs/design/design-v1-music.md 4.4), so nothing
 * migrates: whether it plays the music, background sounds and effects the
 * DM plays. "on" unmuted, "off" muted, or null until a choice: a DM device
 * takes null as unmuted, and a player's asks the first time there is
 * something to hear. A table display keeps its own
 * (features/display/remember.ts).
 */
export type RoomSoundChoice = "on" | "off" | null;

export function parseRoomSound(raw: string | null): RoomSoundChoice {
  return raw === "on" || raw === "off" ? raw : null;
}

/** Whether a choice means sound for a role: null is on for a DM, off for a player until asked. */
export function roomSoundOnFor(choice: RoomSoundChoice, role: "dm" | "player"): boolean {
  return choice === "on" || (choice === null && role === "dm");
}

export const ROOM_SOUND_KEY = "rvtt.roomSound";
const roomSoundSetting = setting<RoomSoundChoice>(ROOM_SOUND_KEY, parseRoomSound, (c) => c ?? "off");

export function roomSoundChoice(): RoomSoundChoice {
  followOtherWindows();
  return roomSoundSetting.get();
}
export const setRoomSoundChoice = roomSoundSetting.set;
export function useRoomSoundChoice(): RoomSoundChoice {
  followOtherWindows();
  return roomSoundSetting.use();
}
export function subscribeRoomSound(listener: () => void): () => void {
  followOtherWindows();
  return roomSoundSetting.subscribe(listener);
}

/**
 * This device's "Volume" over its "Music", "Background" and "Effects"
 * (docs/design/design-v1-volume.md 5), each squared into the gain. Volume
 * is 5 to 100, 100 at first so a device sounds as it did until someone
 * moves it, and it is the level unmuting returns to, so it is never stored
 * as 0: muting is the choice above. The other three are 0 to 100, 80% at
 * first.
 */
export type SoundMix = { readonly volume: number; readonly music: number; readonly loops: number; readonly effects: number };
export const SOUND_MIX_DEFAULT: SoundMix = { volume: 100, music: 80, loops: 80, effects: 80 };

function mixPart(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback;
}

export function parseSoundMix(raw: string | null): SoundMix {
  if (raw === null) return SOUND_MIX_DEFAULT;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SoundMix, unknown>> | null;
    if (!v || typeof v !== "object") return SOUND_MIX_DEFAULT;
    // A mix an older build wrote has no volume. A 0, which unmuting could not return to, reads as the default too.
    const volume = mixPart(v.volume, 100);
    return { volume: volume === 0 ? 100 : volume, music: mixPart(v.music, 80), loops: mixPart(v.loops, 80), effects: mixPart(v.effects, 80) };
  } catch {
    return SOUND_MIX_DEFAULT;
  }
}

export const SOUND_MIX_KEY = "rvtt.soundMix";
const soundMixSetting = setting<SoundMix>(SOUND_MIX_KEY, parseSoundMix, (m) => JSON.stringify({ volume: m.volume, music: m.music, loops: m.loops, effects: m.effects }));

export function soundMix(): SoundMix {
  followOtherWindows();
  return soundMixSetting.get();
}
export const setSoundMix = soundMixSetting.set;
export function useSoundMix(): SoundMix {
  followOtherWindows();
  return soundMixSetting.use();
}
export function subscribeSoundMix(listener: () => void): () => void {
  followOtherWindows();
  return soundMixSetting.subscribe(listener);
}

let followingOtherWindows = false;

/*
 * Another window of the app that changes either writes storage, and the
 * browser tells this one with a `storage` event, so its engine and its
 * switches follow, as the theme's do (lib/scheme.ts). A null key means
 * that window cleared storage, which puts the defaults back. The listener
 * goes on at the first read rather than at import, so a page or a test
 * that imports these settings and never reads them adds none, and
 * lib/scheme.ts's count of its own listener holds.
 */
function followOtherWindows(): void {
  if (followingOtherWindows || typeof window === "undefined") return;
  followingOtherWindows = true;
  window.addEventListener("storage", (event) => {
    if (event.key === ROOM_SOUND_KEY || event.key === null) roomSoundSetting.adopt(event.key === null ? null : event.newValue);
    if (event.key === SOUND_MIX_KEY || event.key === null) soundMixSetting.adopt(event.key === null ? null : event.newValue);
  });
}

// ---------------------------------------------------------------- side panel width

/**
 * The side panel's width from 900 px up (docs/design/design-v1-panel-size.md
 * 3), in whole layout px, or null for the default. A missing key, an empty
 * or non-number value and any width at or under the default read as null,
 * and pages/panelWidth.ts never stores the default as a number, so a later
 * change of the default reaches this device. A drag shows through `apply`,
 * which its release ends with `set` or `restore`.
 */
export const PANEL_WIDTH_KEY = "rvtt.sidePanelWidth";

export function parsePanelWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  // Floored first, so a width that rounds down to the default reads as the default.
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > theme.layout.sidePanelWidth ? n : null;
}

const panelWidthSetting = setting<number | null>(PANEL_WIDTH_KEY, parsePanelWidth, (w) => (w === null ? "" : String(w)));

export function panelWidth(): number | null {
  followPanelWidth();
  return panelWidthSetting.get();
}
export function usePanelWidth(): number | null {
  followPanelWidth();
  return panelWidthSetting.use();
}
export const setPanelWidth = panelWidthSetting.set;
export const applyPanelWidth = panelWidthSetting.apply;
export const restorePanelWidth = panelWidthSetting.restore;
/** Another window's change, as its `storage` event carries it. */
export const adoptPanelWidth = panelWidthSetting.adopt;

let followingPanelWidth = false;

/** Another window of the app that changes the width, or clears storage, moves this one's panel too, from the first read, as the mute and the sound mix follow (followOtherWindows). */
function followPanelWidth(): void {
  if (followingPanelWidth || typeof window === "undefined") return;
  followingPanelWidth = true;
  window.addEventListener("storage", (event) => {
    if (event.key === PANEL_WIDTH_KEY || event.key === null) adoptPanelWidth(event.key === null ? null : event.newValue);
  });
}

// ---------------------------------------------------------------- tab row

/**
 * "Tab row" (docs/design/design-v1-qol.md 3, Q10, D-261106-178): the panels this device
 * keeps out of the side panel's row of tabs, by role, so More always holds
 * them. Every panel starts in the row, and a panel added later does too,
 * since only the ones left out are stored. Nothing counts use: only these
 * ticks change the row. A DM's and a player's panels are kept apart, so a
 * device that plays in one room and runs another keeps each row.
 */
export type TabRowRole = "dm" | "player";
export type TabRow = Readonly<Record<TabRowRole, readonly string[]>>;

export const TAB_ROW_KEY = "rvtt.tabRow";
export const TAB_ROW_NONE: TabRow = { dm: [], player: [] };

/** A panel id as the registry writes one, and no more of them than a role could have. */
const tabIds = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(id)))].slice(0, 50) : []);

export function parseTabRow(raw: string | null): TabRow {
  if (raw === null) return TAB_ROW_NONE;
  try {
    const v = JSON.parse(raw) as Partial<Record<TabRowRole, unknown>> | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return TAB_ROW_NONE;
    return { dm: tabIds(v.dm), player: tabIds(v.player) };
  } catch {
    return TAB_ROW_NONE;
  }
}

/** The row with one panel ticked into it or out of it, for one role. */
export function withTabKept(row: TabRow, role: TabRowRole, id: string, kept: boolean): TabRow {
  const left = row[role].filter((p) => p !== id);
  return { ...row, [role]: kept ? left : [...left, id] };
}

const tabRowSetting = setting<TabRow>(TAB_ROW_KEY, parseTabRow, (row) => JSON.stringify({ dm: row.dm, player: row.player }));

export const tabRow = tabRowSetting.get;
export const setTabRow = tabRowSetting.set;
export const useTabRow = tabRowSetting.use;
