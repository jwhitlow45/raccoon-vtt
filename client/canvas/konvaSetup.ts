import Konva from "konva/lib/Core";
// The shapes the board draws, each registered with Konva as it loads (see below).
import "konva/lib/shapes/Arc";
import "konva/lib/shapes/Arrow";
import "konva/lib/shapes/Circle";
import "konva/lib/shapes/Ellipse";
import "konva/lib/shapes/Image";
import "konva/lib/shapes/Label";
import "konva/lib/shapes/Line";
import "konva/lib/shapes/Path";
import "konva/lib/shapes/Rect";
import "konva/lib/shapes/Text";
import { pixelRatioFor } from "../features/device/settings.ts";
import { isCoarsePointer } from "../lib/device.ts";

/**
 * Konva globals, set before the first Stage is created (design sections
 * 14.2 and 14.3).
 *
 * - Pixel ratio capped at 2: a 3x phone would otherwise allocate 2.25 times
 *   the canvas memory for every layer, for detail nobody sees on a map. Low
 *   power (docs/design-v1-dm-tools.md 3.15) draws at 1, a quarter of the
 *   pixels on most phones. Konva reads the ratio when a layer's canvas is
 *   made, so the map canvas (Stage.tsx) sets it as it draws and remounts its
 *   stage when the setting changes.
 * - An 8 px drag threshold on touch, so a tap never nudges a token. A mouse
 *   is precise enough for a smaller one.
 *
 * Konva's core and the shapes above stand in for the whole library, whose
 * Transformer, filters, text on a path and other shapes the board never
 * uses: about 45 kB of the room chunk. vite.config.ts points `react-konva`
 * at its own core entry for the same reason, since its main entry imports
 * all of Konva. A new react-konva element (a <Star>, say) needs its shape
 * imported here, or React throws that Konva has no node of that type.
 */
/** Sets the ratio the next stage's layers are made with. */
export function applyPixelRatio(lowPower: boolean): void {
  Konva.pixelRatio = pixelRatioFor(lowPower, window.devicePixelRatio);
}

Konva.pixelRatio = pixelRatioFor(false, window.devicePixelRatio);
Konva.dragDistance = isCoarsePointer() ? 8 : 3;

export { Konva };
