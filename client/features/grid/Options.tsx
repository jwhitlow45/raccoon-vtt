import { useState } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { OptButton, OptionsStrip, StripText, ValueChip } from "../measure/controls.tsx";
import { calibrationFromBox, fitBounds, nudgeBox, sameCalibration, type CalBox } from "./calibrate.ts";
import { useGridStore } from "./store.ts";

/** One canonical pixel per nudge: on the largest maps a thirtieth of a square or less. */
const STEP = 1;

/**
 * The grid tool's options (docs/design-v1-tool-options.md 9.10): Apply,
 * the nudges behind a chip, and the box's square size. Applying sends one
 * `scene.setGrid` (and, when the scene should match the map, one
 * `scene.update` for its size). Resize scene and Grid lines are always in
 * ⋯. After Apply the line says the grid is saved until the box moves
 * again, since an unavailable button alone did not.
 */
export default function GridOptions() {
  const sceneId = useRoomView((s) => s.sceneId);
  const scene = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId] : undefined));
  const gridState = useGridStore();
  const box = useStore(gridState, (s) => s.box);
  const fitScene = useStore(gridState, (s) => s.fitScene);
  const actions = useRoomActions();
  /** The box last applied, to say so while it stands. */
  const [applied, setApplied] = useState<CalBox | null>(null);

  if (!scene || !sceneId) return null;
  const map = scene.map;
  if (!map) return <OptionsStrip tool="Line up grid" line={{ tone: "hint", content: "This scene has no map image. Add one in the Scenes panel." }} slots={[]} />;
  if (!box) return <OptionsStrip tool="Line up grid" line={{ tone: "hint", content: "Drag a box over three by three squares of the map." }} slots={[]} />;

  const cal = calibrationFromBox(box);
  const bounds = fitBounds({ ...map, ...cal });
  const changed = !sameCalibration(cal, map);
  const resize = fitScene && (bounds.w !== scene.bounds.w || bounds.h !== scene.bounds.h);
  const set = (next: CalBox) => gridState.setState({ box: next });
  const saved = applied === box && !changed && !resize;

  const apply = () => {
    if (changed) actions.dispatch({ t: "scene.setGrid", sceneId, cellPx: cal.cellPx, originPx: cal.originPx });
    if (resize) actions.dispatch({ t: "scene.update", sceneId, patch: { bounds } });
    setApplied(box);
  };

  return (
    <OptionsStrip
      tool="Line up grid"
      task={changed || resize}
      line={saved ? { tone: "status", content: `Grid saved at ${formatPx(cal.cellPx)} px per square.` } : { tone: "hint", content: "Drag a box over 3 by 3 squares of the art, then fit it by its corners." }}
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
        {
          id: "nudge",
          priority: 2,
          control: (
            <ValueChip label="Nudge" kind="setting" plain heading="Nudge the box" value="nudge" options={[{ key: "nudge", words: "Nudge" }]} title="Move or size the box a pixel at a time">
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
                {/* Arrows read as directions, so they stay text. The size steps take the icons for less and more. */}
                <OptButton label="Nudge the box left" onClick={() => set(nudgeBox(box, -STEP, 0))}>
                  ←
                </OptButton>
                <OptButton label="Nudge the box right" onClick={() => set(nudgeBox(box, STEP, 0))}>
                  →
                </OptButton>
                <OptButton label="Nudge the box up" onClick={() => set(nudgeBox(box, 0, -STEP))}>
                  ↑
                </OptButton>
                <OptButton label="Nudge the box down" onClick={() => set(nudgeBox(box, 0, STEP))}>
                  ↓
                </OptButton>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
                <OptButton icon="minus" label="Make the squares smaller" onClick={() => set(nudgeBox(box, 0, 0, -STEP))} />
                <OptButton icon="plus" label="Make the squares larger" onClick={() => set(nudgeBox(box, 0, 0, STEP))} />
              </div>
            </ValueChip>
          ),
        },
        {
          id: "scale",
          priority: 3,
          // Tabular figures at the width of the widest value, so a nudge never moves the controls beside it.
          control: (
            <StripText tabular all={[`${formatPx(cal.cellPx)} px per square`, "888.88 px per square"]}>
              {formatPx(cal.cellPx)} px per square
            </StripText>
          ),
        },
        {
          id: "resize",
          priority: 9,
          always: true,
          control: (
            <OptButton label="Also resize the scene to the squares the map covers" pressed={fitScene} onClick={() => gridState.setState({ fitScene: !fitScene })}>
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

function formatPx(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
