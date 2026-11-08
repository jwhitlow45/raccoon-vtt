import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ON_BOARD, ON_BOARD_STYLE } from "../../lib/theme.ts";
import { useLayoutSize } from "../device/layout.ts";
import { HandoutViewer } from "../handouts/HandoutViewer.tsx";
import { exportContent } from "../mapexport/content.ts";
import { renderMapPng } from "../mapexport/render.ts";
import { exportSize, MAX_EXPORT_PIXELS, MAX_EXPORT_SIDE, MOBILE_MAP_SIDE } from "../mapexport/size.ts";
import { DIALOG_PHONE_MAX } from "../../components/Dialog.tsx";
import { drawMarks } from "./marks.ts";
import type { Drawn } from "./Preview.tsx";
import { LOOK_CLOSER, LOOK_CLOSER_DETAILS, LOOK_CLOSER_FAILED } from "./words.ts";

/** Look closer draws this many pixels a square, lowered to what the device can hold (D-261107-208). */
const LOOK_PX_PER_CELL = 40;

type Closer = { src: string; width: number; height: number };

/** A frame's callback runs before that frame paints, so a task after it is the first moment the page has painted what came before. */
export const afterPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/**
 * Look closer (phase 2, 4.2): the preview's DM view at 40 px a square with
 * its marks drawn in, opened in the handout viewer for pinch and wheel zoom.
 * A tap says "Drawing the dungeon…" at once through `onDrawing`, waits for
 * that to paint, then does the long render. Closing returns focus here.
 */
export function LookCloser(props: { drawn: Drawn | null; name: string; disabled: boolean; onDrawing(on: boolean): void; onFailed(text: string | null): void }) {
  const { drawn } = props;
  const button = useRef<HTMLButtonElement>(null);
  const layout = useLayoutSize();
  const phone = layout.width < DIALOG_PHONE_MAX;
  const [closer, setCloser] = useState<Closer | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A picture's URL goes with its viewer.
  useEffect(() => (closer ? () => URL.revokeObjectURL(closer.src) : undefined), [closer]);

  const open = async () => {
    if (!drawn || busy) return;
    setBusy(true);
    props.onDrawing(true);
    props.onFailed(null);
    try {
      await afterPaint();
      const picture = await renderCloser(drawn, phone);
      if (mounted.current) setCloser(picture);
    } catch {
      if (mounted.current) props.onFailed(LOOK_CLOSER_FAILED);
    } finally {
      if (mounted.current) {
        setBusy(false);
        props.onDrawing(false);
      }
    }
  };

  return (
    <>
      <Button ref={button} size="sm" {...ON_BOARD} style={ON_BOARD_STYLE} disabled={props.disabled || busy || !drawn} onClick={() => void open()}>
        {LOOK_CLOSER}
      </Button>
      {closer ? (
        <HandoutViewer
          title={props.name}
          showing="dungeon-look-closer"
          details={LOOK_CLOSER_DETAILS}
          opener={button}
          backClose
          onClose={() => setCloser(null)}
          pages={[{ src: closer.src, alt: `${props.name}, the DM view`, width: closer.width, height: closer.height }]}
        />
      ) : null}
    </>
  );
}

/** The DM view at `exportSize(bounds, 40)`, at most the mobile side on a phone, with the marks drawn on before it is encoded. */
export async function renderCloser(drawn: Drawn, phone: boolean): Promise<Closer> {
  const sceneId = Object.keys(drawn.room.scenes)[0];
  const scene = sceneId ? drawn.room.scenes[sceneId] : undefined;
  if (!sceneId || !scene) throw new Error("no scene to draw");
  const side = phone ? MOBILE_MAP_SIDE : MAX_EXPORT_SIDE;
  const size = exportSize(scene.bounds, LOOK_PX_PER_CELL, { maxPixels: Math.min(MAX_EXPORT_PIXELS, side * side), maxSide: side });
  const content = exportContent({ buildChunks: drawn.room.buildChunks, labels: {}, fogTiles: {}, stamps: drawn.room.stamps, scene, view: "dm" });
  const blob = await renderMapPng({
    scene,
    size,
    content,
    grid: false,
    map: null,
    encode: (canvas) => {
      const g = canvas.getContext("2d");
      if (g) drawMarks(g, drawn.plan, drawn.room, sceneId, size.pxPerCell);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    },
  });
  return { src: URL.createObjectURL(blob), width: size.width, height: size.height };
}
