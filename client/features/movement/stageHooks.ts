import { useEffect, useMemo } from "react";
import type { RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { WalkWorld } from "#shared/rules/walk.ts";
import { publicWorld, type PublicWorld } from "#shared/rules/walkWorld.ts";
import type { OpAnswer } from "../../state/types.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi } from "../../state/view.ts";
import { pathNow } from "../measure/movement.ts";
import { dropMode, keyStep, planGroup, planOne, planWalk, routeTarget, type DropPlan, type DropToken, type Found, type Point, type Role, type Stop } from "./drop.ts";
import { walkPreview } from "./preview.ts";
import { RouteDrag, type Frames, type RouteAnswer } from "./routeDrag.ts";
import { sendPlan } from "./send.ts";
import { holdSlot, routeSlot, sameHold, stopNoteSlot, type DragRoute } from "./store.ts";

/** The part of a Konva node a drag reads and moves. */
type DragNode = { x(): number; y(): number; position(p: Point): void };

/**
 * What the map canvas (client/canvas/Stage.tsx) asks of walls, ledges and
 * routes while a token is dragged and dropped
 * (docs/design-v1-maps-vision.md 4.1, docs/design-v1-movement.md 3.1).
 * Kept here so the canvas needs a line for each step of a drag.
 */
export type DragStops = {
  /** A drag began: an earlier note about this token goes. */
  start(tokenId: string): void;
  /**
   * A frame of a lone token's drag. Its route is searched toward the spot
   * under the finger. While no route reaches it for a player whose walls
   * stop moves, the preview stays on the last clear spot before the wall
   * or the ledge, so a drop never bounces back.
   */
  frame(node: DragNode, token: DropToken): void;
  /** What a frame sends others besides where the token is: the route's corners and the leg's cost (6.5). */
  frameFields(tokenId: string): { path?: number[]; ft?: number };
  /**
   * Where the drop puts the dragged token, and the rest of its group, by
   * the rules, at once: an arrow key's step of one square, never searched
   * round a wall, its own terrain counted (drop.ts keyStep).
   */
  plan(node: DragNode, token: DropToken, group: readonly DropToken[]): DropPlan;
  /**
   * The drop: `land` hears its plan once its route is known, at once when
   * it is, else when the search settles, the token waiting at the ghost.
   */
  drop(node: DragNode, token: DropToken, group: readonly DropToken[], land: (plan: DropPlan) => void): void;
  /**
   * Sends the plan's moves, and says what stopped any of them (send.ts).
   * `onAnswer` hears what became of each op sent (OpAnswer). Returns the
   * `n` of each op sent.
   */
  send(plan: DropPlan, onAnswer?: (op: ClientOp, answer: OpAnswer) => void): number[];
  /** The drag ended without a drop, or the board went away: a drop still waiting never lands. */
  end(): void;
};

const NOTHING: DropPlan = { moves: [], stop: null, held: [] };

const BROWSER_FRAMES: Frames = {
  now: () => performance.now(),
  request: (run) => requestAnimationFrame(() => run()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** The parts of the room a drag's world is built from: when one changes during the drag, the world is built again (9, "A door closes during a drag"). */
type Basis = Pick<RoomState, "buildChunks" | "templates" | "tokens" | "fogTiles" | "exploredTiles"> & { scene: unknown };

function basisOf(view: RoomState, sceneId: string): Basis {
  return { buildChunks: view.buildChunks, templates: view.templates, tokens: view.tokens, fogTiles: view.fogTiles, exploredTiles: view.exploredTiles, scene: view.scenes[sceneId] };
}

function sameBasis(a: Basis, b: Basis): boolean {
  return a.buildChunks === b.buildChunks && a.templates === b.templates && a.tokens === b.tokens && a.fogTiles === b.fogTiles && a.exploredTiles === b.exploredTiles && a.scene === b.scene;
}

/** The public world for a walk by this token as this device sees the room (docs/design-v1-movement.md 5.5). */
function worldFor(view: RoomState, token: Token, role: Role): PublicWorld {
  const stops = pathNow(view.encounter, token, role)?.stops ?? [];
  return publicWorld(view, token, { role }, stops);
}


/** The search's answer as the planner takes it. A search still running has none yet. */
function found(answer: Exclude<RouteAnswer, { kind: "searching" }>): Found {
  return answer.kind === "route" ? { kind: "route", route: answer.route } : answer;
}


/** A lone drag's walk. `held` is where the preview holds at a wall when no route reaches the finger's spot. */
type Walk = { tokenId: string; drag: RouteDrag; world: PublicWorld | null; basis: Basis; token: Token; target: Point | null; held: Point | null; waiting: boolean };

export function useDragStops(role: Role): DragStops {
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const stops = useMemo((): DragStops => {
    const holds = scope.get(holdSlot);
    const notes = scope.get(stopNoteSlot);
    const routes = scope.get(routeSlot);
    /** Where the finger is, before a hold moved the preview back to the wall: the drop's own spot. */
    let raw: ({ tokenId: string } & Point) | null = null;
    /** The lone drag's search, its world and what the world was built from. */
    let walk: Walk | null = null;
    /*
     * The leg test runs again only when the finger crosses into another
     * quarter cell, the finest step a drop snaps by (half cells, and the
     * squeezed spots half a cell off the grid), or the room changed, never on
     * every pointer frame. The walls are derived once per build and cached
     * across drags (walls.ts sceneWalls), so a frame costs at most one drop's
     * leg tests.
     */
    let memo: { view: RoomState; token: DropToken; qx: number; qy: number; stop: Stop | null } | null = null;
    const setHold = (next: { tokenId: string; at: Point; blocker: Stop["blocker"] } | null) => {
      if (!sameHold(holds.getState().hold, next)) holds.setState({ hold: next });
    };
    const setRoute = (next: DragRoute | null) => {
      if (routes.getState().route !== next) routes.setState({ route: next });
    };
    /**
     * Clears the drag's search and preview. A new drag or a key press first
     * lands a drop still waiting for its route (`land`), so it is never thrown
     * away with no move and no word to the others. The board going away
     * cancels it.
     */
    const reset = (land = false) => {
      if (land && walk?.waiting) walk.drag.flush();
      raw = null;
      memo = null;
      walk?.drag.cancel();
      walk = null;
      setHold(null);
      setRoute(null);
    };

    /** The board's picture of the walk: the line, the label and, while a drop waits, the ghost's words. */
    const publish = (w: Walk) => {
      const view = store.getState().view;
      const target = w.target;
      if (!view || !target || walk !== w) return;
      const answer = w.drag.answer;
      setRoute({ tokenId: w.token.id, ...walkPreview({ view, token: w.token, target, answer, held: w.held, world: w.world, role }), searching: answer.kind === "searching", waiting: w.waiting });
    };

    /** The drag's search for this token, begun on its first frame and told when the room changes under it. */
    const walkFor = (view: RoomState, dropToken: DropToken): Walk | null => {
      const token = view.tokens[dropToken.id];
      if (!token) return null;
      const basis = basisOf(view, token.sceneId);
      if (!walk || walk.tokenId !== token.id) {
        walk?.drag.cancel();
        const w: Walk = { tokenId: token.id, drag: null as unknown as RouteDrag, world: null, basis, token, target: null, held: null, waiting: false };
        w.drag = new RouteDrag(
          () => {
            w.world = worldFor(store.getState().view ?? view, w.token, role);
            return w.world.input;
          },
          BROWSER_FRAMES,
          () => publish(w),
        );
        walk = w;
      } else if (!sameBasis(walk.basis, basis)) {
        walk.basis = basis;
        walk.token = token;
        walk.drag.rebuild();
      }
      return walk;
    };

    return {
      start(tokenId) {
        reset(true);
        const s = notes.getState();
        if (s.note?.tokenId === tokenId && !s.busy) notes.setState({ note: null });
      },
      frame(node, token) {
        raw = { tokenId: token.id, x: node.x(), y: node.y() };
        const view = store.getState().view;
        if (!view) {
          setHold(null);
          return;
        }
        const w = walkFor(view, token);
        const target = routeTarget(view, token, raw);
        let answer: RouteAnswer = { kind: "open" };
        if (w) {
          const moved = !w.target || w.target.x !== target.x || w.target.y !== target.y;
          w.target = target;
          answer = w.drag.aim(target);
          if (moved) publish(w);
        }
        const holdAt = (at: Point | null) => {
          if (!w || (w.held?.x === at?.x && w.held?.y === at?.y)) return;
          w.held = at;
          publish(w);
        };
        if (dropMode(role, view.scenes[token.sceneId]) !== "walk" || answer.kind !== "none") {
          holdAt(null);
          setHold(null);
          return;
        }
        const qx = Math.floor(raw.x * 4);
        const qy = Math.floor(raw.y * 4);
        if (!memo || memo.view !== view || memo.token !== token || memo.qx !== qx || memo.qy !== qy) {
          memo = { view, token, qx, qy, stop: planOne(view, token, raw, "walk").stop };
        }
        const stop = memo.stop;
        if (stop) node.position(stop.at);
        // The line and the label stop at the wall with the preview.
        holdAt(stop ? stop.at : null);
        setHold(stop ? { tokenId: token.id, at: stop.at, blocker: stop.blocker } : null);
      },
      frameFields(tokenId) {
        const route = routes.getState().route;
        if (!route || route.tokenId !== tokenId) return {};
        return { ...(route.corners.length > 0 ? { path: route.corners.flatMap((c) => [c.x, c.y]) } : {}), ft: route.read.dragFt };
      },
      plan(node, token, group) {
        const at = raw?.tokenId === token.id ? { x: raw.x, y: raw.y } : { x: node.x(), y: node.y() };
        reset(true);
        const view = store.getState().view;
        if (!view) return NOTHING;
        const mode = dropMode(role, view.scenes[token.sceneId]);
        if (group.length > 1) return planGroup(view, group, at.x - token.x, at.y - token.y, mode);
        const full = view.tokens[token.id];
        if (!full) return planOne(view, token, at, mode);
        // One square, never searched round a wall, its own terrain counted.
        const step = keyStep(new WalkWorld(worldFor(view, full, role).input), routeTarget(view, token, at));
        return planWalk(view, token, at, mode, step, view.meta.settings.feetPerCell);
      },
      drop(node, token, group, land) {
        const at = raw?.tokenId === token.id ? { x: raw.x, y: raw.y } : { x: node.x(), y: node.y() };
        const view = store.getState().view;
        if (!view) {
          reset();
          land(NOTHING);
          return;
        }
        const mode = dropMode(role, view.scenes[token.sceneId]);
        const w = group.length > 1 ? null : walkFor(view, token);
        if (!w) {
          reset();
          land(group.length > 1 ? planGroup(view, group, at.x - token.x, at.y - token.y, mode) : planOne(view, token, at, mode));
          return;
        }
        const target = routeTarget(view, token, at);
        w.target = target;
        w.waiting = true;
        raw = null;
        memo = null;
        setHold(null);
        w.drag.drop(target, (answer) => {
          const now = store.getState().view ?? view;
          if (walk === w) walk = null;
          setRoute(null);
          land(planWalk(now, token, at, dropMode(role, now.scenes[token.sceneId]), found(answer), now.meta.settings.feetPerCell));
        });
        // Still searching: the drop waits at the ghost, which says so.
        if (walk === w) publish(w);
      },
      send(plan, onAnswer) {
        return sendPlan(plan, {
          dispatch: (op, opts) => actions.dispatch(op, onAnswer ? { ...opts, onAnswer: (answer) => onAnswer(op, answer) } : opts),
          newId: () => actions.newId(),
          note: (note) => notes.setState({ note, busy: false }),
          notify: (text) => ui.notify(text),
          showActions: (open) => ui.showActions(open),
        });
      },
      end: () => reset(),
    };
  }, [store, actions, ui, scope, role]);
  // A drop still waiting for its route when the board goes away never lands.
  useEffect(() => () => stops.end(), [stops]);
  return stops;
}
