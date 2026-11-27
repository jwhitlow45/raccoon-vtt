import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ModelRef } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets } from "../../state/view.ts";
import { useLayoutSize } from "../device/layout.ts";
import { useUiScale } from "../device/settings.ts";
import { frameCrop, modelArtBox, modelDrawnBox, type FrameBox } from "./frames.ts";

/**
 * The 3D model sheet's preview (docs/design/design-v1-token-models.md 3.1
 * and 7): one of the model's 8 views standing on its ring over four
 * squares of floor, as it stands in Isometric, with Turn left and Turn
 * right under it. Left and Right turn it while it has focus. Nothing
 * turns on its own, so reduced motion changes nothing.
 */

/** The view a frame shows, as a turn announces it: frame i is the model turned 45 i degrees clockwise from facing the camera. */
export const VIEW_WORDS = ["the front", "the front left", "the left", "the back left", "the back", "the back right", "the right", "the front right"] as const;

/** What the preview's image is named: the model, seen from where its frame shows it. */
export function viewLabel(frame: number): string {
  return `The model, seen from ${VIEW_WORDS[mod(frame, MODEL_LIMITS.frames)]}`;
}

/** The sheet the preview draws: one just drawn, still on this device, or one stored in the room. */
export type PreviewSheet = { blob: Blob } | { assetId: string };

/** The floor's two tones and its squares' line: the board's raised stone, lit and plain, as Isometric draws a side. */
const FLOOR = { plain: theme.relief.side, lit: "#6a665f", line: theme.relief.squareLine };

/**
 * Where everything stands in the preview, in view units with the ring's
 * middle at 0, 0: the union of the 8 drawn boxes, so a turn never moves or
 * rescales the floor, and the four squares round the ring.
 */
export function previewFit(model: Pick<ModelRef, "side" | "anchorY" | "boxes">, px: number): { scale: number; x: number; y: number } {
  const art = modelArtBox(model, 1, { x: 0, y: 0 });
  const union: FrameBox = { x0: -Math.SQRT2, y0: -Math.SQRT1_2, x1: Math.SQRT2, y1: Math.SQRT1_2 };
  for (const box of model.boxes) {
    const drawn = modelDrawnBox(art, box);
    union.x0 = Math.min(union.x0, drawn.x0);
    union.y0 = Math.min(union.y0, drawn.y0);
    union.x1 = Math.max(union.x1, drawn.x1);
    union.y1 = Math.max(union.y1, drawn.y1);
  }
  const room = px * 0.9;
  const scale = room / Math.max(union.x1 - union.x0, union.y1 - union.y0);
  return { scale, x: px / 2 - ((union.x0 + union.x1) / 2) * scale, y: px / 2 - ((union.y0 + union.y1) / 2) * scale };
}

type Drawable = { image: CanvasImageSource; width: number; height: number; close?: () => void };

/**
 * Decodes the sheet: a Blob into a bitmap, a stored sheet through its full
 * copy, same-origin. A bitmap is closed only once a render no longer draws
 * it, after the next one took its place or the preview went, since a
 * closed bitmap throws in drawImage.
 */
function useSheet(sheet: PreviewSheet): Drawable | null | "failed" {
  const assets = useAssets();
  const key = "blob" in sheet ? sheet.blob : sheet.assetId;
  const [loaded, setLoaded] = useState<{ key: Blob | string; drawable: Drawable | "failed" } | null>(null);
  useEffect(() => {
    let live = true;
    const load = async (): Promise<Drawable> => {
      if ("blob" in sheet) {
        const bitmap = await createImageBitmap(sheet.blob);
        return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      }
      const img = new Image();
      img.src = assets.url(sheet.assetId, "full");
      await img.decode();
      return { image: img, width: img.naturalWidth, height: img.naturalHeight };
    };
    load().then(
      (drawable) => {
        if (live) setLoaded({ key, drawable });
        else drawable.close?.();
      },
      () => {
        if (live) setLoaded({ key, drawable: "failed" });
      },
    );
    return () => {
      live = false;
    };
    // The key stands for the sheet, so a new object naming the same one loads nothing again.
  }, [key, assets]);
  useEffect(() => {
    const drawable = loaded?.drawable;
    return () => {
      if (drawable && drawable !== "failed") drawable.close?.();
    };
  }, [loaded]);
  // Until the new sheet decodes, the old one's views would stand at the new one's sizes, so the floor stands alone.
  return loaded && loaded.key === key ? loaded.drawable : null;
}

export function ModelPreview(props: { sheet: PreviewSheet; model: Pick<ModelRef, "side" | "anchorY" | "boxes">; ring?: string; id?: string; autoFocus?: boolean }) {
  const layout = useLayoutSize();
  const scale = useUiScale();
  // 240 px, or 200 under 360 px wide and at larger interface sizes, so the options still fit beside it.
  const px = layout.width < 360 || scale > 1 ? 200 : 240;
  const [frame, setFrame] = useState(0);
  const [said, setSaid] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  // A canvas takes no autoFocus from React, which focuses only fields and buttons. Focused before the dialog opens, it keeps the first focus (lib/modalDialog.ts).
  const { autoFocus } = props;
  useLayoutEffect(() => {
    if (autoFocus) canvas.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const sheet = useSheet(props.sheet);
  const ring = props.ring ?? theme.color.ally;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    el.width = Math.round(px * dpr);
    el.height = Math.round(px * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, px, px);
    const fit = previewFit(props.model, px);
    const at = (wx: number, wy: number) => ({ x: fit.x + (Math.SQRT1_2 * (wx - wy)) * fit.scale, y: fit.y + ((Math.SQRT1_2 * (wx + wy)) / 2) * fit.scale });
    // Four squares round the ring, as Isometric's first view draws the ground.
    for (const [cx, cy, tone] of [[-1, -1, FLOOR.lit], [0, -1, FLOOR.plain], [-1, 0, FLOOR.plain], [0, 0, FLOOR.lit]] as const) {
      const corners = [at(cx, cy), at(cx + 1, cy), at(cx + 1, cy + 1), at(cx, cy + 1)];
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = tone;
      ctx.fill();
      ctx.strokeStyle = FLOOR.line;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // The ring: a footprint's circle on the ground, filled as a standee's is, in its disposition's color.
    ctx.beginPath();
    ctx.ellipse(fit.x, fit.y, 0.5 * fit.scale, 0.25 * fit.scale, 0, 0, Math.PI * 2);
    ctx.fillStyle = theme.relief.ring;
    ctx.fill();
    ctx.strokeStyle = ring;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!sheet || sheet === "failed") return;
    const art = modelArtBox(props.model, 1, { x: 0, y: 0 });
    const crop = frameCrop(frame, sheet);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sheet.image, crop.x, crop.y, crop.width, crop.height, fit.x + art.x0 * fit.scale, fit.y + art.y0 * fit.scale, (art.x1 - art.x0) * fit.scale, (art.y1 - art.y0) * fit.scale);
  }, [px, frame, sheet, props.model, ring]);

  const turn = (by: number) => {
    const next = mod(frame + by, MODEL_LIMITS.frames);
    setFrame(next);
    setSaid(`Seen from ${VIEW_WORDS[next]}.`);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      turn(e.key === "ArrowLeft" ? -1 : 1);
    }
  };

  return (
    // At the sheet's left edge, as the help and the buttons under it stand.
    <div style={{ display: "grid", justifyItems: "start", gap: theme.space(2) }}>
      <canvas
        ref={canvas}
        id={props.id}
        role="img"
        tabIndex={0}
        data-model-preview=""
        data-frame={frame}
        aria-label={sheet === "failed" ? "The model's views did not load" : viewLabel(frame)}
        onKeyDown={onKey}
        style={{ width: px, height: px, borderRadius: theme.radius.md, background: theme.color.stage, display: "block" }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        <Button size="sm" icon="turnLeft" onClick={() => turn(-1)}>
          Turn left
        </Button>
        <Button size="sm" icon="turnRight" onClick={() => turn(1)}>
          Turn right
        </Button>
      </div>
      <span role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        {said}
      </span>
    </div>
  );
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
