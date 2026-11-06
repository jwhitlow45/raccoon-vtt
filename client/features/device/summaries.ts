import { grabberDesign, type GrabberId } from "../../components/grabberDesigns.ts";
import type { ThisDeviceSection } from "../../lib/folds.ts";
import { ANIMATED_MAPS_WORDS, type AnimatedMapsChoice } from "../animmap/words.ts";
import { THEME_CHOICE_WORDS, uiScaleLabel, WEATHER_MODE_WORDS, type ThemeChoice, type UiScale, type WeatherMode } from "./settings.ts";

/*
 * What a folded group of This device says it holds
 * (docs/design/design-v1-panel-groups.md 6.2): each setting's value in the
 * words its control shows. Plain functions, for node --test.
 */

/** Map detail's two image sizes, as its cards name them. */
export const MAP_IMAGE_WORDS: Readonly<Record<"mobile" | "full", string>> = { mobile: "Phone size", full: "Full size" };

export type DeviceValues = {
  scale: UiScale;
  theme: ThemeChoice;
  fullscreen: boolean;
  lowPower: boolean;
  /** The map images this device asks for, before Low power's rule. */
  variant: "mobile" | "full";
  /** The Animated maps choice, or null while the server offers no animated maps and the row is hidden. */
  animatedMaps: AnimatedMapsChoice | null;
  weather: WeatherMode;
  /** A reason keeps the weather still though Moving is chosen (weather/store.ts weatherStillReason). */
  weatherHeld: boolean;
  /** A reason keeps every animated map still though Moving is chosen (AnimMapController.tsx useDeviceStillReason). */
  animatedHeld: boolean;
  roomSound: boolean;
  rollAnimation: boolean;
  handle: GrabberId;
  /** How many panels This device's Tab row keeps out of the side panel's row, for the viewer's role. */
  tabsLeftOut: number;
};

const join = (parts: readonly (string | null)[]): string => parts.filter((p) => p !== null).join(" · ");
const onOff = (name: string, on: boolean): string => `${name} ${on ? "on" : "off"}`;

/** Every group's summary, or undefined for Shortcuts, which holds no setting. */
export function deviceSummaries(v: DeviceValues): Readonly<Record<ThisDeviceSection, string | undefined>> {
  return {
    size: uiScaleLabel(v.scale),
    theme: THEME_CHOICE_WORDS[v.theme],
    screen: onOff("Full screen", v.fullscreen),
    battery: onOff("Low power", v.lowPower),
    // The value the cards show: Low power loads the phone size whatever is chosen.
    mapDetail: join([MAP_IMAGE_WORDS[v.lowPower ? "mobile" : v.variant], v.animatedMaps ? ANIMATED_MAPS_WORDS[v.animatedMaps] : null, v.animatedMaps === "moving" && v.animatedHeld ? "Held still" : null]),
    // Held still only says something while Moving is chosen: Still and Off are still already.
    weather: join([WEATHER_MODE_WORDS[v.weather], v.weather === "moving" && v.weatherHeld ? "Held still" : null]),
    sounds: onOff("Room sound", v.roomSound),
    rolls: onOff("Roll animation", v.rollAnimation),
    shortcuts: undefined,
    handle: grabberDesign(v.handle).name,
    tabRow: v.tabsLeftOut === 0 ? "Every panel" : `${v.tabsLeftOut} only in More`,
  };
}
