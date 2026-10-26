import { createStore } from "zustand/vanilla";
import type { EphEvent } from "#shared/protocol.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import type { ToolContext } from "../tools.ts";
import { allStops, type LastTap, type RulerGesture, type RulerState } from "./ruler.ts";
import { saveWalk, savedWalk } from "./walkRuler.ts";

/**
 * The ruler's state and the parts of it its row and its key both change,
 * apart from the tool's .tsx so the unit tests can load them
 * (docs/design-v1-tool-cycle.md 2.13).
 */

export type RulerToolState = {
  ruler: RulerState | null;
  /** The DM's Share toggle. Players always share. */
  share: boolean;
  /** Whether a frame of the current ruler went to the server, so its end must too. */
  sent: boolean;
  /** Measure: Walking rather than Straight (docs/design-v1-movement.md 3.3), as this device remembers it. */
  walk: boolean;
};

/** One Room page's ruler: the ruler shown, the gesture in progress, and the context its option buttons act through. */
export const rulerSlot = scopeSlot(() => ({
  store: createStore<RulerToolState>(() => ({ ruler: null, share: false, sent: false, walk: savedWalk() })),
  gesture: null as (RulerGesture & { screen: { x: number; y: number }; before: RulerState | null }) | null,
  /** Room.tsx renders Options without a tool context, so the buttons reach the tool through this. */
  activeCtx: null as ToolContext | null,
  /** The last tap, and the ruler as it was before it, so a second tap close behind keeps that ruler. */
  lastTap: null as LastTap | null,
}));

export function shares(ctx: Pick<ToolContext, "role" | "scope">): boolean {
  return ctx.role === "player" || ctx.scope.get(rulerSlot).store.getState().share;
}

/** Shows the ruler here and, when it is shared, everywhere on the scene. */
export function publish(ctx: Pick<ToolContext, "role" | "scope" | "actions">, ruler: RulerState | null): void {
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

export type Measure = "straight" | "walking";

/**
 * The Measure choice's options, in the row's order. Its compact form shows
 * the short words, so a DM's row with kept rulers keeps Measure and the
 * kept rulers' chip in view on a 360 px phone: Shared and Clear as their
 * icons, "Line" or "Walk", Keep and "Kept (12)" take 338 px of the row's 344.
 */
export const MEASURES = [
  { value: "straight", label: "Straight", short: "Line" },
  { value: "walking", label: "Walking", short: "Walk" },
] as const satisfies readonly { value: Measure; label: string; short: string }[];

/** How the ruler measures, kept on this device. A ruler on the map measures again, and goes to players again when it is shared. */
export function pickMeasure(scope: RoomScope, measure: Measure): void {
  const tool = scope.get(rulerSlot);
  const walk = measure === "walking";
  saveWalk(walk);
  tool.store.setState({ walk });
  const ctx = tool.activeCtx;
  const current = tool.store.getState().ruler;
  if (ctx && current) publish(ctx, current);
}
