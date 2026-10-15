import { useState } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { InfoLine, OptButton, OptionsColumn, OptionsRow } from "../measure/controls.tsx";
import { calibrationFromBox, fitBounds, nudgeBox, sameCalibration, type CalBox } from "./calibrate.ts";
import { useGridStore } from "./store.ts";

/** One canonical pixel per nudge: on the largest maps a thirtieth of a square or less. */
const STEP = 1;

/**
 * The grid tool's bar: nudge the box, then apply. Applying sends one
 * `scene.setGrid` (and, when the scene should match the map, one
 * `scene.update` for its size).
 *
 * On a phone the whole bar once covered 40% of the screen, so the box
 * stays in view: the nudges and the scene options fold away behind a
 * toggle each, and the hint is one line. After Apply the bar says the grid
 * is saved until the box moves again, since an unavailable button alone
 * did not.
 */
export default function GridOptions() {
  const sceneId = useRoomView((s) => s.sceneId);
  const scene = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId] : undefined));
  const gridState = useGridStore();
  const box = useStore(gridState, (s) => s.box);
  const fitScene = useStore(gridState, (s) => s.fitScene);
  const actions = useRoomActions();
  const [open, setOpen] = useState<"nudge" | "more" | null>(null);
  /** The box last applied, to say so while it stands. */
  const [applied, setApplied] = useState<CalBox | null>(null);

  if (!scene || !sceneId) return null;
  const map = scene.map;
  if (!map) return <OnlyHint>This scene has no map image. Add one in the Scenes panel.</OnlyHint>;
  if (!box) return <OnlyHint>Drag a box over three by three squares of the map.</OnlyHint>;

  const cal = calibrationFromBox(box);
  const bounds = fitBounds({ ...map, ...cal });
  const changed = !sameCalibration(cal, map);
  const resize = fitScene && (bounds.w !== scene.bounds.w || bounds.h !== scene.bounds.h);
  const set = (next: CalBox) => gridState.setState({ box: next });
  const saved = applied === box && !changed && !resize;
  const toggle = (which: "nudge" | "more") => setOpen(open === which ? null : which);

  const apply = () => {
    if (changed) actions.dispatch({ t: "scene.setGrid", sceneId, cellPx: cal.cellPx, originPx: cal.originPx });
    if (resize) actions.dispatch({ t: "scene.update", sceneId, patch: { bounds } });
    setApplied(box);
  };

  return (
    <OptionsColumn>
      {saved ? (
        <div role="status" style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.success }}>
          Grid saved at {formatPx(cal.cellPx)} px per square.
        </div>
      ) : (
        <InfoLine tone="muted">Drag a box over 3 by 3 squares of the art, then fit it by its corners.</InfoLine>
      )}
      <OptionsRow label="Grid">
        <OptButton tone="primary" disabled={!changed && !resize} onClick={apply}>
          Apply
        </OptButton>
        <span style={{ fontSize: theme.font.body14, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatPx(cal.cellPx)} px per square</span>
        <OptButton label="Move or size the box a pixel at a time" pressed={open === "nudge"} onClick={() => toggle("nudge")}>
          Nudge
        </OptButton>
        <OptButton label="Scene size and the app's grid lines" pressed={open === "more"} onClick={() => toggle("more")}>
          More
        </OptButton>
      </OptionsRow>
      {open === "nudge" ? (
        <OptionsRow label="Nudge the box">
          <span style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
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
          </span>
          <span style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
            <OptButton icon="minus" label="Make the squares smaller" onClick={() => set(nudgeBox(box, 0, 0, -STEP))} />
            <OptButton icon="plus" label="Make the squares larger" onClick={() => set(nudgeBox(box, 0, 0, STEP))} />
          </span>
        </OptionsRow>
      ) : null}
      {open === "more" ? (
        <OptionsRow label="Scene size and grid lines">
          <OptButton label="Also resize the scene to the squares the map covers" pressed={fitScene} onClick={() => gridState.setState({ fitScene: !fitScene })}>
            {`Resize scene${resize ? ` to ${bounds.w} × ${bounds.h}` : ""}`}
          </OptButton>
          <GridLinesToggle scene={scene} />
        </OptionsRow>
      ) : null}
    </OptionsColumn>
  );
}

/** A bar with nothing to set yet, only what to do first. */
function OnlyHint(props: { children: string }) {
  return (
    <OptionsColumn>
      <InfoLine tone="muted">{props.children}</InfoLine>
    </OptionsColumn>
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
