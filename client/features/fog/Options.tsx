import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../state/view.ts";
import { ChoiceTiles, ConfirmButton, OptButton, OptionsStrip, OptSegmented, PickCloses, ValueChip } from "../measure/controls.tsx";
import { brushLabel, publishLabel, publishShort, type FogMode } from "./shapes.ts";
import { BRUSH_WIDTHS, FOG_MODES, pickFogMode, useFogStore, type FogShapeKind } from "./store.ts";
import { closeFogPolygon } from "./tool.tsx";
import { EXPLORED_UNDO_HINT, visionOn } from "../vision/sightMode.ts";

const HINTS: Record<FogShapeKind, string> = {
  rect: "Drag a rectangle.",
  poly: "Tap corners, then tap the first one to close.",
  brush: "Drag to paint.",
  room: "Tap a room made with the map builder.",
};

const SHAPES: readonly { value: FogShapeKind; label: string; glyph: IconName }[] = [
  { value: "rect", label: "Rectangle", glyph: "shapeBox" },
  { value: "poly", label: "Polygon", glyph: "shapePolygon" },
  { value: "brush", label: "Brush", glyph: "fogBrush" },
  { value: "room", label: "Builder room", glyph: "fogRoom" },
];

/**
 * The fog tool's options (docs/design-v1-tool-options.md 9.6): what a drag
 * does now on the line, then reveal or hide, the shape, draft or live, and
 * the draft's Reveal, Undo and Discard by priority. Fog all and Reveal all
 * are always in ⋯, a second tap away, because they change what players
 * see at once.
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
  if (!scene || !sceneId) return null;
  const set = fogState.setState;
  const drafted = draft?.ops.length ?? 0;

  if (!scene.fogEnabled) {
    return (
      <OptionsStrip
        tool="Fog"
        line={{ tone: "warning", content: "Fog is off for this scene, so players see all of it." }}
        slots={[
          {
            id: "fogOn",
            priority: 1,
            control: (
              <OptButton tone="primary" ends onClick={() => actions.dispatch({ t: "scene.update", sceneId, patch: { fogEnabled: true } })}>
                Turn fog on
              </OptButton>
            ),
          },
        ]}
      />
    );
  }

  const hint = s.note ?? `${s.live ? `${HINTS[s.shape]} Players see it at once.` : HINTS[s.shape]}${visionOn(scene) ? ` ${EXPLORED_UNDO_HINT}` : ""}`;
  const corners = s.shape === "poly" && s.poly.length > 0;
  // A polygon with corners is a task: its controls lead, and the standing settings drop by 3 (9, "The task rule").
  const drop = corners ? 3 : 0;
  const ops = draft?.ops ?? [];
  return (
    <OptionsStrip
      tool="Fog"
      task={drafted > 0 || corners}
      line={{ tone: s.note ? "warning" : "hint", content: hint }}
      slots={[
        {
          id: "mode",
          priority: 1 + drop,
          compact: true,
          control: (
            <OptSegmented<FogMode>
              label="Clear or add fog"
              value={s.mode}
              onChange={(mode) => pickFogMode(scope, mode)}
              options={FOG_MODES.map((m) => ({ ...m, title: m.label }))}
            />
          ),
        },
        {
          id: "shape",
          priority: 2 + drop,
          compact: true,
          glyph: true,
          control: (
            <ValueChip label="Shape" kind="choice" value={s.shape} options={SHAPES.map((o) => ({ key: o.value, words: o.label, glyph: <Icon name={o.glyph} /> }))}>
              <PickCloses>
                <ChoiceTiles<FogShapeKind>
                  label="Shape"
                  value={s.shape}
                  options={SHAPES.map((o) => ({ value: o.value, label: o.label, glyph: <Icon name={o.glyph} /> }))}
                  onChange={(shape) => set({ shape, poly: [], rect: null, stroke: [], note: null })}
                />
              </PickCloses>
            </ValueChip>
          ),
        },
        s.shape === "brush" && {
          id: "brushWidth",
          priority: 3,
          compact: true,
          control: (
            <OptSegmented<number>
              label="Brush width"
              value={s.width}
              onChange={(width) => set({ width })}
              options={BRUSH_WIDTHS.map((w) => ({ value: w, label: brushLabel(w, feetPerCell), title: `${w} ${w === 1 ? "square" : "squares"} wide` }))}
            />
          ),
        },
        s.shape === "poly" && {
          id: "closeShape",
          priority: 1,
          control: (
            // One main action in the row: closing the shape, unless a draft waits to be revealed.
            <OptButton tone={drafted > 0 ? undefined : "primary"} disabled={s.poly.length < 3} ends onClick={() => closeFogPolygon({ scene, actions, getState: store.getState, scope })}>
              Close shape
            </OptButton>
          ),
        },
        s.shape === "poly" && {
          id: "undoCorner",
          priority: 2,
          control: (
            <OptButton icon="undo" disabled={s.poly.length === 0} onClick={() => set({ poly: s.poly.slice(0, -1) })}>
              Undo corner
            </OptButton>
          ),
        },
        drafted > 0 && {
          id: "undo",
          priority: 3,
          control: (
            <OptButton
              label="Take back the last draft edit"
              onClick={() => {
                const last = draft?.ops[draft.ops.length - 1];
                if (last) actions.dispatch({ t: "fog.draft", sceneId, remove: [last.id] });
              }}
            >
              Undo
            </OptButton>
          ),
        },
        drafted > 0 && {
          id: "publish",
          priority: 1,
          compact: true,
          control: (
            <OptButton tone="primary" short={publishShort(ops)} ends onClick={() => actions.dispatch({ t: "fog.publish", sceneId })}>
              {publishLabel(ops)}
            </OptButton>
          ),
        },
        {
          id: "live",
          priority: 4 + drop,
          compact: true,
          control: (
            <OptSegmented<"draft" | "live">
              label="When players see edits"
              value={s.live ? "live" : "draft"}
              onChange={(v) => set({ live: v === "live" })}
              options={[
                { value: "draft", label: "Draft", title: "Edit privately, then reveal" },
                { value: "live", label: "Live", title: "Players see each edit at once" },
              ]}
            />
          ),
        },
        drafted > 0 && {
          id: "discard",
          priority: 5,
          control: (
            <OptButton tone="danger" label="Throw the draft away" ends onClick={() => actions.dispatch({ t: "fog.discard", sceneId })}>
              Discard
            </OptButton>
          ),
        },
        {
          id: "fogAll",
          priority: 9,
          always: true,
          control: <ConfirmButton label="Fog all" confirm="Tap again: fog all" title="Cover the whole scene for the players now" onConfirm={() => actions.dispatch({ t: "fog.reset", sceneId, to: "hidden" })} />,
        },
        {
          id: "revealAll",
          priority: 9,
          always: true,
          control: <ConfirmButton label="Reveal all" confirm="Tap again: reveal all" title="Clear the whole scene for the players now" onConfirm={() => actions.dispatch({ t: "fog.reset", sceneId, to: "revealed" })} />,
        },
      ]}
    />
  );
}
