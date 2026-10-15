import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { Segmented } from "../../components/Segmented.tsx";
import { ConfirmButton, InfoLine, OptButton, OptInput, OptionsColumn, OptionsRow, OptSelect } from "../measure/controls.tsx";
import type { BrushSize } from "./cells.ts";
import { LABEL_SIZES } from "./labelEdit.ts";
import { lightModeHint, sceneHasLights } from "./lightTap.ts";
import { TERRAINS, useBuilderStore, type BuildMode, type EdgeKind } from "./store.ts";
import { closePolygon } from "./tool.tsx";
import { StampOptions, useCompactStampBar } from "./stamps/StampOptions.tsx";
import { HeightOptions, useHeightHint } from "./heights/HeightOptions.tsx";
import { LightOptions } from "../lights/LightOptions.tsx";

const MODES: readonly { value: BuildMode; label: string }[] = [
  { value: "paint", label: "Brush" },
  { value: "rect", label: "Rectangle room" },
  { value: "poly", label: "Shape room" },
  { value: "erase", label: "Erase" },
  { value: "eraseRect", label: "Erase area" },
  { value: "edge", label: "Walls and doors" },
  { value: "height", label: "Heights and stairs" },
  { value: "label", label: "Label" },
  { value: "light", label: "Lights" },
  { value: "stamp", label: "Stamp" },
];

const EDGES: readonly { value: EdgeKind; label: string }[] = [
  { value: "wall", label: "Wall" },
  { value: "door", label: "Door" },
  { value: "secret", label: "Secret door" },
  { value: "window", label: "Window" },
  { value: "none", label: "No wall" },
  { value: "clear", label: "Remove" },
];

const HINTS: Record<Exclude<BuildMode, "edge" | "light" | "height">, string> = {
  paint: "Drag to paint. Two fingers or a right-drag move the map.",
  rect: "Drag from corner to corner.",
  poly: "Tap corners, then tap the first one to close.",
  erase: "Drag to erase floor and everything on it: walls, doors, windows, heights, stairs, labels, stamps and lights.",
  eraseRect: "Drag from corner to corner to erase everything inside.",
  label: "Type, then tap the map. Tap a label to edit or delete it, or drag it to move it. In the other modes a tap builds instead.",
  stamp: "Tap the map to place the stamp. Tap a stamp to select it, drag it to move it, and use its handles to turn or resize it. Snap turns in 15 degree steps and moves in half cells.",
};

const EDGE_HINTS: Record<EdgeKind, string> = {
  wall: "Tap an edge, or drag along a grid line. Tap a wall again to take it off.",
  door: "Tap an edge for a door, or drag for a wide one. Tap a door to open, lock or close it. Remove takes it off.",
  secret: "Tap an edge for a secret door, or tap one again to take it off.",
  window: "Tap an edge, or drag along a grid line. Tap a window again to take it off.",
  none: "Tap or drag along a wall around floor to take that wall away.",
  clear: "Tap or drag to remove walls, doors, windows and No wall marks. Walls around floor come back.",
};

function hint(mode: BuildMode, edge: EdgeKind, secretFound: boolean, hasLights: boolean, heightHint: string): string {
  if (mode === "light") return lightModeHint(hasLights);
  if (mode === "height") return heightHint;
  if (mode !== "edge") return HINTS[mode];
  if (edge === "secret") {
    return secretFound
      ? "Tap a secret door to mark it found: players see a door. Tap it again to take it off."
      : "Tap an edge for a hidden door: players see a wall. Tap it again to take it off.";
  }
  return EDGE_HINTS[edge];
}

/** The builder's bar: what a gesture does, then the choices for it. */
export default function BuilderOptions() {
  // Everything but the stroke in progress, so painting does not re-render the bar.
  const builderState = useBuilderStore();
  const scope = useRoomScope();
  const s = useStore(
    builderState,
    useShallow((b) => ({
      mode: b.mode,
      terrain: b.terrain,
      brush: b.brush,
      edge: b.edge,
      secretFound: b.secretFound,
      labelText: b.labelText,
      labelSize: b.labelSize,
      poly: b.poly,
      note: b.note,
    })),
  );
  const sceneId = useRoomView((v) => v.sceneId);
  const scene = useRoomView((v) => (v.sceneId ? v.view?.scenes[v.sceneId] : undefined));
  const hasLights = useRoomView((v) => (v.sceneId ? sceneHasLights(v.view?.lights, v.sceneId) : false));
  const actions = useRoomActions();
  const heightHint = useHeightHint(scene?.autoWalls);
  // A phone's bar with a stamp selected keeps to the stamp's own buttons. Done brings the rest back.
  const stampCompact = useCompactStampBar() && s.mode === "stamp";
  if (!sceneId || !scene) return null;

  const set = builderState.setState;
  const terrainPicker = <OptSelect label="Terrain" value={s.terrain} options={TERRAINS} onChange={(terrain) => set({ terrain })} />;
  const brushPicker = (
    <Segmented<BrushSize>
      label="Brush size"
      value={s.brush}
      onChange={(brush) => set({ brush })}
      options={[
        { value: 1, label: "1", title: "One square" },
        { value: 2, label: "2", title: "Two squares" },
        { value: 3, label: "3", title: "Three squares" },
      ]}
    />
  );

  return (
    <OptionsColumn>
      {stampCompact && !s.note ? null : <InfoLine tone={s.note ? "warning" : "muted"}>{s.note ?? hint(s.mode, s.edge, s.secretFound, hasLights, heightHint)}</InfoLine>}
      <OptionsRow label="Map builder">
        <OptSelect<BuildMode> label="Builder mode" value={s.mode} options={MODES} onChange={(mode) => set({ mode, poly: [], rect: null, run: [], note: null })} />
        <OptButton label="Undo your last change" onClick={() => actions.undo()}>
          Undo
        </OptButton>
        <OptButton label="Redo" onClick={() => actions.redo()}>
          Redo
        </OptButton>
        {s.mode === "paint" ? (
          <>
            {terrainPicker}
            {brushPicker}
          </>
        ) : null}
        {s.mode === "erase" ? brushPicker : null}
        {s.mode === "rect" ? terrainPicker : null}
        {s.mode === "poly" ? (
          <>
            {terrainPicker}
            <OptButton tone="primary" disabled={s.poly.length < 3} onClick={() => closePolygon({ scene, actions, scope })}>
              Close room
            </OptButton>
            <OptButton disabled={s.poly.length === 0} onClick={() => set({ poly: s.poly.slice(0, -1) })}>
              Undo corner
            </OptButton>
            {s.poly.length > 0 ? <OptButton onClick={() => set({ poly: [] })}>Cancel</OptButton> : null}
          </>
        ) : null}
        {s.mode === "edge" ? <OptSelect<EdgeKind> label="Edge" value={s.edge} options={EDGES} onChange={(edge) => set({ edge, note: null })} /> : null}
        {s.mode === "edge" && s.edge === "secret" ? (
          <Segmented<"hidden" | "found">
            label="Secret door"
            value={s.secretFound ? "found" : "hidden"}
            onChange={(v) => set({ secretFound: v === "found", note: null })}
            options={[
              { value: "hidden", label: "Hidden", title: "Players see a wall" },
              { value: "found", label: "Found", title: "Players see a door" },
            ]}
          />
        ) : null}
        {s.mode === "label" ? (
          <>
            <OptInput label="Label text" placeholder="Label text" maxLength={80} width={160} value={s.labelText} onChange={(labelText) => set({ labelText })} />
            <Segmented<number>
              label="Label size"
              value={s.labelSize}
              options={LABEL_SIZES.map((o) => ({ value: o.value, label: o.label, title: `Size ${o.label}` }))}
              onChange={(labelSize) => set({ labelSize })}
            />
          </>
        ) : null}
        {s.mode === "stamp" ? <StampOptions /> : null}
        {s.mode === "height" ? <HeightOptions /> : null}
        {s.mode === "light" ? <LightOptions /> : null}
        {stampCompact ? null : (
          <ConfirmButton
            label="Clear build"
            confirm="Tap again to clear"
            title="Remove every floor, wall, door, height, stair, label, light and stamp on this scene"
            onConfirm={() => actions.dispatch({ t: "build.clear", sceneId })}
          />
        )}
      </OptionsRow>
    </OptionsColumn>
  );
}
