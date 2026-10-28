import { useCallback, useRef } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { TerrainId } from "#shared/model.ts";
import { cellWord, isHex, sceneGrid, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { ChoiceRows, ChoiceTiles, ConfirmButton, OptButton, OptInput, OptionsStrip, OptSegmented, PickCloses, Stepper, ValueChip, type Slot } from "../measure/controls.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Spinner, useDelayed } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { BRUSH_MAX, BRUSH_MIN } from "./cells.ts";
import { LABEL_SIZES } from "./labelEdit.ts";
import { lightModeHint, sceneHasLights } from "./lightTap.ts";
import { BUILD_MODES, pickBuildMode, TERRAINS, useBuilderStore, type BuildMode, type EdgeKind } from "./store.ts";
import { TERRAIN_SWATCHES } from "./textures.ts";
import { closePolygon } from "./tool.tsx";
import { finishWallLine } from "./hexPointer.ts";
import { heightSlot, type HeightShape, type RoughChoice } from "./heights/store.ts";
import { BUILD_IN_SIGHT } from "./inSight.ts";
import { BUILD_ASKING } from "./ask.ts";
import { useStampSlots } from "./stamps/StampOptions.tsx";
import { HEX_SHAPES, useHeightHint, useHeightSlots } from "./heights/HeightOptions.tsx";
import { LightChip } from "../lights/LightOptions.tsx";
import { HEX_LIMITS } from "../grid/words.ts";

const EDGES: readonly { value: EdgeKind; label: string }[] = [
  { value: "wall", label: "Wall" },
  { value: "door", label: "Door" },
  { value: "secret", label: "Secret door" },
  { value: "window", label: "Window" },
  { value: "none", label: "No wall" },
  { value: "clear", label: "Remove" },
];

/** Walls and doors on a hex scene (HX-D7): each choice draws Wall lines, and there are no grid edges for No wall to take a wall off. */
const HEX_EDGES: readonly { value: EdgeKind; label: string }[] = EDGES.filter((e) => e.value !== "none");

/** What a gesture does on a hex scene, for the modes it builds by hexes (HX-D9). */
const HEX_EDGE_HINTS: Record<EdgeKind, string> = {
  wall: "Tap points for a wall line, then Done, or drag for a straight wall.",
  door: "Tap points for a door, then Done, or drag for one. Tap a door to open, lock or close it.",
  secret: "Tap points for a secret door, then Done, or drag for one.",
  window: "Tap points for a window, then Done, or drag for one.",
  none: "Tap points for a wall line, then Done, or drag for a straight wall.",
  clear: "Tap a wall, door or window to remove it.",
};
const HEX_HINTS = {
  erase: "Drag to erase walls, doors, windows, heights, stairs, difficult ground, labels, stamps and lights.",
  eraseRect: "Drag from corner to corner to erase everything inside.",
} as const;


const HINTS: Record<Exclude<BuildMode, "edge" | "light" | "height" | "rough">, string> = {
  paint: "Drag to paint. Two fingers or a right-drag move the map.",
  rect: "Drag from corner to corner.",
  poly: "Tap corners, then tap the first one to close.",
  erase: "Drag to erase floor and everything on it: walls, doors, windows, heights, stairs, difficult ground, labels, stamps and lights.",
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

/** What painting a terrain does to a walk (docs/design-v1-movement.md 3.4), for the hint of a mode that paints it. */
const TERRAIN_COST = "Difficult and Rubble cost double to walk through. Water costs double without a swim speed.";

/**
 * The modes a hex scene cannot use (section 6): painted ground stays
 * square. Walls and doors, Erase, Erase area, Difficult ground and from H3
 * Height mode build by hexes, and lights, stamps and labels keep their own
 * hints.
 */
const HEX_LEFT_OUT: ReadonlySet<BuildMode> = new Set<BuildMode>(["paint", "rect", "poly"]);

/** The line a hex scene shows for a mode it leaves out, or null where the mode keeps its own hint. */
export function hexBuilderLine(mode: BuildMode, g: Grid): string | null {
  return isHex(g) && HEX_LEFT_OUT.has(mode) ? HEX_LIMITS.builder : null;
}

/** The brush's width as the stepper speaks it, in the scene's cell word. */
export function brushWords(n: number, g: Grid): string {
  return `${n} ${cellWord(g, n !== 1)}`;
}

function hint(mode: BuildMode, edge: EdgeKind, secretFound: boolean, hasLights: boolean, heightHint: string, terrain: TerrainId, g: Grid): string {
  const limit = hexBuilderLine(mode, g);
  if (limit !== null) return limit;
  if (isHex(g) && mode === "edge") {
    if (edge === "secret") return `${HEX_EDGE_HINTS.secret} ${secretFound ? "Players see a door." : "Players see a wall."}`;
    return HEX_EDGE_HINTS[edge];
  }
  if (isHex(g) && (mode === "erase" || mode === "eraseRect")) return HEX_HINTS[mode];
  if (mode === "light") return lightModeHint(hasLights);
  if (mode === "height" || mode === "rough") return heightHint;
  const costs = terrain === "difficult" || terrain === "rubble" || terrain === "water";
  if ((mode === "paint" || mode === "rect" || mode === "poly") && costs) return `${HINTS[mode]} ${TERRAIN_COST}`;
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
      line: b.line,
      lineScene: b.lineScene,
      snapCorners: b.snapCorners,
      note: b.note,
      inSight: b.inSight,
      asking: b.asking > 0,
    })),
  );
  // A gesture waiting on its asks says so once the wait shows (Loading.tsx), so a quick answer never flashes it.
  const asking = useDelayed(s.asking);
  const sceneId = useRoomView((v) => v.sceneId);
  const scene = useRoomView((v) => (v.sceneId ? v.view?.scenes[v.sceneId] : undefined));
  const hasLights = useRoomView((v) => (v.sceneId ? sceneHasLights(v.view?.lights, v.sceneId) : false));
  const actions = useRoomActions();
  const ui = useRoomUi();
  const sceneShape = scene ? sceneGrid(scene) : SQUARES;
  const heightHint = useHeightHint(scene?.autoWalls, s.mode === "rough", sceneShape);
  const heightSlots = useHeightSlots(s.mode === "rough", sceneShape);
  // ⋯ in this row, where focus goes back from the stamp picker when the chooser waits behind it.
  const row = useRef<HTMLDivElement>(null);
  const more = useCallback(() => row.current?.closest('[role="toolbar"]')?.querySelector<HTMLElement>("[data-rvtt-more] button") ?? null, []);
  const stamps = useStampSlots({ more });
  const hexRoughSlots = useHexRoughSlots();
  if (!sceneId || !scene) return null;

  const grid = sceneGrid(scene);
  const hex = isHex(grid);
  const set = builderState.setState;
  const lining = hex && s.mode === "edge" && s.lineScene === sceneId && s.line.length > 0;
  const corners = (s.mode === "poly" && s.poly.length > 0) || lining;
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
    control: (
      <Stepper
        label="Brush size"
        value={s.brush}
        step={1}
        min={BRUSH_MIN}
        max={BRUSH_MAX}
        format={(n) => brushWords(n, grid)}
        less="Smaller brush"
        more="Larger brush"
        onChange={(brush) => set({ brush })}
        // Each step is spoken in the group named Brush size: "Brush size, 3 squares".
        live
      />
    ),
  });
  const mode = BUILD_MODES.find((m) => m.value === s.mode);
  const modeName = mode?.spoken ?? mode?.label ?? s.mode;

  const slots: (Slot | false)[] = [
    {
      id: "mode",
      priority: 1 + drop,
      // The mode's icon, as on its tile (D-261026-3), by the chips' glyph rule (docs/design-v1-tool-options.md 6.2):
      // beside the words where the row has room, and alone where the row's priority-1 controls need the room.
      compact: true,
      glyph: true,
      control: (
        <ValueChip
          label="Builder mode"
          kind="choice"
          value={s.mode}
          valueName={modeName}
          options={BUILD_MODES.map((m) => ({ key: m.value, words: m.short, glyph: <Icon name={m.icon} /> }))}
        >
          <PickCloses>
            <ChoiceTiles<BuildMode> label="Builder mode" even value={s.mode} options={BUILD_MODES.map((m) => ({ value: m.value, label: m.label, ...(m.spoken ? { spoken: m.spoken } : null), glyph: <Icon name={m.icon} /> }))} onChange={(mode) => pickBuildMode(scope, mode)} />
          </PickCloses>
        </ValueChip>
      ),
    },
    { id: "undo", priority: 2 + drop, control: <OptButton icon="undo" label="Undo your last change" rowWords="Undo" shortcut="undo" onClick={() => actions.undo()} /> },
    { id: "redo", priority: 4 + drop, control: <OptButton icon="redo" label="Redo" rowWords="Redo" shortcut="redo" onClick={() => actions.redo()} /> },
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
          <OptButton tone="primary" disabled={s.poly.length < 3 || s.asking} ends onClick={() => closePolygon({ scene, actions, ui, scope })}>
            Close room
          </OptButton>
        ),
      },
      {
        id: "undoCorner",
        priority: 2,
        control: (
          <OptButton icon="undo" disabled={s.poly.length === 0} onClick={() => set({ poly: s.poly.slice(0, -1) })}>
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
    const edges = hex ? HEX_EDGES : EDGES;
    // On hexes No wall has nothing to take away, and a line drawn under it is a wall.
    const edge = hex && s.edge === "none" ? "wall" : s.edge;
    slots.push(
      {
        id: "edge",
        priority: lining ? 4 : 1,
        control: (
          <ValueChip label="Edge" kind="choice" value={edge} options={edges.map((e) => ({ key: e.value, words: e.label }))}>
            <PickCloses>
              <ChoiceRows<EdgeKind> label="Edge" value={edge} options={edges} onChange={(edge) => set({ edge, note: null })} />
            </PickCloses>
          </ValueChip>
        ),
      },
      hex && {
        id: "snapCorners",
        priority: lining ? 5 : 2,
        control: (
          <OptButton label="Snap to hex corners" pressed={s.snapCorners} onClick={() => set({ snapCorners: !s.snapCorners })}>
            Snap
          </OptButton>
        ),
      },
      lining && {
        id: "lineDone",
        priority: 1,
        control: (
          <OptButton tone="primary" disabled={s.line.length < 2 || s.asking} ends onClick={() => finishWallLine({ scene, actions, ui, scope })}>
            Done
          </OptButton>
        ),
      },
      lining && {
        id: "undoPoint",
        priority: 2,
        control: (
          <OptButton icon="undo" onClick={() => set(s.line.length > 1 ? { line: s.line.slice(0, -1) } : { line: [], lineScene: null, lineAt: null })}>
            Undo point
          </OptButton>
        ),
      },
      lining && {
        id: "lineCancel",
        priority: 2,
        control: (
          <OptButton ends onClick={() => set({ line: [], lineScene: null, lineAt: null })}>
            Cancel
          </OptButton>
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
  if (s.mode === "rough") slots.push(...(hex ? hexRoughSlots : heightSlots));
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
        title="Remove every floor, wall, door, height, stair, difficult ground mark, label, light and stamp on this scene"
        // No builder edit goes while a gesture waits on its asks (ask.ts, D-261027-07).
        disabled={s.asking}
        onConfirm={() => actions.dispatch({ t: "build.clear", sceneId })}
      />
    ),
  });

  return (
    <div ref={row} style={{ display: "contents" }}>
      <OptionsStrip tool="Map builder" task={corners || stamped} line={asking ? { tone: "status", content: <Asking /> } : { tone: s.note || s.inSight ? "warning" : "hint", content: s.note ?? (s.inSight ? BUILD_IN_SIGHT : hint(s.mode, s.edge, s.secretFound, hasLights, heightHint, s.terrain, grid)) }} slots={slots} />
      {s.mode === "stamp" ? stamps.picker : null}
    </div>
  );
}

/**
 * Difficult ground mode's slots on a hex scene: Mark or Clear, and the
 * brush in hexes, on the same choices as on squares (heights/store.ts), so
 * a DM's pick carries between scenes. Height mode's own slots name squares.
 */
function useHexRoughSlots(): Slot[] {
  const { store } = useScoped(heightSlot);
  const h = useStore(store, useShallow((v) => ({ rough: v.rough, shape: v.shape })));
  const set = store.setState;
  return [
    {
      id: "rough",
      priority: 1,
      compact: true,
      control: (
        <OptSegmented<RoughChoice>
          label="Difficult ground"
          value={h.rough}
          onChange={(rough) => set({ rough })}
          options={[
            { value: "mark", label: "Mark", title: "Mark difficult ground" },
            { value: "clear", label: "Clear", title: "Clear difficult ground" },
          ]}
        />
      ),
    },
    { id: "heightBrush", priority: 3, compact: true, control: <OptSegmented<HeightShape> label="Brush" value={h.shape} onChange={(shape) => set({ shape })} options={HEX_SHAPES} /> },
  ];
}

/** The builder's line while a gesture's ops wait on the server's answer to its asks (ask.ts). */
function Asking() {
  return (
    <span data-build-asking="" style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1.5) }}>
      <Spinner size={14} />
      {BUILD_ASKING}
    </span>
  );
}
