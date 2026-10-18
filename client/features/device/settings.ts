import { useSyncExternalStore } from "react";
import { setBoardInterfaceScale } from "../../lib/boardScale.ts";
import { preferredMapVariant, readMapVariantSetting, type MapVariantSetting } from "../../lib/device.ts";
import { formatKeyChanges, parseKeyChanges, type KeyChanges } from "../../state/keyBindings.ts";

/**
 * This device's own settings (docs/design-v1-dm-tools.md 2.7): the
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

type Setting<T> = {
  get(): T;
  set(value: T): void;
  /** Takes a value for this page only, leaving the stored one as it is. */
  apply(value: T): void;
  /** Goes back to the device's own value: the stored one, or the one chosen on this page when storage could not keep it. */
  restore(): void;
  subscribe(listener: () => void): () => void;
  use(): T;
};

function setting<T>(key: string, parse: (raw: string | null) => T, format: (value: T) => string, onChange?: (value: T) => void): Setting<T> {
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
  onChange?.(value);
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const get = () => value;
  const apply = (next: T) => {
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
      apply(next);
    },
    apply,
    restore() {
      const raw = saved ? read(key) : null;
      if (raw !== null) own = parse(raw);
      apply(own);
    },
    subscribe,
    use: () => useSyncExternalStore(subscribe, get),
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

/** "Show others' rolls as they happen" (docs/design-v1-dice.md 8.5), on by default. */
export function parseRollToasts(raw: string | null): boolean {
  return raw !== "off";
}

const rollToastsSetting = setting("rvtt.rollToasts", parseRollToasts, (on) => (on ? "on" : "off"));

export const setRollToasts = rollToastsSetting.set;
export const useRollToastsOn = rollToastsSetting.use;

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
 * `{"v":1,"keys":{"tool:fog":"x"}}`. What they mean against the table is
 * state/shortcuts.ts's to say, since only it knows the defaults.
 */
const keyChangesSetting = setting<KeyChanges>("rvtt.keys", parseKeyChanges, formatKeyChanges);

export const keyChanges = keyChangesSetting.get;
export const setKeyChanges = keyChangesSetting.set;
export const useKeyChanges = keyChangesSetting.use;
