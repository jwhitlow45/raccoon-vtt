import type { ReactNode } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { EphEvent } from "#shared/protocol.ts";
import { useDelayed } from "../../components/Loading.tsx";
import { TAP_SLOP_PX } from "../../lib/gestures.ts";
import { theme } from "../../lib/theme.ts";
import { groundSource, seenGround } from "../builder/heights/ground.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { OptButton, OptionsStrip, OptSegmented } from "./controls.tsx";
import { KeptRulersChip, useKeptRulers } from "./KeptRulers.tsx";
import {
  allStops,
  beginGesture,
  diagonalLabel,
  dragTo,
  formatFeet,
  keepPlan,
  lift,
  measureStops,
  type GroundReader,
  type LastTap,
  type RulerGesture,
  type RulerState,
  type RulerToken,
} from "./ruler.ts";
import { useWalkMeasure } from "./useWalkMeasure.ts";
import { saveWalk, savedWalk, walkText } from "./walkRuler.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/**
 * The ruler (design sections 7.6 and 9.2, features section 4): drag to
 * measure, tap to add a waypoint, drag from the last stop to carry on.
 *
 * Every change goes out as a `ruler` frame, so other devices see it live
 * and the socket keeps it alive while it stays on the map. Players' rulers
 * are shared by default. The DM's stays on the DM's device (sent with
 * `localOnly`) until the DM taps Share, so measuring to a hidden monster
 * never shows players where it is.
 *
 * A double tap, or Keep, keeps the ruler on the map as a drawing of kind
 * `ruler` (features section 4), shared exactly when the live ruler was. Its
 * owner and the DM remove it from the list under the ruler's options.
 */

type RulerToolState = {
  ruler: RulerState | null;
  /** The DM's Share toggle. Players always share. */
  share: boolean;
  /** Whether a frame of the current ruler went to the server, so its end must too. */
  sent: boolean;
  /** Measure: Walking rather than Straight (docs/design-v1-movement.md 3.3), as this device remembers it. */
  walk: boolean;
};

/** One Room page's ruler: the ruler shown, the gesture in progress, and the context its option buttons act through. */
const rulerSlot = scopeSlot(() => ({
  store: createStore<RulerToolState>(() => ({ ruler: null, share: false, sent: false, walk: savedWalk() })),
  gesture: null as (RulerGesture & { screen: { x: number; y: number }; before: RulerState | null }) | null,
  /** Room.tsx renders Options without a tool context, so the buttons reach the tool through this. */
  activeCtx: null as ToolContext | null,
  /** The last tap, and the ruler as it was before it, so a second tap close behind keeps that ruler. */
  lastTap: null as LastTap | null,
}));

function shares(ctx: Pick<ToolContext, "role" | "scope">): boolean {
  return ctx.role === "player" || ctx.scope.get(rulerSlot).store.getState().share;
}

function sceneToken(ctx: ToolContext, id: string | null): RulerToken | undefined {
  if (!id) return undefined;
  const t = ctx.getState().view?.tokens[id];
  return t && t.sceneId === ctx.scene.id ? t : undefined;
}

/**
 * The ground a free stop stands on, read when the stop is placed: all of it
 * for the DM, and for a player only what their fog shows, 0 elsewhere. The
 * frame carries it, so a player's ruler never tells anyone what lies under
 * their fog, and receivers never need the measurer's fog to read it.
 */
function groundOf(ctx: ToolContext): GroundReader {
  const view = ctx.getState().view;
  if (!view) return () => 0;
  const src = groundSource(view, ctx.scene, ctx.role);
  return (cell) => seenGround(src, cell) ?? 0;
}

/** Shows the ruler here and, when it is shared, everywhere on the scene. */
function publish(ctx: ToolContext, ruler: RulerState | null): void {
  const rulerStore = ctx.scope.get(rulerSlot).store;
  const prev = rulerStore.getState();
  if (!ruler) {
    if (prev.ruler) ctx.actions.sendEph({ k: "rulerEnd", id: prev.ruler.id }, { localOnly: !prev.sent });
    rulerStore.setState({ ruler: null, sent: false });
    return;
  }
  const shared = shares(ctx);
  const points = allStops(ruler);
  const e: EphEvent = { k: "ruler", id: ruler.id, points, shared, ...(prev.walk ? { walk: true as const } : {}) };
  ctx.actions.sendEph(e, { localOnly: !shared });
  rulerStore.setState({ ruler: { ...ruler, shared }, sent: prev.sent || shared });
}

function onDown(p: ToolPointer, ctx: ToolContext): void {
  const tool = ctx.scope.get(rulerSlot);
  const before = tool.store.getState().ruler;
  tool.gesture = { ...beginGesture(before, p.world, sceneToken(ctx, p.tokenId), ctx.camera().scale), screen: p.screen, before };
}

function onMove(p: ToolPointer, ctx: ToolContext): void {
  const tool = ctx.scope.get(rulerSlot);
  const gesture = tool.gesture;
  if (!gesture) return;
  if (!gesture.dragging) {
    if (Math.hypot(p.screen.x - gesture.screen.x, p.screen.y - gesture.screen.y) < TAP_SLOP_PX) return;
    gesture.dragging = true;
  }
  publish(ctx, dragTo(tool.store.getState().ruler, gesture, p.world, sceneToken(ctx, p.tokenId), ctx.actions.newId, groundOf(ctx)));
}

function onUp(p: ToolPointer, ctx: ToolContext): void {
  const tool = ctx.scope.get(rulerSlot);
  const g = tool.gesture;
  if (!g) return;
  tool.gesture = null;
  const lifted = lift({
    state: tool.store.getState().ruler,
    gesture: g,
    tap: { at: performance.now(), screen: p.screen },
    lastTap: tool.lastTap,
    world: p.world,
    token: sceneToken(ctx, p.tokenId),
    newId: ctx.actions.newId,
    ground: groundOf(ctx),
  });
  tool.lastTap = lifted.lastTap;
  if ("keep" in lifted) keep(ctx, lifted.keep);
  else publish(ctx, lifted.ruler);
}

/**
 * Keeps a ruler on the map and clears the live one. A ruler that measures
 * nothing yet stays as it was, with a hint, so a stray double tap loses
 * nothing.
 */
function keep(ctx: ToolContext, ruler: RulerState | null): void {
  const s = ctx.getState();
  const you = s.you;
  const plan = keepPlan(
    ruler,
    you
      ? {
          id: ctx.actions.newId(),
          sceneId: ctx.scene.id,
          ownerId: you.memberId,
          color: s.view?.members[you.memberId]?.color ?? theme.color.crest,
          shared: shares(ctx),
          walk: ctx.scope.get(rulerSlot).store.getState().walk,
        }
      : null,
  );
  if ("leave" in plan) {
    publish(ctx, plan.leave);
    ctx.ui.notify("Measure something first, then double-tap to keep the ruler on the map.");
    return;
  }
  if (ctx.actions.dispatch({ t: "drawing.create", drawing: plan.create }) === null) return;
  publish(ctx, null);
}

/** A second finger landed: the gesture was a pinch, so the ruler goes back to how it was. */
function onCancel(ctx: ToolContext): void {
  const tool = ctx.scope.get(rulerSlot);
  if (!tool.gesture) return;
  const before = tool.gesture.before;
  tool.gesture = null;
  if (before) publish(ctx, before);
  else publish(ctx, null);
}

const MEASURES = [
  { value: "straight", label: "Straight" },
  { value: "walking", label: "Walking" },
] as const;

/**
 * The Ruler's row (docs/design-v1-tool-options.md 9.2): Shared for the DM,
 * Measure, Keep and Clear, and the kept rulers behind a chip. Its line is
 * the hint, or the reading with the diagonal rule: a walking ruler's walk
 * and what terrain added (docs/design-v1-movement.md 3.3).
 */
function RulerOptions(props: { role: "dm" | "player" }) {
  const tool = useScoped(rulerSlot);
  const rulerStore = tool.store;
  const { ruler, share, walk } = useStore(rulerStore);
  const tokens = useRoomView((s) => s.view?.tokens);
  const settings = useRoomView((s) => s.view?.meta.settings);
  const view = useRoomView((s) => (walk ? s.view : null));
  const kept = useKeptRulers(props.role);
  const stops = ruler ? allStops(ruler) : [];
  let info: ReactNode = "Drag to measure. Tap to add a waypoint. Double-tap to keep a ruler on the map.";
  if (stops.length === 1) info = "Tap or drag to the next point.";
  const walked = useWalkMeasure(walk && view && tool.activeCtx && stops.length > 1 ? { view, sceneId: tool.activeCtx.scene.id, stops, viewer: { role: props.role }, everything: props.role === "dm" && !share } : null);
  const finding = useDelayed(walked?.searching === true);
  if (walked?.searching) {
    if (finding) info = "Finding the way…";
  } else if (walked) {
    const [first, extra] = walkText(walked).split("\n");
    info = (
      <>
        <strong>{first}</strong>
        {extra ? ` · ${extra}` : null}
        {walked.legs.some((l) => l.none) ? " · No way through" : null}
      </>
    );
  } else if (stops.length > 1 && tokens && settings) {
    const { totalFt, legsFt } = measureStops(stops, tokens, settings);
    info = (
      <>
        <strong>{formatFeet(totalFt)}</strong>
        {legsFt.length > 1 ? ` (${legsFt.map(formatFeet).join(" + ")})` : null}
      </>
    );
  }
  return (
    <OptionsStrip
      tool="Ruler"
      line={{
        tone: stops.length > 1 ? "reading" : "hint",
        content: (
          <>
            {info}
            {settings ? <span style={{ color: theme.color.textMuted }}> · {diagonalLabel(settings.diagonal)}</span> : null}
          </>
        ),
      }}
      slots={[
        props.role === "dm" && {
          id: "shared",
          priority: 1,
          // Its eye alone where the row cannot hold its word, so a DM's row with Measure and kept rulers still fits a 375 px phone.
          compact: true,
          control: (
            // A fixed name that says what pressed means (docs/design-v1-visual.md 3.7).
            <OptButton
              pressed={share}
              icon="shown"
              label="Players see this ruler"
              compactIcon
              onClick={() => {
                const ctx = tool.activeCtx;
                const next = !share;
                const { ruler: current, sent } = rulerStore.getState();
                if (!next && current && sent && ctx) {
                  // Take it off everyone else's map, then keep showing it here.
                  ctx.actions.sendEph({ k: "rulerEnd", id: current.id });
                  rulerStore.setState({ sent: false });
                }
                rulerStore.setState({ share: next });
                if (ctx && current) publish(ctx, current);
              }}
            >
              Shared
            </OptButton>
          ),
        },
        {
          id: "measure",
          // A choice this device keeps, so on a narrow row it waits behind ⋯ before Keep, Clear or the kept rulers' chip.
          priority: 4,
          compact: true,
          control: (
            <OptSegmented
              label="Measure"
              value={walk ? "walking" : "straight"}
              options={MEASURES}
              onChange={(v) => {
                const next = v === "walking";
                saveWalk(next);
                rulerStore.setState({ walk: next });
                const ctx = tool.activeCtx;
                const current = rulerStore.getState().ruler;
                if (ctx && current) publish(ctx, current);
              }}
            />
          ),
        },
        {
          id: "keep",
          priority: 2,
          control: (
            <OptButton disabled={!ruler || ruler.stops.length < 2} label="Keep this ruler on the map" onClick={() => tool.activeCtx && keep(tool.activeCtx, rulerStore.getState().ruler)}>
              Keep
            </OptButton>
          ),
        },
        {
          id: "clear",
          priority: 2,
          // Its eraser alone where the row cannot hold its words, such as a DM's with kept rulers on a 360 px phone, so the kept rulers' chip never waits behind ⋯ for it.
          compact: true,
          control: (
            <OptButton tone="danger" icon="eraser" compactIcon disabled={!ruler} onClick={() => tool.activeCtx && publish(tool.activeCtx, null)}>
              Clear
            </OptButton>
          ),
        },
        kept.length > 0 && { id: "kept", priority: 3, compact: true, control: <KeptRulersChip kept={kept} /> },
      ]}
    />
  );
}

export const rulerTool: ToolDef = {
  id: "ruler",
  label: "Ruler",
  icon: { path: "M2 11h20v2H2zM2 7h2v10H2zm18 0h2v10h-2zM7 9h1.6v3H7zm4.2 0h1.6v3h-1.6zm4.2 0H17v3h-1.6z" },
  roles: ["dm", "player"],
  order: TOOL_ORDER.ruler,
  cursor: "crosshair",
  pointer: { down: onDown, move: onMove, up: onUp, cancel: onCancel },
  activate(ctx) {
    const tool = ctx.scope.get(rulerSlot);
    tool.activeCtx = ctx;
    // Every ruler starts private for the DM (design 7.6). Measure stays as this device left it.
    tool.store.setState({ ruler: null, share: false, sent: false });
  },
  deactivate(ctx) {
    const tool = ctx.scope.get(rulerSlot);
    tool.gesture = null;
    tool.lastTap = null;
    publish(ctx, null);
    if (tool.activeCtx === ctx) tool.activeCtx = null;
  },
  Options: RulerOptions,
};
