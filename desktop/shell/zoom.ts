import type { Platform } from "../contract.ts";

/**
 * The window zooms from 100% to 150% (design 9) in the app's steps of 10%,
 * so its layout is only ever drawn at sizes its checks measured.
 */
export const ZOOM_STEPS = [1, 1.1, 1.2, 1.3, 1.4, 1.5] as const;

/** The step after `current` in `direction`, or 100% for 0. Off-step values snap to the nearest step first. */
export function zoomStep(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return 1;
  let nearest = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i]! - current) < Math.abs(ZOOM_STEPS[nearest]! - current)) nearest = i;
  }
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, nearest + direction));
  return ZOOM_STEPS[next]!;
}

/** The parts of Electron's `before-input-event` input a zoom key reads. */
export type KeyInput = { type: string; key: string; control: boolean; meta: boolean; alt: boolean };

/**
 * Which way a key zooms: Ctrl (Cmd on macOS) with plus, equals, minus or 0,
 * as in a browser, or null for any other key. Equals counts as plus, since
 * plus needs Shift on most keyboards.
 */
export function zoomKey(input: KeyInput, platform: Platform): -1 | 0 | 1 | null {
  if (input.type !== "keyDown" || input.alt) return null;
  const modifier = platform === "darwin" ? input.meta : input.control;
  if (!modifier) return null;
  switch (input.key) {
    case "+":
    case "=":
      return 1;
    case "-":
    case "_":
      return -1;
    case "0":
      return 0;
    default:
      return null;
  }
}
