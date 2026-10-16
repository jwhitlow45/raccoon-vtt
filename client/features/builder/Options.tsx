import { useCallback, useRef } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { TerrainId } from "#shared/model.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { ChoiceRows, ChoiceTiles, ConfirmButton, OptButton, OptInput, OptionsStrip, OptSegmented, PickCloses, ValueChip, type Slot } from "../measure/controls.tsx";
import { theme } from "../../lib/theme.ts";
import type { BrushSize } from "./cells.ts";
import { LABEL_SIZES } from "./labelEdit.ts";
import { lightModeHint, sceneHasLights } from "./lightTap.ts";
import { TERRAINS, useBuilderStore, type BuildMode, type EdgeKind } from "./store.ts";
import { TERRAIN_SWATCHES } from "./textures.ts";
import { closePolygon } from "./tool.tsx";
import { useStampSlots } from "./stamps/StampOptions.tsx";
import { useHeightHint, useHeightSlots } from "./heights/HeightOptions.tsx";
import { LightChip } from "../lights/LightOptions.tsx";

/** Each mode's whole name, which its tile and the chip's name keep, and the short word the chip shows (docs/design-v1-tool-options.md 6.2). */
const MODES: readonly { value: BuildMode; label: string; short: string }[] = [
  { value: "paint", label: "Brush", short: "Brush" },
  { value: "rect", label: "Rectangle room", short: "Rect room" },
  { value: "poly", label: "Shape room", short: "Shape room" },
  { value: "erase", label: "Erase", short: "Erase" },
  { value: "eraseRect", label: "Erase area", short: "Erase area" },
  { value: "edge", label: "Walls and doors", short: "Walls" },
  { value: "height", label: "Heights and stairs", short: "Heights" },
  { value: "label", label: "Label", short: "Label" },
  { value: "light", label: "Lights", short: "Lights" },
  { value: "stamp", label: "Stamp", short: "Stamp" },
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

/** A terrain's swatch, in its chip and above its tile's name. */
function TerrainSwatch(props: { terrain: TerrainId }) {
  return <span aria-hidden style={{ display: "block", width: theme.icon.md, height: theme.icon.md, boxSizing: "border-box", borderRadius: theme.radius.xs, background: TERRAIN_SWATCHES[props.terrain], border: `${theme.line.border}px solid ${theme.color.border}` }} />;
}

/**
 * The builder's options (docs/design-v1-tool-options.md 9.9): what a
 * gesture does on the line, then the mode, Undo and Redo, and each mode's
 * own controls, with Clear build always in ⋯. A room with corners or a
 * selected stamp is a task: its controls lead, and the builder's own drop
 * by 3.
 */
export default function BuilderOptions() {
  // Everything but the stroke in progress, so painting does not re-render the row.
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
  const heightSlots = useHeightSlots();
  // ⋯ in this row, where focus goes back from the stamp picker when the chooser waits behind it.
  const row = useRef<HTMLDivElement>(null);
  const more = useCallback(() => row.current?.closest('[role="toolbar"]')?.querySelector<HTMLElement>("[data-rvtt-more] button") ?? null, []);
  const stamps = useStampSlots({ more });
  if (!sceneId || !scene) return null;

  const set = builderState.setState;
  const corners = s.mode === "poly" && s.poly.length > 0;
  const stamped = s.mode === "stamp" && stamps.selected;
  // A task's controls lead, and the builder's standing settings drop by 3 (9, "The task rule").
  const drop = corners || stamped ? 3 : 0;
  const terrain = (priority: number): Slot => ({
    id: "terrain",
    priority: priority + drop,
    compact: true,
    control: (
      <ValueChip label="Terrain" kind="choice" value={s.terrain} options={TERRAINS.map((t) => ({ key: t.value, words: t.label, swatch: TERRAIN_SWATCHES[t.value] }))}>
        <PickCloses>
          <ChoiceTiles<TerrainId> label="Terrain" value={s.terrain} options={TERRAINS.map((t) => ({ value: t.value, label: t.label, glyph: <TerrainSwatch terrain={t.value} /> }))} onChange={(terrain) => set({ terrain })} />
        </PickCloses>
      </ValueChip>
    ),
  });
  const brush = (priority: number): Slot => ({
    id: "brush",
    priority,
    compact: true,
    control: (
      <OptSegmented<BrushSize>
        label="Brush size"
        value={s.brush}
        onChange={(brush) => set({ brush })}
        options={[
          { value: 1, label: "1", title: "One square" },
          { value: 2, label: "2", title: "Two squares" },
          { value: 3, label: "3", title: "Three squares" },
        ]}
      />
    ),
  });
  const modeName = MODES.find((m) => m.value === s.mode)?.label ?? s.mode;

  const slots: (Slot | false)[] = [
    {
      id: "mode",
      priority: 1 + drop,
      control: (
        <ValueChip label="Builder mode" kind="choice" value={s.mode} valueName={modeName} options={MODES.map((m) => ({ key: m.value, words: m.short }))}>
          <PickCloses>
            <ChoiceTiles<BuildMode> label="Builder mode" value={s.mode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} onChange={(mode) => set({ mode, poly: [], rect: null, run: [], note: null })} />
          </PickCloses>
        </ValueChip>
      ),
    },
    { id: "undo", priority: 2 + drop, control: <OptButton icon="undo" label="Undo your last change" rowWords="Undo" onClick={() => actions.undo()} /> },
    { id: "redo", priority: 4 + drop, control: <OptButton icon="redo" label="Redo" rowWords="Redo" onClick={() => actions.redo()} /> },
  ];
  if (s.mode === "paint") slots.push(terrain(1), brush(3));
  if (s.mode === "rect") slots.push(terrain(1));
  if (s.mode === "erase") slots.push(brush(2));
  if (s.mode === "poly") {
    slots.push(
      terrain(1),
      {
        id: "closeRoom",
        // The room's own control while it has corners. Before the first corner it does nothing yet, so it waits behind the mode and the terrain.
        priority: corners ? 1 : 2,
        control: (
          <OptButton tone="primary" disabled={s.poly.length < 3} ends onClick={() => closePolygon({ scene, actions, scope })}>
            Close room
          </OptButton>
        ),
      },
      {
        id: "undoCorner",
        priority: 2,
        control: (
          <OptButton disabled={s.poly.length === 0} onClick={() => set({ poly: s.poly.slice(0, -1) })}>
            Undo corner
          </OptButton>
        ),
      },
      corners && {
        id: "roomCancel",
        priority: 2,
        control: (
          <OptButton ends onClick={() => set({ poly: [] })}>
            Cancel
          </OptButton>
        ),
      },
    );
  }
  if (s.mode === "edge") {
    slots.push(
      {
        id: "edge",
        priority: 1,
        control: (
          <ValueChip label="Edge" kind="choice" value={s.edge} options={EDGES.map((e) => ({ key: e.value, words: e.label }))}>
            <PickCloses>
              <ChoiceRows<EdgeKind> label="Edge" value={s.edge} options={EDGES} onChange={(edge) => set({ edge, note: null })} />
            </PickCloses>
          </ValueChip>
        ),
      },
      s.edge === "secret" && {
        id: "secret",
        priority: 2,
        compact: true,
        control: (
          <OptSegmented<"hidden" | "found">
            label="Secret door"
            value={s.secretFound ? "found" : "hidden"}
            onChange={(v) => set({ secretFound: v === "found", note: null })}
            options={[
              { value: "hidden", label: "Hidden", title: "Players see a wall" },
              { value: "found", label: "Found", title: "Players see a door" },
            ]}
          />
        ),
      },
    );
  }
  if (s.mode === "height") slots.push(...heightSlots);
  if (s.mode === "label") {
    slots.push(
      { id: "labelText", priority: 1, flex: theme.layout.options.field, control: <OptInput label="Label text" placeholder="Label text" maxLength={80} width={160} value={s.labelText} onChange={(labelText) => set({ labelText })} /> },
      {
        id: "labelSize",
        priority: 2,
        compact: true,
        control: (
          <OptSegmented<number>
            label="Label size"
            value={s.labelSize}
            options={LABEL_SIZES.map((o) => ({ value: o.value, label: o.label, title: `Size ${o.label}` }))}
            onChange={(labelSize) => set({ labelSize })}
          />
        ),
      },
    );
  }
  if (s.mode === "light") slots.push({ id: "light", priority: 1, control: <LightChip /> });
  if (s.mode === "stamp") slots.push(...stamps.slots);
  slots.push({
    id: "clearBuild",
    priority: 9,
    always: true,
    control: (
      <ConfirmButton
        label="Clear build"
        confirm="Tap again to clear"
        title="Remove every floor, wall, door, height, stair, label, light and stamp on this scene"
        onConfirm={() => actions.dispatch({ t: "build.clear", sceneId })}
      />
    ),
  });

  return (
    <div ref={row} style={{ display: "contents" }}>
      <OptionsStrip tool="Map builder" task={corners || stamped} line={{ tone: s.note ? "warning" : "hint", content: s.note ?? hint(s.mode, s.edge, s.secretFound, hasLights, heightHint) }} slots={slots} />
      {s.mode === "stamp" ? stamps.picker : null}
    </div>
  );
}
