import { createStore } from "zustand/vanilla";
import type { SceneId } from "#shared/model.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import { CARRIED_NO_KEEP, CARRIED_TOO_LONG, CARRIED_WALKS } from "../floors/linkWords.ts";
import type { ToolContext } from "../tools.ts";
import { frameFits, rulerFrame, shareLocked, stillCarried, type Carry } from "./carry.ts";
import { allStops, type LastTap, type RulerGesture, type RulerState, type RulerStop } from "./ruler.ts";
import { saveWalk, savedWalk } from "./walkRuler.ts";

/**
 * The ruler's state and the parts of it its row and its key both change,
 * apart from the tool's .tsx so the unit tests can load them
 * (docs/design/design-v1-tool-cycle.md 2.13).
 */

export type RulerToolState = {
  ruler: RulerState | null;
  /** The DM's Share toggle. Players always share. */
  share: boolean;
  /** Whether a frame of the current ruler went to the server, so its end must too. */
  sent: boolean;
  /** Measure: Walking rather than Straight (docs/design/design-v1-movement.md 3.3), as this device remembers it. */
  walk: boolean;
  /** The ruler carried over stairs, on the floor it went to (docs/design/design-v1-floors.md phase 3, 4.2), else null. */
  carry: Carry | null;
};

/** One Room page's ruler: the ruler shown, the gesture in progress, and the context its option buttons act through. */
export const rulerSlot = scopeSlot(() => ({
  store: createStore<RulerToolState>(() => ({ ruler: null, share: false, sent: false, walk: savedWalk(), carry: null })),
  gesture: null as (RulerGesture & { screen: { x: number; y: number }; before: RulerState | null }) | null,
  /** Room.tsx renders Options without a tool context, so the buttons reach the tool through this. */
  activeCtx: null as ToolContext | null,
  /** The last tap, and the ruler as it was before it, so a second tap close behind keeps that ruler. */
  lastTap: null as LastTap | null,
  /**
   * The floor a press of the stairs button is showing, until the tool is
   * activated there: the board deactivates and activates the tool for the
   * switch (canvas/Stage.tsx), which must keep the carried ruler.
   */
  crossing: null as SceneId | null,
  /** The last frame was refused for its size, so the hint is said once until a frame fits again. */
  refused: false,
}));

export function shares(ctx: Pick<ToolContext, "role" | "scope">): boolean {
  return ctx.role === "player" || ctx.scope.get(rulerSlot).store.getState().share;
}


type PublishCtx = Pick<ToolContext, "role" | "scope" | "actions"> & Partial<Pick<ToolContext, "scene" | "ui">>;

/**
 * Shows the ruler here and, when it is shared, everywhere on the scene. A
 * ruler carried over stairs sends its prior while it starts on the landing
 * (docs/design/design-v1-floors.md phase 3, 4.2), and a ruler started
 * afresh elsewhere is carried no more. A carried frame the server would
 * drop for its size is not sent: the ruler keeps the last frame that fit,
 * and says why once. Returns whether the ruler shows as asked.
 */
export function publish(ctx: PublishCtx, ruler: RulerState | null): boolean {
  const tool = ctx.scope.get(rulerSlot);
  const rulerStore = tool.store;
  const prev = rulerStore.getState();
  if (!ruler) {
    if (prev.ruler) ctx.actions.sendEph({ k: "rulerEnd", id: prev.ruler.id }, { localOnly: !prev.sent });
    rulerStore.setState({ ruler: null, sent: false, carry: null });
    tool.refused = false;
    return true;
  }
  const shared = shares(ctx);
  const carry = stillCarried(prev.carry, ruler.stops);
  const e = rulerFrame(ruler.id, allStops(ruler), shared, prev.walk, carry);
  if (carry && !frameFits(e)) {
    if (!tool.refused) ctx.ui?.notify(CARRIED_TOO_LONG);
    tool.refused = true;
    return false;
  }
  tool.refused = false;
  ctx.actions.sendEph(e, { localOnly: !shared });
  rulerStore.setState({ ruler: { ...ruler, shared }, sent: prev.sent || shared, carry });
  return true;
}

/**
 * The DM's Shared: a ruler turned private comes off everyone else's map
 * and keeps showing here. A ruler carried over stairs while private stays
 * private (carry.ts shareLocked).
 */
export function toggleShare(ctx: PublishCtx): void {
  const store = ctx.scope.get(rulerSlot).store;
  const { ruler: current, sent, share, carry } = store.getState();
  const next = !share;
  if (next && current && shareLocked(stillCarried(carry, current.stops), share)) return;
  if (!next && current && sent) {
    ctx.actions.sendEph({ k: "rulerEnd", id: current.id });
    store.setState({ sent: false });
  }
  store.setState({ share: next });
  if (current) publish(ctx, current);
}

/**
 * Keep or a double tap on a ruler carried over stairs (D-261110-078): the
 * ruler stays as it was before the double tap's first tap, as a ruler that
 * measures nothing does, and the hint says why. Returns whether it refused.
 */
export function refuseKeep(ctx: PublishCtx, ruler: RulerState | null): boolean {
  const { carry, ruler: current } = ctx.scope.get(rulerSlot).store.getState();
  const kept = ruler ?? current;
  if (!kept || !stillCarried(carry, kept.stops)) return false;
  if (ruler) publish(ctx, ruler);
  ctx.ui?.notify(CARRIED_NO_KEEP);
  return true;
}

/**
 * A press of the stairs button (docs/design/design-v1-floors.md phase 3,
 * 4.1): shows the far floor, then publishes the ruler under the same id
 * from the landing with its prior. The socket ends it on the floor left
 * (state/socket.ts sendEph). A switch the store does not make carries
 * nothing.
 */
export function takeStairs(ctx: PublishCtx & Pick<ToolContext, "getState">, plan: { carry: Carry; stop: RulerStop }): boolean {
  const tool = ctx.scope.get(rulerSlot);
  const { ruler } = tool.store.getState();
  if (!ruler) return false;
  // The row hides the button for a frame too big to send, so this holds only a ruler grown since it drew.
  if (!frameFits(rulerFrame(ruler.id, [plan.stop], shares(ctx), true, plan.carry))) {
    ctx.ui?.notify(CARRIED_TOO_LONG);
    return false;
  }
  ctx.actions.showFloor(plan.carry.floor);
  if (ctx.getState().sceneId !== plan.carry.floor) return false;
  tool.crossing = plan.carry.floor;
  tool.gesture = null;
  tool.lastTap = null;
  tool.store.setState({ carry: plan.carry });
  return publish(ctx, { id: ruler.id, stops: [plan.stop], live: null, shared: ruler.shared });
}

/**
 * The tool activated, on a floor or after a switch. Every ruler starts
 * private for the DM (design 7.6), except the one the stairs button carried
 * to this floor, which goes on as it was. Measure stays as this device left it.
 */
export function rulerActivated(ctx: Pick<ToolContext, "scope" | "scene">): void {
  const tool = ctx.scope.get(rulerSlot);
  const crossing = tool.crossing;
  tool.crossing = null;
  if (crossing !== null && crossing === ctx.scene.id && tool.store.getState().carry?.floor === crossing) return;
  tool.store.setState({ ruler: null, share: false, sent: false, carry: null });
}

/**
 * The tool deactivated: another tool, the role, or a switch of floors. A
 * ruler ends with it, and a carry with it, except for the switch the
 * stairs button makes. Returns whether the ruler was kept.
 */
export function rulerDeactivated(ctx: PublishCtx & Pick<ToolContext, "scene">): boolean {
  const tool = ctx.scope.get(rulerSlot);
  tool.gesture = null;
  tool.lastTap = null;
  if (tool.crossing !== null && tool.crossing === ctx.scene?.id) return true;
  tool.crossing = null;
  publish(ctx, null);
  return false;
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

/** How the ruler measures, kept on this device. A ruler on the map measures again, and goes to players again when it is shared. A ruler carried over stairs walks. */
export function pickMeasure(scope: RoomScope, measure: Measure): void {
  const tool = scope.get(rulerSlot);
  const walk = measure === "walking";
  const { carry, ruler } = tool.store.getState();
  if (!walk && ruler && stillCarried(carry, ruler.stops)) {
    tool.activeCtx?.ui.notify(CARRIED_WALKS);
    return;
  }
  saveWalk(walk);
  tool.store.setState({ walk });
  const ctx = tool.activeCtx;
  const current = tool.store.getState().ruler;
  if (ctx && current) publish(ctx, current);
}
