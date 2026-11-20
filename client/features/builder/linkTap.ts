import type { CellRect, FloorLink, RoomState, SceneId } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { ownEntry } from "#shared/records.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { LINK_WORDS, linkProblem, linksOn, type LinkDraft } from "#shared/rules/floorLinks.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexCenter } from "#shared/rules/hex.ts";
import { TAP_SLOP_PX, distance } from "../../lib/gestures.ts";
import { rectBetween, zoneBox } from "../traps/rules.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../tools.ts";
import { builderSlot, linkPaneSlot, type LinkGrab } from "./store.ts";
import type { Bounds, Point } from "./cells.ts";

/*
 * The builder's Between floors mode (docs/design/design-v1-floors.md phase 2,
 * 7): a drag over up to 4 by 4 squares draws the draft, which shows red with
 * its reason while the rules refuse it and is sent only when they pass, a
 * tap on squares with nothing there places 1 by 1, and a tap on an end opens
 * its pane. A press on an end and a drag moves that floor's end (an opening
 * moves both), and a drag from the corner handle of the end whose pane is
 * open resizes both (phase 4, 8.2). The functions are plain so node --test
 * reads them.
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
 * The squares of a drag, held to the kind's longest side: LIMITS.floorLinkSide
 * for stairs and ladders, and an opening's own, which is longer
 * (docs/design/design-v1-floors.md phase 4, 3). The trap tool's snapping does
 * the work (traps/rules.ts rectBetween, hexes included), then a side that is
 * too long gives up its far end, so the rectangle stays on the square the
 * drag began on.
 */
export function draftRect(g: Grid, from: Point, to: Point, bounds: Bounds, kind: Kind = "stairs"): CellRect {
  const rect = rectBetween(g, from, to, bounds);
  const start = rectBetween(g, from, from, bounds);
  const side = kind === "opening" ? LIMITS.openingSide : LIMITS.floorLinkSide;
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

/** What the move or resize of an end writes: its own squares and, for stairs and ladders on squares, the far end's. */
export type EndChange = { rect: CellRect; pairRect?: CellRect };

export const sameRect = (a: CellRect, b: CellRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * An end's pair on the room's ends, or null. The builder's copy holds both
 * floors' ends, so the pair is always there unless it was removed meanwhile.
 */
function pairOfEnd(view: Pick<RoomState, "floorLinks">, link: FloorLink): FloorLink | null {
  return ownEntry(view.floorLinks, link.pair) ?? null;
}

/**
 * A drag of an end's body: the end's squares moved by the whole squares the
 * pointer moved since the press. An opening's far end follows on the same
 * squares, which the server does on `rect` alone. Stairs and ladders move
 * only this floor's end, so the pair may come to lie on other squares.
 */
export function moveChange(g: Grid, link: FloorLink, bounds: Bounds, from: Point, to: Point): EndChange {
  const a = rectBetween(g, from, from, bounds);
  const b = rectBetween(g, to, to, bounds);
  return { rect: { ...link.rect, x: link.rect.x + b.x - a.x, y: link.rect.y + b.y - a.y } };
}

/** The longest side an end of this kind may take. */
function sideOf(kind: Kind): number {
  return kind === "opening" ? LIMITS.openingSide : LIMITS.floorLinkSide;
}

/** The center of an end's far square (bottom right), which a resize drags from. */
export function farCenter(g: Grid, rect: CellRect): Point {
  const col = rect.x + rect.w - 1;
  const row = rect.y + rect.h - 1;
  return isHex(g) ? hexCenter(g, { col, row }) : { x: col + 0.5, y: row + 0.5 };
}

/**
 * A drag of the corner handle: the end's size so its far square is the one
 * under the pointer, held between 1 and the kind's side. Both ends take the
 * size and keep their own corner (stairs and ladders), or the one rect
 * (an opening, and every end on hexes, which the server keeps on one rect).
 * `far` is where the far square's center lay when the press began, moved by
 * the pointer's own move so the handle never jumps under the finger.
 */
export function resizeChange(g: Grid, link: FloorLink, pair: FloorLink, bounds: Bounds, far: Point, from: Point, to: Point): EndChange {
  const at = { x: far.x + to.x - from.x, y: far.y + to.y - from.y };
  const cell = rectBetween(g, at, at, bounds);
  const side = sideOf(link.kind);
  const clamp = (v: number) => Math.max(1, Math.min(side, v));
  const w = clamp(cell.x - link.rect.x + 1);
  const h = clamp(cell.y - link.rect.y + 1);
  const rect = { ...link.rect, w, h };
  return link.kind === "opening" ? { rect } : { rect, pairRect: { ...pair.rect, w, h } };
}

/**
 * The first rule a move or resize breaks, in the words the server refuses
 * it in (reducer/floorLinks.ts movedRects), or null: an opening's two ends
 * and both ends on hexes on one rect, stairs and ladders on squares at one
 * size, then linkProblem on the room without this pair, so the pair meets
 * neither itself nor its own count.
 */
export function judgeChange(view: RoomState, link: FloorLink, change: EndChange): string | null {
  const pair = pairOfEnd(view, link);
  if (pair === null) return null;
  const here = change.rect;
  const there = change.pairRect ?? (link.kind === "opening" ? here : pair.rect);
  const same = sameRect(here, there);
  if (link.kind === "opening" || link.grid !== undefined) {
    if (!same) return LINK_WORDS.sameSquares(link.kind);
  } else if (here.w !== there.w || here.h !== there.h) {
    return LINK_WORDS.oneSize(link.kind);
  }
  const { [link.id]: _end, [pair.id]: _pair, ...others } = view.floorLinks ?? {};
  return linkProblem({ ...view, floorLinks: others }, { id: link.id, pairId: pair.id, sceneId: link.sceneId, to: link.to, rect: here, kind: link.kind, ...(same ? {} : { pairRect: there }) });
}

/** Whether a change leaves both ends where they are. */
export function isNoChange(view: Pick<RoomState, "floorLinks">, link: FloorLink, change: EndChange): boolean {
  const pair = pairOfEnd(view, link);
  return sameRect(change.rect, link.rect) && (change.pairRect === undefined || (pair !== null && sameRect(change.pairRect, pair.rect)));
}

/** The patch a change sends: `rect` always, and `pairRect` where the far end moves on its own. */
export function changePatch(change: EndChange): { rect: CellRect; pairRect?: CellRect } {
  return change.pairRect ? { rect: change.rect, pairRect: change.pairRect } : { rect: change.rect };
}

/** The pane's line where the far end lies on other squares (phase 4, 8.2): "On Upper floor at other squares." */
export function otherSquaresLine(floor: string): string {
  return `On ${floor} at other squares.`;
}

/** The pane's button that moves this end onto the far end's squares: "Line up with Upper floor". */
export function lineUpWords(floor: string): string {
  return `Line up with ${floor}`;
}

/** How far the handle's hit square reaches from the end's corner, in CSS pixels: 44 across, so a finger lands on it. */
export const HANDLE_PX = 44;

/**
 * The corner handle of an end, in cells: its hit square's center and half
 * side. It lies just outside the end's bottom right corner, never over its
 * squares, so a press on the end itself always moves it.
 */
export function handleOf(g: Grid, rect: CellRect, scale: number): { x: number; y: number; r: number } | null {
  const box = zoneBox(g, { zone: { cells: [rect] }, sceneId: "" }, {});
  if (box === null) return null;
  const r = HANDLE_PX / 2 / scale;
  return { x: box.x1 + r, y: box.y1 + r, r };
}

/** Whether a point on the map is on the handle's hit square. */
export function onHandle(h: { x: number; y: number; r: number } | null, p: Point): boolean {
  return h !== null && Math.abs(p.x - h.x) <= h.r && Math.abs(p.y - h.y) <= h.r;
}

/** What a press takes hold of: the corner handle of the end whose pane is open on this floor, else the end under it, else nothing. */
function grabAt(ctx: ToolContext, view: RoomState, g: Grid, world: Point): LinkGrab | null {
  const open = paneEnd(view, ctx.scope.get(linkPaneSlot).getState().linkId);
  if (open && open.sceneId === ctx.scene.id && onHandle(handleOf(g, open.rect, ctx.camera().scale), world)) return { kind: "resize", linkId: open.id, far: farCenter(g, open.rect) };
  const hit = endAt(view, ctx.scene.id, g, ctx.scene.bounds, world);
  return hit ? { kind: "move", linkId: hit.id } : null;
}

/** The change a grabbed end's drag makes at a point, or null where the end is gone. */
function grabChange(ctx: ToolContext, view: RoomState, start: { world: Point; grab: LinkGrab }, at: Point): { link: FloorLink; change: EndChange } | null {
  const link = ownEntry(view.floorLinks, start.grab.linkId);
  const pair = link && pairOfEnd(view, link);
  if (!link || !pair) return null;
  const g = sceneGrid(ctx.scene);
  const bounds = ctx.scene.bounds;
  const change = start.grab.kind === "resize" && start.grab.far ? resizeChange(g, link, pair, bounds, start.grab.far, start.world, at) : moveChange(g, link, bounds, start.world, at);
  return { link, change };
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
  const view = ctx.getState().view;
  const grab = view ? grabAt(ctx, view, sceneGrid(ctx.scene), p.world) : null;
  gesture.link = { screen: p.screen, world: p.world, ...(grab ? { grab } : {}) };
  store.setState({ linkDraft: null, note: null, inSight: false });
}

function move(p: ToolPointer, ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const start = gesture.link;
  const view = ctx.getState().view;
  if (start?.grab && view) {
    if (store.getState().linkDraft === null && distance(start.screen, p.screen) <= TAP_SLOP_PX) return;
    const made = grabChange(ctx, view, { world: start.world, grab: start.grab }, p.world);
    if (!made) return;
    const problem = judgeChange(view, made.link, made.change);
    store.setState({ linkDraft: { rect: made.change.rect, problem }, note: problem });
    return;
  }
  const target = plan(ctx);
  if (!start || !view || !target) return;
  if (store.getState().linkDraft === null && distance(start.screen, p.screen) <= TAP_SLOP_PX) return;
  const draft = judgeDraft(view, ctx.scene.id, target.to, draftRect(sceneGrid(ctx.scene), start.world, p.world, ctx.scene.bounds, target.kind), target.kind);
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
  if (start.grab) {
    // A press on an end that did not drag is a tap on it, which opens its pane. On the handle it does nothing.
    if (!drafted) {
      if (start.grab.kind === "move") {
        ctx.ui.select(null);
        ctx.scope.get(linkPaneSlot).setState({ linkId: start.grab.linkId });
      }
      return;
    }
    sendGrab(ctx, view, { world: start.world, grab: start.grab }, p.world);
    return;
  }
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
  const rect = drafted ? draftRect(g, start.world, p.world, ctx.scene.bounds, target.kind) : draftRect(g, p.world, p.world, ctx.scene.bounds, target.kind);
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

/**
 * Sends a grabbed end's move or resize when the rules pass it, as one
 * `floorLink.update` and so one step to undo, and shows the draft until the
 * server answers (phase 4, 12). A refusal leaves its words in the note.
 */
function sendGrab(ctx: ToolContext, view: RoomState, start: { world: Point; grab: LinkGrab }, at: Point): void {
  const { store } = ctx.scope.get(builderSlot);
  const made = grabChange(ctx, view, start, at);
  if (!made || isNoChange(view, made.link, made.change)) return;
  const problem = judgeChange(view, made.link, made.change);
  if (problem !== null) {
    store.setState({ note: problem });
    return;
  }
  store.setState({ note: null });
  // Set before the send so an answer that comes at once finds it to clear.
  const draft = { rect: made.change.rect, problem: null };
  store.setState({ linkDraft: draft });
  const sent = ctx.actions.dispatch({ t: "floorLink.update", linkId: made.link.id, patch: changePatch(made.change) }, { onAnswer: () => store.setState((s) => (s.linkDraft === draft ? { linkDraft: null } : {})) });
  if (sent === null) {
    store.setState({ linkDraft: null });
    return;
  }
  ctx.ui.select(null);
  ctx.scope.get(linkPaneSlot).setState({ linkId: made.link.id });
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
