import type { CellRect, FloorLink, RoomState, SceneId } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { ownEntry } from "#shared/records.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { linkProblem, linksOn, type LinkDraft } from "#shared/rules/floorLinks.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { TAP_SLOP_PX, distance } from "../../lib/gestures.ts";
import { rectBetween } from "../traps/rules.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../tools.ts";
import { builderSlot, linkPaneSlot } from "./store.ts";
import type { Bounds, Point } from "./cells.ts";

/*
 * The builder's Between floors mode (docs/design/design-v1-floors.md phase 2,
 * 7): a drag over up to 4 by 4 squares draws the draft, which shows red with
 * its reason while the rules refuse it and is sent only when they pass, a
 * tap on squares with nothing there places 1 by 1, and a tap on an end opens
 * its pane. The functions are plain so node --test reads them.
 */

type Kind = FloorLink["kind"];

/** A floor the mode can lead to: the floor just above or below the one shown. */
export type LinkTarget = { id: SceneId; dir: "up" | "down"; name: string };

/** The floor's own name, else its scene's. */
function nameOf(scene: { name: string; floor?: { name: string } }): string {
  return scene.floor?.name ?? scene.name;
}

/** The floors next to the one shown, the floor above first (7.1). Empty on a scene of one floor. */
export function linkTargets(view: Pick<RoomState, "scenes"> | null, sceneId: SceneId | null): LinkTarget[] {
  if (view === null || sceneId === null) return [];
  const floors = floorsOf(view, sceneId);
  const at = floors.findIndex((f) => f.id === sceneId);
  if (floors.length < 2 || at < 0) return [];
  const out: LinkTarget[] = [];
  const above = floors[at + 1];
  const below = floors[at - 1];
  if (above) out.push({ id: above.id, dir: "up", name: nameOf(above) });
  if (below) out.push({ id: below.id, dir: "down", name: nameOf(below) });
  return out;
}

/**
 * The floor a new pair leads to: the DM's pick while it is still next to the
 * floor shown, else the floor above, else the floor below. A pick made on
 * another floor never carries here as a floor two levels away.
 */
export function chosenTarget(targets: readonly LinkTarget[], picked: SceneId | null): LinkTarget | null {
  return targets.find((t) => t.id === picked) ?? targets[0] ?? null;
}

/**
 * The squares of a drag, held to LIMITS.floorLinkSide a side. The trap tool's
 * snapping does the work (traps/rules.ts rectBetween, hexes included), then
 * a side that is too long gives up its far end, so the rectangle stays on the
 * square the drag began on.
 */
export function draftRect(g: Grid, from: Point, to: Point, bounds: Bounds): CellRect {
  const rect = rectBetween(g, from, to, bounds);
  const start = rectBetween(g, from, from, bounds);
  const side = LIMITS.floorLinkSide;
  const clip = (at: number, length: number, begin: number) => {
    if (length <= side) return { at, length };
    return at < begin ? { at: at + length - side, length: side } : { at, length: side };
  };
  const x = clip(rect.x, rect.w, start.x);
  const y = clip(rect.y, rect.h, start.y);
  return { x: x.at, y: y.at, w: x.length, h: y.length };
}

/** Whether the squares of a rectangle hold a cell. */
export function rectHolds(rect: CellRect, cell: CellRect): boolean {
  return cell.x >= rect.x && cell.x < rect.x + rect.w && cell.y >= rect.y && cell.y < rect.y + rect.h;
}

/** The end on a floor under a point, or null. */
export function endAt(view: Pick<RoomState, "floorLinks">, sceneId: SceneId, g: Grid, bounds: Bounds, at: Point): FloorLink | null {
  const cell = rectBetween(g, at, at, bounds);
  return linksOn(view, sceneId).find((l) => rectHolds(l.rect, cell)) ?? null;
}

/** The draft as the rules read it, under ids a pair of its own will take. */
export function draftOf(sceneId: SceneId, to: SceneId, rect: CellRect, kind: Kind, ids: { id: string; pairId: string } = { id: "draft-a", pairId: "draft-b" }): LinkDraft {
  return { ...ids, sceneId, to, rect, kind };
}

/** What a finished or moving gesture shows: the squares and the rules' first refusal of them, or null. */
export function judgeDraft(view: RoomState, sceneId: SceneId, to: SceneId, rect: CellRect, kind: Kind): { rect: CellRect; problem: string | null } {
  return { rect, problem: linkProblem(view, draftOf(sceneId, to, rect, kind)) };
}

/** Whether the builder's mode is Between floors. */
export function isLinkMode(mode: string): boolean {
  return mode === "link";
}

/** The target and kind a gesture will use, or null where the scene has no floor next to it. */
function plan(ctx: ToolContext): { to: SceneId; kind: Kind } | null {
  const view = ctx.getState().view;
  const s = ctx.scope.get(builderSlot).store.getState();
  const target = chosenTarget(linkTargets(view, ctx.scene.id), s.linkTo);
  return target ? { to: target.id, kind: s.linkKind } : null;
}

function down(p: ToolPointer, ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  gesture.link = { screen: p.screen, world: p.world };
  store.setState({ linkDraft: null, note: null, inSight: false });
}

function move(p: ToolPointer, ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const start = gesture.link;
  const view = ctx.getState().view;
  const target = plan(ctx);
  if (!start || !view || !target) return;
  if (store.getState().linkDraft === null && distance(start.screen, p.screen) <= TAP_SLOP_PX) return;
  const draft = judgeDraft(view, ctx.scene.id, target.to, draftRect(sceneGrid(ctx.scene), start.world, p.world, ctx.scene.bounds), target.kind);
  store.setState({ linkDraft: draft, note: draft.problem });
}

function up(p: ToolPointer, ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const start = gesture.link;
  gesture.link = null;
  const drafted = store.getState().linkDraft !== null;
  store.setState({ linkDraft: null });
  const view = ctx.getState().view;
  if (!start || !view) return;
  const g = sceneGrid(ctx.scene);
  if (!drafted) {
    const hit = endAt(view, ctx.scene.id, g, ctx.scene.bounds, p.world);
    // One thing floats over the map at a time: the pane, or a token's bar.
    if (hit) {
      ctx.ui.select(null);
      ctx.scope.get(linkPaneSlot).setState({ linkId: hit.id });
      return;
    }
  }
  const target = plan(ctx);
  if (!target) return;
  const rect = drafted ? draftRect(g, start.world, p.world, ctx.scene.bounds) : draftRect(g, p.world, p.world, ctx.scene.bounds);
  const ids = { id: ctx.actions.newId(), pairId: ctx.actions.newId() };
  const problem = linkProblem(view, draftOf(ctx.scene.id, target.to, rect, target.kind, ids));
  if (problem !== null) {
    store.setState({ note: problem });
    return;
  }
  store.setState({ note: null });
  const sent = ctx.actions.dispatch({ t: "floorLink.put", link: { ...ids, sceneId: ctx.scene.id, to: target.to, rect, kind: target.kind } });
  // A placed pair opens its pane (7.2).
  if (sent !== null) {
    ctx.ui.select(null);
    ctx.scope.get(linkPaneSlot).setState({ linkId: ids.id });
  }
}

function cancel(ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  gesture.link = null;
  if (store.getState().linkDraft !== null) store.setState({ linkDraft: null });
}

/** The end `linkId` names, as the shown floor's copy holds it. */
export function paneEnd(view: Pick<RoomState, "floorLinks"> | null | undefined, linkId: string | null): FloorLink | null {
  return linkId === null || !view ? null : (ownEntry(view.floorLinks, linkId) ?? null);
}

/**
 * The builder tool's pointer handlers with Between floors in front of them.
 * A gesture that began in the mode ends there, whatever the mode is by the
 * time it ends.
 */
export function withLinkMode(handlers: ToolPointerHandlers): ToolPointerHandlers {
  const inMode = (ctx: ToolContext) => isLinkMode(ctx.scope.get(builderSlot).store.getState().mode);
  const busy = (ctx: ToolContext) => ctx.scope.get(builderSlot).gesture.link !== null;
  return {
    ...handlers,
    down: (p, ctx) => (inMode(ctx) ? down(p, ctx) : handlers.down?.(p, ctx)),
    move: (p, ctx) => (busy(ctx) ? move(p, ctx) : handlers.move?.(p, ctx)),
    up: (p, ctx) => (busy(ctx) ? up(p, ctx) : handlers.up?.(p, ctx)),
    cancel: (ctx) => {
      cancel(ctx);
      handlers.cancel?.(ctx);
    },
  };
}
