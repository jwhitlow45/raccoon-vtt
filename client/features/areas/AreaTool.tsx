import type { AreaTemplate } from "#shared/model.ts";
import type { AreaContext, AreaToken } from "#shared/rules/aoe.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { TAP_SLOP_PX } from "../../lib/gestures.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import type { RoomActions } from "../../state/types.ts";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { AreaOptions } from "./AreaOptions.tsx";
import { defaultCaster, idleTapPicks, pickedPress } from "./caster.ts";
import { areaContext } from "./coverage.ts";
import {
  areaContains,
  handlePoint,
  isDirectional,
  liveOrigin,
  movePatch,
  freePointHeight,
  pointHeight,
  rotatePatch,
  snapCubeCenter,
  snapFootprintCenter,
  snapPoint,
  snapYaw,
  templatePivot,
  usesFrom,
  yawToward,
  type AreaDraft,
  type Point3,
} from "./placement.ts";
import {
  areaSlot,
  canEdit,
  GRAB_PX,
  HANDLE_GAP_PX,
  markMoving,
  markRested,
  resetAreaTool,
  select,
  setDraft,
  startDraft,
  updateTemplate,
  type AreaEnv,
} from "./store.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/**
 * The area of effect tool (design section 9.3, features section 9).
 *
 * With nothing in progress, a tap on a token casts the last shape used from
 * it, even inside a placed area (caster.ts), a tap on the map places it
 * there, and a tap on a placed area's open ground picks it for editing.
 * While a draft is out:
 *
 * - A token tapped becomes what a cone, line, cube or emanation starts from
 *   (for Ice Knife, its target). A sphere or cylinder goes on the token.
 * - A drag aims a cone, line or cube from its caster's center, snapped to
 *   15 or 45 degrees or free. With no caster, the first press sets the
 *   origin and the drag aims from it, and a later press near the origin
 *   moves it. Aiming works from anywhere on the map, so the rotation handle
 *   drawn past the far end is a cue as much as a grip.
 * - A drag moves a sphere, a cylinder, a free emanation or a free cube.
 *
 * A picked placed area moves by dragging inside it, in whole cells, and a
 * cone, line or cube turns from its handle or a drag anywhere else
 * (caster.ts pickedPress). One cast from a creature turns around it from
 * inside too, so it never leaves its caster. Both go out as one
 * `template.update` on lift.
 */

type Gesture =
  | { kind: "none" }
  | { kind: "aim"; pivot: { x: number; y: number } }
  | { kind: "point" }
  | { kind: "center" }
  | { kind: "moveTemplate"; template: AreaTemplate; start: { x: number; y: number } }
  | { kind: "turnTemplate"; template: AreaTemplate; pivot: { x: number; y: number }; letGo?: boolean };

/** One Room page's gesture in progress, and a pick from the Areas panel waiting for the tool to open. */
const gestureSlot = scopeSlot(() => ({
  gesture: null as (Gesture & { screen: { x: number; y: number }; moved: boolean }) | null,
  /** A template the Areas panel asked to open the tool on. */
  pendingPick: null as string | null,
}));

function envOf(ctx: ToolContext): AreaEnv | null {
  const s = ctx.getState();
  if (!s.view || !s.you) return null;
  return { actions: ctx.actions, view: s.view, scene: ctx.scene, role: ctx.role, youId: s.you.memberId, area: ctx.scope.get(areaSlot) };
}

function sceneToken(env: AreaEnv, id: string | null): AreaToken | undefined {
  if (!id) return undefined;
  const t = env.view.tokens[id];
  return t && t.sceneId === env.scene.id ? t : undefined;
}

function centerOf(t: AreaToken): { x: number; y: number } {
  const r = footprintRect(t);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** The topmost placed template on this scene under a point. */
export function templateAt(env: AreaEnv, actx: AreaContext, p: { x: number; y: number }): AreaTemplate | null {
  const list = Object.values(env.view.templates).filter((t) => t && t.sceneId === env.scene.id);
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]!;
    if (areaContains(t, actx, p)) return t;
  }
  return null;
}

/** A token tapped while a draft is out: what it starts from, or its target. */
function fromToken(d: AreaDraft, tokenId: string): AreaDraft {
  if (d.targetsOther) return { ...d, fromId: tokenId, point: null };
  return { ...d, fromId: tokenId, casterId: tokenId, point: null };
}

function aimed(env: AreaEnv, d: AreaDraft, pivot: { x: number; y: number }, to: { x: number; y: number }): AreaDraft {
  const yaw = yawToward(pivot, to);
  return yaw === null ? d : { ...d, yaw: snapYaw(yaw, env.area.store.getState().snap) };
}

/** Where an area goes on open map, at the height placement.ts freePointHeight gives it. */
function freePoint(env: AreaEnv, d: AreaDraft, world: { x: number; y: number }, token: AreaToken | undefined): Point3 {
  if (token) return { ...centerOf(token), z: pointHeight(token) };
  const at = d.shape === "emanation" && d.footprint ? snapFootprintCenter(world, d.footprint) : snapPoint(world);
  return { ...at, z: freePointHeight(env.view.buildChunks, env.scene.id, at, d.point) };
}

function onDown(p: ToolPointer, ctx: ToolContext): void {
  const env = envOf(ctx);
  const local = ctx.scope.get(gestureSlot);
  local.gesture = null;
  if (!env) return;
  const areaStore = env.area.store;
  const st = areaStore.getState();
  const token = sceneToken(env, p.tokenId);
  const scale = ctx.camera().scale;
  const fpc = env.view.meta.settings.feetPerCell;
  const near = (a: { x: number; y: number }) => Math.hypot(a.x - p.world.x, a.y - p.world.y) * scale <= GRAB_PX;
  const begin = (g: Gesture) => {
    local.gesture = { ...g, screen: p.screen, moved: false };
  };

  if (st.pickCaster) {
    areaStore.setState({ pickCaster: false });
    if (token && st.draft) setDraft(env, usesFrom(st.draft.shape) && !st.draft.targetsOther ? fromToken(st.draft, token.id) : { ...st.draft, casterId: token.id });
    return begin({ kind: "none" });
  }

  const actx = areaContext(env.view, env.scene);

  if (!st.draft && st.selectedId) {
    const t = env.view.templates[st.selectedId];
    if (t && canEdit(env, t)) {
      const directional = isDirectional(t.shape);
      const pivot = templatePivot(t, env.view.tokens, fpc);
      const other = templateAt(env, actx, p.world);
      const press = pickedPress({
        directional,
        onCaster: pivot.onCaster,
        handle: directional && near(handlePoint(t, actx, HANDLE_GAP_PX / scale)),
        casterToken: !!token && token.id === t.casterId,
        inside: areaContains(t, actx, p.world),
        nearOrigin: near(liveOrigin(t, actx)),
        attached: !!t.attachedTo,
        otherArea: !!other && other.id !== t.id,
      });
      if (press === "turn" || press === "turnOrLetGo") {
        return begin({ kind: "turnTemplate", template: t, pivot: pivot.point, letGo: press === "turnOrLetGo" });
      }
      if (press === "move") return begin({ kind: "moveTemplate", template: t, start: p.world });
    }
  }

  let d = st.draft;
  if (!d) {
    const hit = idleTapPicks({ token: !!token, template: true }) === "template" ? templateAt(env, actx, p.world) : null;
    if (hit) {
      select(env.area, hit.id);
      return begin({ kind: "none" });
    }
    if (st.selectedId) {
      // A tap away from the picked area lets it go. The next tap starts a new one.
      select(env.area, null);
      return begin({ kind: "none" });
    }
    d = startDraft(env, env.area.defaultCaster);
    if (!token && d.casterId && usesFrom(d.shape)) d = { ...d, fromId: d.casterId };
  }

  if (token && usesFrom(d.shape) && token.id !== d.fromId) {
    const next = fromToken(d, token.id);
    setDraft(env, next);
    return begin(isDirectional(d.shape) ? { kind: "aim", pivot: centerOf(token) } : { kind: "none" });
  }

  const from = d.fromId ? sceneToken(env, d.fromId) : undefined;
  switch (d.shape) {
    case "sphere":
    case "cylinder":
      setDraft(env, { ...d, point: freePoint(env, d, p.world, token) });
      return begin({ kind: "point" });
    case "emanation":
      if (from || d.targetsOther) {
        setDraft(env, d);
        return begin({ kind: "none" });
      }
      setDraft(env, { ...d, point: freePoint(env, d, p.world, token) });
      return begin({ kind: "point" });
    case "cone":
    case "line":
    case "cube": {
      if (from) {
        const pivot = centerOf(from);
        // A press on the caster itself only grabs the aim: a point that close to the pivot has no real direction.
        setDraft(env, token?.id === from.id ? d : aimed(env, d, pivot, p.world));
        return begin({ kind: "aim", pivot });
      }
      if (d.shape === "cube") {
        // A free cube's point is its center, so a press inside the square grabs it.
        const half = d.size / fpc / 2;
        const inside = d.point && Math.abs(p.world.x - d.point.x) <= half && Math.abs(p.world.y - d.point.y) <= half;
        if (!d.point || inside || near(d.point)) {
          const center = snapCubeCenter(p.world, d.size, fpc);
          setDraft(env, { ...d, point: { ...center, z: freePointHeight(env.view.buildChunks, env.scene.id, center, d.point) } });
          return begin({ kind: "center" });
        }
        setDraft(env, aimed(env, d, d.point, p.world));
        return begin({ kind: "aim", pivot: { x: d.point.x, y: d.point.y } });
      }
      if (!d.point) {
        const point = freePoint(env, d, p.world, undefined);
        setDraft(env, { ...d, point });
        return begin({ kind: "aim", pivot: point });
      }
      if (near(d.point)) {
        setDraft(env, d);
        return begin({ kind: "point" });
      }
      setDraft(env, aimed(env, d, d.point, p.world));
      return begin({ kind: "aim", pivot: { x: d.point.x, y: d.point.y } });
    }
  }
}

function onMove(p: ToolPointer, ctx: ToolContext): void {
  const g = ctx.scope.get(gestureSlot).gesture;
  if (!g || g.kind === "none") return;
  const env = envOf(ctx);
  if (!env) return;
  if (!g.moved) {
    if (Math.hypot(p.screen.x - g.screen.x, p.screen.y - g.screen.y) < TAP_SLOP_PX) return;
    g.moved = true;
  }
  markMoving(env.area);
  const areaStore = env.area.store;
  const st = areaStore.getState();
  const fpc = env.view.meta.settings.feetPerCell;
  if (g.kind === "moveTemplate") {
    areaStore.setState({ live: movePatch(g.template, p.world.x - g.start.x, p.world.y - g.start.y) });
    return;
  }
  if (g.kind === "turnTemplate") {
    const yaw = yawToward(g.pivot, p.world);
    if (yaw !== null) areaStore.setState({ live: rotatePatch(g.template, snapYaw(yaw, st.snap), env.view.tokens, fpc) });
    return;
  }
  const d = st.draft;
  if (!d) return;
  if (g.kind === "aim") setDraft(env, aimed(env, d, g.pivot, p.world));
  else if (g.kind === "center") {
    const center = snapCubeCenter(p.world, d.size, fpc);
    setDraft(env, { ...d, point: { ...center, z: freePointHeight(env.view.buildChunks, env.scene.id, center, d.point) } });
  }
  else setDraft(env, { ...d, point: freePoint(env, d, p.world, undefined) });
}

function onUp(_p: ToolPointer, ctx: ToolContext): void {
  const local = ctx.scope.get(gestureSlot);
  const area = ctx.scope.get(areaSlot);
  const g = local.gesture;
  local.gesture = null;
  markRested(area);
  if (!g) return;
  const env = envOf(ctx);
  const { live } = area.store.getState();
  if (env && live && (g.kind === "moveTemplate" || g.kind === "turnTemplate")) updateTemplate(env, g.template.id, live);
  area.store.setState({ live: null });
  // Letting go waits for the lift, so a drag from the same press turns the area instead.
  if (g.kind === "turnTemplate" && g.letGo && !g.moved) select(area, null);
}

function onCancel(ctx: ToolContext): void {
  const area = ctx.scope.get(areaSlot);
  ctx.scope.get(gestureSlot).gesture = null;
  markRested(area);
  area.store.setState({ live: null });
}

export const areaTool: ToolDef = {
  id: "area",
  label: "Area",
  icon: { path: "M3 21 19.9 14.8A18 18 0 0 0 9.2 4.1z" },
  roles: ["dm", "player"],
  order: TOOL_ORDER.area,
  cursor: "crosshair",
  pointer: { down: onDown, move: onMove, up: onUp, cancel: onCancel },
  activate(ctx) {
    const s = ctx.getState();
    const area = ctx.scope.get(areaSlot);
    const local = ctx.scope.get(gestureSlot);
    const selected = s.local.selectedId ? s.view?.tokens[s.local.selectedId] : undefined;
    area.defaultCaster = s.view && s.you ? defaultCaster({ selected, sceneId: ctx.scene.id, you: s.you, characters: s.view.characters }) : null;
    resetAreaTool(area, null);
    if (local.pendingPick) select(area, local.pendingPick);
    local.pendingPick = null;
  },
  deactivate(ctx) {
    const local = ctx.scope.get(gestureSlot);
    local.gesture = null;
    local.pendingPick = null;
    resetAreaTool(ctx.scope.get(areaSlot), ctx.actions);
  },
  Options: AreaOptions,
};

/**
 * For the Areas panel: pick a placed template. When the tool is not active
 * yet, its activation would clear the pick, so it is applied after that.
 */
export function pickTemplate(scope: RoomScope, id: string, actions: RoomActions): void {
  const areaStore = scope.get(areaSlot).store;
  const { draft, shared } = areaStore.getState();
  if (draft && shared) actions.sendEph({ k: "aoeEnd", id: draft.id });
  areaStore.setState({ draft: null, shared: false, selectedId: id, live: null, query: "", pickCaster: false });
  scope.get(gestureSlot).pendingPick = id;
}
