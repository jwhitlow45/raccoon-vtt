import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { BuildChunk, FogTile, Scene } from "#shared/model.ts";
import { measurePill } from "../../../canvas/measureText.ts";
import { VISUALLY_HIDDEN } from "../../../lib/a11y.ts";
import { worldToScreen, type Camera, type Insets, type Size } from "../../../lib/camera.ts";
import { theme } from "../../../lib/theme.ts";
import { useScoped } from "../../../state/scope.ts";
import { TOAST_MS } from "../../../state/store.ts";
import { useIsDisplay, useRoomView } from "../../../state/view.ts";
import { LOWERED_EDGE, RAISED_EDGE } from "./boardText.ts";
import { pillOutline, POINTER_PX, readoutPlace, type ReadoutWords } from "./ground.ts";
import { closeReadout, followReadout, readoutSlot } from "./store.ts";
import { wordsAt } from "./tap.ts";

const EMPTY_CHUNKS: Readonly<Record<string, BuildChunk>> = {};
const EMPTY_FOG: Readonly<Record<string, FogTile>> = {};
/** The board's small screen-size pill (measure/Pill.tsx `small`): 12 px bold with 4 px of padding. */
const FONT_PX = 12;
const PAD_PX = 4;
const BODY_HEIGHT = Math.round(FONT_PX * 1.15 + 2 * PAD_PX);
/** The board pills' 1.5 px outline. */
const EDGE_PX = 1.5;

/**
 * The height readout (docs/design-v1-heights-readout.md section 2): a small
 * pill over the cell a tap with the Select tool read, such as "↑10 ft" or
 * "Stairs", and a status line that speaks it. It is a DOM element rather
 * than a Konva pill, so it keeps clear of the top bar and the docks, which
 * a Konva pill with a pointer ignores.
 *
 * The pill reads its cell from this viewer's own view on each render, so it
 * follows a DM's repaint and goes when the ground turns 0 or the fog covers
 * it, and the status line follows it. It also goes on the next tap on the map, a token selection, a change
 * of tool or scene, or after a toast's time. A pan or a pinch keeps it on
 * its cell. It takes no pointer and no focus.
 *
 * The status line stays on the page, empty, while the map is open, so a
 * screen reader already knows it when the first reading arrives. Only the
 * pill comes and goes.
 */
export function ReadoutHost(props: { scene: Scene; tool: string; camera: Camera; viewport: Size; insets: Insets }) {
  const slot = useScoped(readoutSlot);
  const readout = useStore(slot.store, (s) => s.readout);
  const spoken = useStore(slot.store, (s) => s.spoken);
  const chunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const fogTiles = useRoomView((s) => s.view?.fogTiles ?? EMPTY_FOG);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const tokenSelected = useRoomView((s) => s.local.selectedId !== null);
  // A table display takes no taps (docs/design-v1-dm-tools.md 3.1), so it never shows one.
  const display = useIsDisplay();
  const { scene } = props;
  const words = useMemo(() => {
    if (!readout || readout.sceneId !== scene.id) return null;
    return wordsAt({ buildChunks: chunks, fogTiles }, scene, role, readout.cell);
  }, [readout, chunks, fogTiles, role, scene]);
  const open = words !== null && props.tool === "select" && !tokenSelected && !display;

  useEffect(() => {
    if (readout && !open) closeReadout(slot);
  }, [readout, open, slot]);

  // The status line says what the pill says, after a repaint or a stair change under it too.
  useEffect(() => {
    if (open && words) followReadout(slot, words.spoken);
  }, [open, words, slot]);

  // One timer for the toast's time, and no animation loop.
  useEffect(() => {
    if (!readout) return;
    const timer = setTimeout(
      () => {
        if (slot.store.getState().readout?.id === readout.id) closeReadout(slot);
      },
      Math.max(0, readout.at + TOAST_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [readout, slot]);

  return (
    <>
      <div role="status" aria-live="polite" data-rvtt-height-status="" style={VISUALLY_HIDDEN}>
        {spoken}
      </div>
      {open && readout ? (
        <ReadoutPill words={words} cell={readout.cell} camera={props.camera} viewport={props.viewport} insets={props.insets} />
      ) : null}
    </>
  );
}

function ReadoutPill(props: { words: ReadoutWords; cell: { x: number; y: number }; camera: Camera; viewport: Size; insets: Insets }) {
  const { words } = props;
  const width = Math.ceil(measurePill(words.pill, FONT_PX, theme.font.body)) + 2 * PAD_PX;
  const anchor = worldToScreen(props.camera, { x: props.cell.x + 0.5, y: props.cell.y + 0.5 });
  const place = readoutPlace({ anchor, viewport: props.viewport, insets: props.insets, width, height: BODY_HEIGHT });
  if (!place) return null;
  const bodyTop = place.pointer?.side === "up" ? POINTER_PX : 0;
  return (
    <div
      aria-hidden
      data-rvtt-height-pill=""
      style={{
        position: "absolute",
        left: place.left,
        top: place.top,
        width,
        height: BODY_HEIGHT + POINTER_PX,
        zIndex: theme.z.pane,
        // The chrome layer gives its children pointer events (globals.css), and the pill must never take a tap meant for the map.
        pointerEvents: "none",
      }}
    >
      <svg width={width} height={BODY_HEIGHT + POINTER_PX} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <path d={pillOutline(width, BODY_HEIGHT, place.pointer)} fill={theme.color.overlay} stroke={words.edge === "raised" ? RAISED_EDGE : LOWERED_EDGE} strokeWidth={EDGE_PX} />
      </svg>
      <span
        style={{
          position: "absolute",
          left: 0,
          top: bodyTop,
          width,
          height: BODY_HEIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: theme.font.body,
          fontSize: FONT_PX,
          fontWeight: theme.weight.bold,
          lineHeight: 1,
          color: theme.color.text,
          whiteSpace: "nowrap",
        }}
      >
        {words.pill}
      </span>
    </div>
  );
}
