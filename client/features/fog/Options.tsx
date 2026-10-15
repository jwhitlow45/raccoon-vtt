import { useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../state/view.ts";
import { Segmented } from "../../components/Segmented.tsx";
import { ConfirmButton, InfoLine, OptButton, OptionsColumn, OptionsRow, OptSelect } from "../measure/controls.tsx";
import { brushLabel, publishLabel, type FogMode } from "./shapes.ts";
import { BRUSH_WIDTHS, useFogStore, type FogShapeKind } from "./store.ts";
import { closeFogPolygon } from "./tool.tsx";
import { EXPLORED_UNDO_HINT, visionOn } from "../vision/sightMode.ts";

const HINTS: Record<FogShapeKind, string> = {
  rect: "Drag a rectangle.",
  poly: "Tap corners, then tap the first one to close.",
  brush: "Drag to paint.",
  room: "Tap a room made with the map builder.",
};

/**
 * The fog tool's bar: what a drag does now, then reveal or hide, the
 * shape, draft or live, and the draft's Reveal and Discard. Resets are a
 * second tap away, because they change what players see at once.
 */
export default function FogOptions() {
  const fogState = useFogStore();
  const scope = useRoomScope();
  const s = useStore(
    fogState,
    useShallow((f) => ({ mode: f.mode, shape: f.shape, width: f.width, live: f.live, poly: f.poly, note: f.note })),
  );
  const sceneId = useRoomView((v) => v.sceneId);
  const scene = useRoomView((v) => (v.sceneId ? v.view?.scenes[v.sceneId] : undefined));
  const feetPerCell = useRoomView((v) => v.view?.meta.settings.feetPerCell ?? 5);
  const draft = useRoomView((v) => (v.sceneId ? v.view?.fogDrafts[v.sceneId] : undefined));
  const store = useRoomStore();
  const actions = useRoomActions();
  const [more, setMore] = useState(false);
  if (!scene || !sceneId) return null;
  const set = fogState.setState;
  const drafted = draft?.ops.length ?? 0;

  if (!scene.fogEnabled) {
    return (
      <OptionsColumn>
        <InfoLine tone="warning">Fog is off for this scene, so players see all of it.</InfoLine>
        <OptionsRow label="Fog">
          <OptButton tone="primary" onClick={() => actions.dispatch({ t: "scene.update", sceneId, patch: { fogEnabled: true } })}>
            Turn fog on
          </OptButton>
        </OptionsRow>
      </OptionsColumn>
    );
  }

  const hint = s.note ?? `${s.live ? `${HINTS[s.shape]} Players see it at once.` : HINTS[s.shape]}${visionOn(scene) ? ` ${EXPLORED_UNDO_HINT}` : ""}`;
  return (
    <OptionsColumn>
      <InfoLine tone={s.note ? "warning" : "muted"}>{hint}</InfoLine>
      <OptionsRow label="Fog">
        {/* Named for the fog itself, so they never read like the publish button. */}
        <Segmented<FogMode>
          label="Clear or add fog"
          value={s.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "reveal", label: "Clear fog", title: "Clear fog" },
            { value: "hide", label: "Add fog", title: "Add fog" },
          ]}
        />
        <OptSelect<FogShapeKind>
          label="Shape"
          value={s.shape}
          onChange={(shape) => set({ shape, poly: [], rect: null, stroke: [], note: null })}
          options={[
            { value: "rect", label: "Rectangle" },
            { value: "poly", label: "Polygon" },
            { value: "brush", label: "Brush" },
            { value: "room", label: "Builder room" },
          ]}
        />
        {s.shape === "brush" ? (
          <Segmented<number>
            label="Brush width"
            value={s.width}
            onChange={(width) => set({ width })}
            options={BRUSH_WIDTHS.map((w) => ({ value: w, label: brushLabel(w, feetPerCell), title: `${w} ${w === 1 ? "square" : "squares"} wide` }))}
          />
        ) : null}
        {s.shape === "poly" ? (
          <>
            {/* One main action in the bar: closing the shape, unless a draft waits to be revealed. */}
            <OptButton tone={drafted > 0 ? undefined : "primary"} disabled={s.poly.length < 3} onClick={() => closeFogPolygon({ scene, actions, getState: store.getState, scope })}>
              Close shape
            </OptButton>
            <OptButton disabled={s.poly.length === 0} onClick={() => set({ poly: s.poly.slice(0, -1) })}>
              Undo corner
            </OptButton>
          </>
        ) : null}
        <Segmented<"draft" | "live">
          label="When players see edits"
          value={s.live ? "live" : "draft"}
          onChange={(v) => set({ live: v === "live" })}
          options={[
            { value: "draft", label: "Draft", title: "Edit privately, then reveal" },
            { value: "live", label: "Live", title: "Players see each edit at once" },
          ]}
        />
        {drafted > 0 ? (
          <>
            <OptButton tone="primary" onClick={() => actions.dispatch({ t: "fog.publish", sceneId })}>
              {publishLabel(draft?.ops ?? [])}
            </OptButton>
            <OptButton
              label="Take back the last draft edit"
              onClick={() => {
                const last = draft?.ops[draft.ops.length - 1];
                if (last) actions.dispatch({ t: "fog.draft", sceneId, remove: [last.id] });
              }}
            >
              Undo
            </OptButton>
            <OptButton tone="danger" label="Throw the draft away" onClick={() => actions.dispatch({ t: "fog.discard", sceneId })}>
              Discard
            </OptButton>
          </>
        ) : null}
        <OptButton label={more ? "Hide the reset buttons" : "Fog or reveal the whole scene"} pressed={more} onClick={() => setMore(!more)}>
          {more ? "Less" : "More"}
        </OptButton>
        {more ? (
          <>
            <ConfirmButton label="Fog all" confirm="Tap again: fog all" title="Cover the whole scene for the players now" onConfirm={() => actions.dispatch({ t: "fog.reset", sceneId, to: "hidden" })} />
            <ConfirmButton label="Reveal all" confirm="Tap again: reveal all" title="Clear the whole scene for the players now" onConfirm={() => actions.dispatch({ t: "fog.reset", sceneId, to: "revealed" })} />
          </>
        ) : null}
      </OptionsRow>
    </OptionsColumn>
  );
}
