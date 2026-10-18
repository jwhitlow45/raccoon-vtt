/**
 * Facts about this device that change what the client loads or how it
 * behaves. The decisions are pure functions, with thin readers of the
 * browser beside them.
 */

export type MapVariantSetting = "auto" | "full" | "mobile";

const MAP_VARIANT_KEY = "rvtt.mapVariant";

/**
 * Phones load the `mobile` map variant (at most 4096 px) by default, and a
 * device setting can switch to `full` (design section 11.2). An 8192 px map
 * decodes to 256 MiB, which an iPhone or a small iPad cannot spare, so
 * "phone" here means a touch-first device whose shorter screen side is under
 * the 900 px tablet layout breakpoint.
 */
export function preferredMapVariant(input: {
  coarsePointer: boolean;
  shortSidePx: number;
  setting: MapVariantSetting;
}): "full" | "mobile" {
  if (input.setting !== "auto") return input.setting;
  return input.coarsePointer && input.shortSidePx < 900 ? "mobile" : "full";
}

export function readMapVariantSetting(): MapVariantSetting {
  try {
    const value = localStorage.getItem(MAP_VARIANT_KEY);
    return value === "full" || value === "mobile" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function deviceMapVariant(): "full" | "mobile" {
  return preferredMapVariant({
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    shortSidePx: Math.min(screen.width, screen.height),
    setting: readMapVariantSetting(),
  });
}

export function isCoarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * A computer: a device whose main pointer is fine, a mouse or a trackpad.
 * The token window resizes only here (docs/design-v1-token-window.md 5.1),
 * since its 24 px handle is a fine pointer's target.
 */
export function isFinePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
}

/**
 * Whether Ctrl with a click is a right click here, as on a Mac, an iPad
 * and an iPhone, where Cmd takes the part Ctrl has on Windows and Linux.
 * An iPad asks for desktop pages and calls itself a Mac, so it counts
 * either way.
 */
export function appleKeys(input: { platform: string; userAgent: string }): boolean {
  return /^(Mac|iPhone|iPad|iPod)/.test(input.platform) || /iP(hone|ad|od)/.test(input.userAgent);
}

export function isAppleDevice(): boolean {
  return typeof navigator !== "undefined" && appleKeys({ platform: navigator.platform, userAgent: navigator.userAgent });
}

/**
 * What the shortcut sheet shows for this device: the mouse's rows where
 * there is a mouse or trackpad, even beside a touch screen, and the Back
 * button's row on Android, where Back is a button of the phone itself.
 */
export function sheetDevice(): { mouse: boolean; android: boolean } {
  return {
    mouse: typeof matchMedia !== "function" || matchMedia("(any-pointer: fine)").matches,
    android: typeof navigator !== "undefined" && /Android/.test(navigator.userAgent),
  };
}

let keyboardSeen = false;

/**
 * A key pressed outside a text field, which an on-screen keyboard never
 * types there: a keyboard is attached, as on a tablet with a keyboard case
 * and no trackpad. The room's shortcut listener reports every such press.
 */
export function noteKeyboard(key: string): void {
  if (key !== "" && key !== "Unidentified" && key !== "Process") keyboardSeen = true;
}

/**
 * Whether this device has a keyboard, as far as a page can tell: a mouse
 * or trackpad, as every computer has, or a key pressed on this page. The
 * shortcut sheet offers to change keys only then, so a touch screen's
 * sheet stays a plain list.
 */
export function hasKeyboard(): boolean {
  return keyboardSeen || sheetDevice().mouse;
}

const NAME_KEY = "rvtt.name";

/** The last display name used on this device, as a convenience for the next form. */
export function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private mode or storage full. Only a convenience is lost.
  }
}
