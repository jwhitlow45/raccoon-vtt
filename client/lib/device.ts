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

/** Which kinds of pointer this device has: a mouse or trackpad (`fine`), a touch screen (`coarse`), or both. */
export function pointerKinds(): { fine: boolean; coarse: boolean } {
  if (typeof matchMedia !== "function") return { fine: true, coarse: false };
  return { fine: matchMedia("(any-pointer: fine)").matches, coarse: matchMedia("(any-pointer: coarse)").matches };
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
