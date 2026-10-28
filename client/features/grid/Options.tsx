import { useState } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { cellWord, isHex, sceneGrid } from "#shared/rules/grid.ts";
import { theme } from "../../lib/theme.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { OptButton, OptionsStrip, StripText, ValueChip } from "../measure/controls.tsx";
import { fitBounds, nudgeBox, sameCalibration, type CalBox } from "./calibrate.ts";
import { applyGrid, boxAround, fallbackOps, middleOf } from "./outcome.ts";
import { boxCalibration, endFinding, useGridStore, type Fallback } from "./store.ts";
import { useFindGrid } from "./useFindGrid.ts";
import { HEX_LIMITS } from "./words.ts";

/** One canonical pixel per nudge: on the largest maps a thirtieth of a square or less. */
const STEP = 1;

/**
 * The grid tool's options (docs/design-v1-tool-options.md 9.10): Apply,
 * Use default after an import applied a grid it found, Find the grid
 * (docs/design-v1-grid-detect.md section 6), the nudges behind a chip, and
 * the box's square size. Applying sends one `scene.setGrid` (and, when
 * the scene should match the map, one `scene.update` for its size).
 * Resize scene and Grid lines are always in ⋯. After Apply the line says
 * the grid is saved until the box moves again, since an unavailable
 * button alone did not.
 *
 * On a hex scene (docs/design-v1-hex-grids.md HX-D12) the box holds 7
 * hexes, the words say hexes, and Find the grid is off with its reason,
 * since it finds square grids only until a later phase.
 */
export default function GridOptions() {
  const sceneId = useRoomView((s) => s.sceneId);
  const scene = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId] : undefined));
  const gridState = useGridStore();
  const box = useStore(gridState, (s) => s.box);
  const fitScene = useStore(gridState, (s) => s.fitScene);
  const found = useStore(gridState, (s) => s.found);
  const finding = useStore(gridState, (s) => s.finding);
  const actions = useRoomActions();
  const findGrid = useFindGrid();
  /** The box last applied, to say so while it stands. */
  const [applied, setApplied] = useState<CalBox | null>(null);

  if (!scene || !sceneId) return null;
  const map = scene.map;
  if (!map) return <OptionsStrip tool="Line up grid" line={{ tone: "hint", content: "This scene has no map image. Add one in the Scenes panel." }} slots={[]} />;
  const grid = sceneGrid(scene);
  const hex = isHex(grid);
  const cell = cellWord(grid);
  if (!box) return <OptionsStrip tool="Line up grid" line={{ tone: "hint", content: hex ? HEX_HINT : "Drag a box over three by three squares of the map." }} slots={[]} />;

  const cal = boxCalibration(box, found, sceneId, grid);
  const bounds = fitBounds({ ...map, ...cal });
  const changed = !sameCalibration(cal, map);
  const resize = fitScene && (bounds.w !== scene.bounds.w || bounds.h !== scene.bounds.h);
  // A nudge is a move by hand, so it ends a search as a drag does.
  const set = (next: CalBox) => {
    endFinding(gridState, sceneId);
    gridState.setState({ box: next });
  };
  const saved = applied === box && !changed && !resize;
  const searching = finding?.sceneId === sceneId;
  // A search's note stands while the box is where the search left it.
  const note = found?.sceneId === sceneId && found.box === box ? found : null;

  const apply = () => {
    applyGrid({ actions, store: gridState, sceneId, cal: changed ? cal : null, bounds: resize ? bounds : null });
    setApplied(box);
  };

  /** Back to the grid and the size the scene had before an import applied a found grid, as one undo step. */
  const putBack = (fallback: Fallback) => {
    dispatchGesture(actions, fallbackOps({ id: sceneId, bounds: scene.bounds, map }, fallback));
    gridState.setState({ found: null, box: boxAround(fallback, middleOf(box, map)) });
  };

  const line = searching
    ? { tone: "status" as const, content: "Looking for a grid…" }
    : note?.outcome === "applied"
      ? { tone: "status" as const, content: `Found a grid of ${formatFound(note.cellPx)} px squares.` }
      : note?.outcome === "offered"
        ? {
            tone: "hint" as const,
            content: note.ownGrid
              ? `This scene came with its own grid. The lines found make ${formatFound(note.cellPx)} px squares: check the box, then Apply.`
              : `These lines may be the map's grid: ${formatFound(note.cellPx)} px squares. Check the box, then Apply.`,
          }
        : note?.outcome === "none"
          ? { tone: "status" as const, content: "No grid found. Drag a box over 3 by 3 squares instead." }
          : note?.outcome === "changed"
            ? { tone: "status" as const, content: "The scene changed, so the grid found was not applied." }
            : saved
              ? { tone: "status" as const, content: `Grid saved at ${formatPx(cal.cellPx)} px per ${cell}.` }
              : { tone: "hint" as const, content: hex ? HEX_HINT : "Drag a box over 3 by 3 squares of the art, then fit it by its corners." };
  const fallback = note?.outcome === "applied" ? note.fallback : undefined;

  return (
    <OptionsStrip
      tool="Line up grid"
      task={changed || resize || searching}
      line={line}
      slots={[
        {
          id: "apply",
          priority: 1,
          control: (
            <OptButton tone="primary" disabled={!changed && !resize} ends onClick={apply}>
              Apply
            </OptButton>
          ),
        },
        fallback && {
          id: "useDefault",
          priority: 2,
          control: (
            <OptButton label="Put back the grid the scene started with" onClick={() => putBack(fallback)}>
              Use default
            </OptButton>
          ),
        },
        {
          id: "find",
          priority: 3,
          control: (
            <OptButton label={hex ? HEX_LIMITS.findGrid : "Look for a grid drawn on the map and line up with it"} disabled={hex} onClick={() => findGrid(sceneId)}>
              {searching ? "Finding…" : "Find the grid"}
            </OptButton>
          ),
        },
        {
          id: "nudge",
          priority: 2,
          control: (
            <ValueChip label="Nudge" kind="setting" plain heading="Nudge the box" value="nudge" options={[{ key: "nudge", words: "Nudge" }]} title="Move or size the box a pixel at a time">
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
                {/* The same arrows as a list's Move up and Move down: each moves the box one step its way. The size steps zoom, never add (docs/design-v1-icons.md 2.3). */}
                <OptButton icon="arrowLeft" label="Nudge the box left" onClick={() => set(nudgeBox(box, -STEP, 0, 0, grid))} />
                <OptButton icon="arrowRight" label="Nudge the box right" onClick={() => set(nudgeBox(box, STEP, 0, 0, grid))} />
                <OptButton icon="arrowUp" label="Nudge the box up" onClick={() => set(nudgeBox(box, 0, -STEP, 0, grid))} />
                <OptButton icon="arrowDown" label="Nudge the box down" onClick={() => set(nudgeBox(box, 0, STEP, 0, grid))} />
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
                <OptButton icon="zoomOut" label={`Make the ${cellWord(grid, true)} smaller`} onClick={() => set(nudgeBox(box, 0, 0, -STEP, grid))} />
                <OptButton icon="zoomIn" label={`Make the ${cellWord(grid, true)} larger`} onClick={() => set(nudgeBox(box, 0, 0, STEP, grid))} />
              </div>
            </ValueChip>
          ),
        },
        {
          id: "scale",
          priority: 4,
          // Tabular figures at the width of the widest value, so a nudge never moves the controls beside it.
          control: (
            <StripText tabular all={[`${formatPx(cal.cellPx)} px per ${cell}`, `888.88 px per ${cell}`]}>
              {formatPx(cal.cellPx)} px per {cell}
            </StripText>
          ),
        },
        {
          id: "resize",
          priority: 9,
          always: true,
          control: (
            <OptButton label={`Also resize the scene to the ${cellWord(grid, true)} the map covers`} pressed={fitScene} onClick={() => gridState.setState({ fitScene: !fitScene })}>
              {`Resize scene${resize ? ` to ${bounds.w} × ${bounds.h}` : ""}`}
            </OptButton>
          ),
        },
        { id: "gridLines", priority: 9, always: true, control: <GridLinesToggle scene={scene} /> },
      ]}
    />
  );
}

/**
 * Whether the app draws its grid. Off for art with a grid of its own. The
 * same setting as the Scenes panel's "Grid lines" switch, with the same
 * fixed name, and pressed while the lines show (docs/design-v1-visual.md 3.7).
 */
function GridLinesToggle(props: { scene: Scene }) {
  const actions = useRoomActions();
  const { grid } = props.scene;
  return (
    <OptButton
      label="Draw the app's own lines over the map. Off for art with its own."
      pressed={grid.show}
      onClick={() => actions.dispatch({ t: "scene.update", sceneId: props.scene.id, patch: { grid: { ...grid, show: !grid.show } } })}
    >
      Grid lines
    </OptButton>
  );
}

/** Line up grid's hint on a hex scene (section 8). */
const HEX_HINT = "Drag a box over 3 hexes across. Fine-tune it by its corners.";

/** A found square's size in a sentence, to a tenth of a pixel: "70.4", or "70" for 69.998. */
function formatFound(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function formatPx(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
