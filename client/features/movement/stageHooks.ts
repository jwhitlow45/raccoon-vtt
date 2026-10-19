import { useEffect, useMemo } from "react";
import type { RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { routePoints, type RoutePiece } from "#shared/rules/route.ts";
import { LegCheck, WalkWorld, WorkBudget, worldUnits, type WalkRoute } from "#shared/rules/walk.ts";
import type { PublicWorld } from "#shared/rules/walkWorld.ts";
import { walkersFor, walkersOfGroup } from "../attach/walk.ts";
import type { OpAnswer } from "../../state/types.ts";
import { useRoomScope, type RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { RoomActions } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, type RoomViewStore } from "../../state/view.ts";
import { cutForWalkers, cutRoute, dropMode, goesStraight, keyStep, landedElevation, planGroup, planLands, planOne, planWalk, routeTarget, samePose, walkersStop, type DropPlan, type DropToken, type Found, type Point, type Pose, type Role, type Stop, type WalkersCut } from "./drop.ts";
import { frameFields as routeFrame, walkPreview } from "./preview.ts";
import { pressPlan, worldFor } from "./press.ts";
import { RouteDrag, type RouteAnswer } from "./routeDrag.ts";
import { BOARD_WORK } from "./boardWork.ts";
import type { RouteJob, RouteWork } from "./routeWork.ts";
import { sendPlan } from "./send.ts";
import { holdSlot, routeSlot, sameHold, stopNoteSlot, type DragRoute } from "./store.ts";

/** Where a drag's preview is held, and what holds it. */
type Hold = { at: Point; blocker: Stop["blocker"] };

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
   * or the ledge, so a drop never bounces back, and so it does where a
   * creature the token drags beside it would meet one
   * (docs/design-v1-attach.md 4.2).
   */
  frame(node: DragNode, token: DropToken): void;
  /** What a frame sends others besides where the token is: the route's corners and the leg's cost (6.5), and where a cut walk lands. */
  frameFields(tokenId: string): { x?: number; y?: number; path?: number[]; ft?: number };
  /**
   * An arrow key's press: where it puts the token, and the rest of its
   * group, by the rules, a step of one square, never searched round a wall,
   * what it walks over counted (drop.ts planPress), and sends it. It is
   * planned and sent through the board's route work (routeWork.ts): at once
   * while the frame has budget left, else at the next frame's turn, ahead
   * of everything but the drag.
   */
  press(node: DragNode, token: DropToken, group: readonly DropToken[]): void;
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

/** The parts of the room a drag's world is built from: when one changes during the drag, the world is built again (9, "A door closes during a drag"). */
type Basis = Pick<RoomState, "buildChunks" | "templates" | "tokens" | "fogTiles" | "exploredTiles"> & { scene: unknown };

function basisOf(view: RoomState, sceneId: string): Basis {
  return { buildChunks: view.buildChunks, templates: view.templates, tokens: view.tokens, fogTiles: view.fogTiles, exploredTiles: view.exploredTiles, scene: view.scenes[sceneId] };
}

function sameBasis(a: Basis, b: Basis): boolean {
  return a.buildChunks === b.buildChunks && a.templates === b.templates && a.tokens === b.tokens && a.fogTiles === b.fogTiles && a.exploredTiles === b.exploredTiles && a.scene === b.scene;
}



/** The search's answer as the planner takes it. A search still running has none yet. */
function found(answer: Exclude<RouteAnswer, { kind: "searching" }>): Found {
  return answer.kind === "route" ? { kind: "route", route: answer.route } : answer;
}


/**
 * A lone drag's walk. `held` is where the preview holds at a wall when no
 * route reaches the finger's spot, and `walkers` where it holds because a
 * creature the token drags would meet one. `straight` is the straight
 * walk's own route to where the drop would land when it goes straight,
 * checked a few steps at a time on the frame's budget, so the label reads
 * what the drop will count.
 */
type Walk = {
  tokenId: string;
  drag: RouteDrag;
  world: PublicWorld | null;
  basis: Basis;
  token: Token;
  target: Point | null;
  held: Pose | null;
  walkers: WalkersCut | null;
  waiting: boolean;
  node: DragNode | null;
  drawn: DropToken | null;
  straight: { to: Pose; job: RouteJob; pieces: RoutePiece[] | null } | null;
};

/** What a drag's stops read and write: the room, its actions, the board's UI, the room's scope and the board's route work. */
export type DragDeps = {
  store: Pick<RoomViewStore, "getState">;
  actions: Pick<RoomActions, "dispatch" | "newId">;
  ui: Pick<RoomUi, "notify" | "showActions">;
  scope: Pick<RoomScope, "get">;
  role: Role;
  work: RouteWork;
};

export function useDragStops(role: Role): DragStops {
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const stops = useMemo(() => dragStops({ store, actions, ui, scope, role, work: BOARD_WORK }), [store, actions, ui, scope, role]);
  // A drop still waiting for its route when the board goes away never lands.
  useEffect(() => () => stops.end(), [stops]);
  return stops;
}

/** The drag's stops, free of React, so dragStops.test.ts drives them under Node. */
export function dragStops(deps: DragDeps): DragStops {
  const { store, actions, ui, scope, role, work } = deps;
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
  let memo: { view: RoomState; token: DropToken; qx: number; qy: number; mode: string; stop: Stop | null; lands: Pose } | null = null;
  /**
   * The same for the creatures a holder drags beside it
   * (docs/design-v1-attach.md 4.2): where along the holder's walk to
   * `target`, its route or else the straight leg, the first of them would
   * meet a wall. Asked again only for a new spot, a new route or a
   * changed room.
   */
  let walkMemo: { view: RoomState; token: DropToken; target: Point; route: WalkRoute | null; stop: (WalkersCut & Hold) | null } | null = null;
  const walkersHold = (view: RoomState, token: DropToken, target: Point, route: WalkRoute | null): (WalkersCut & Hold) | null => {
    if (walkMemo && walkMemo.view === view && walkMemo.token === token && walkMemo.route === route && walkMemo.target.x === target.x && walkMemo.target.y === target.y) return walkMemo.stop;
    const walkers = walkersFor(view, token.id, role);
    let stop: (WalkersCut & Hold) | null = null;
    if (walkers.length > 0) {
      // The route as the drop would land it, cut past 64 pieces (drop.ts cutRoute), as the preview draws it.
      const long = route ? cutRoute(view, token, route.pieces) : null;
      const end = long ? long.at : target;
      const landing = landedElevation(view.buildChunks, token, end);
      const points = route
        ? routePoints(view.buildChunks, token, long ? long.pieces : route.pieces, landing)
        : [
            { x: token.x, y: token.y, elevation: token.elevation },
            { x: end.x, y: end.y, elevation: landing },
          ];
      const cut = walkersStop(view, token, points, walkers);
      stop = cut ? { at: { x: cut.at.x, y: cut.at.y }, pieces: cut.pieces, blocker: cut.blocker } : null;
    }
    walkMemo = { view, token, target: { x: target.x, y: target.y }, route, stop };
    return stop;
  };
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
  /**
   * Drops and presses waiting for the frame's budget to land, in the order
   * they came. A new drag or a press lands them first. The board ending
   * drops them: one cancelled never sends or lands, even from a turn
   * already under way (review ASTRA-16).
   */
  const landings: { job: RouteJob; live: boolean }[] = [];
  const later = (land: (budget: WorkBudget) => void) => {
    const waiting = {
      live: true,
      job: {
        first: true,
        run: (budget: WorkBudget) => {
          const k = landings.indexOf(waiting);
          if (k >= 0) landings.splice(k, 1);
          if (waiting.live) {
            waiting.live = false;
            land(budget);
          }
          return true;
        },
      } as RouteJob,
    };
    landings.push(waiting);
    work.run(waiting.job);
  };
  const reset = (land = false) => {
    if (land && walk?.waiting) walk.drag.flush();
    // A drop or a press still waiting for its frame lands first too, the flush's one exception to the budget, or with no landing wanted it goes.
    for (const waiting of landings.splice(0)) {
      work.drop(waiting.job);
      if (land) waiting.job.run(WorkBudget.all());
      waiting.live = false;
    }
    raw = null;
    memo = null;
    walkMemo = null;
    if (walk) goStraight(walk, null);
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
    const straight = w.straight?.pieces ? { to: w.straight.to, pieces: w.straight.pieces } : null;
    setRoute({ tokenId: w.token.id, ...walkPreview({ view, token: w.token, target, answer, held: w.held, walkers: w.walkers, world: w.world, role, straight }), searching: answer.kind === "searching", waiting: w.waiting });
  };

  /** The straight walk to `to` checked for what it walks over, or none wanted (null). */
  const goStraight = (w: Walk, to: Pose | null) => {
    if (w.straight && to && samePose(w.straight.to, to)) return;
    if (w.straight) work.drop(w.straight.job);
    w.straight = null;
    const world = w.drag.world;
    if (!to || !world) return;
    const check = new LegCheck(world, to, true);
    const straight: NonNullable<Walk["straight"]> = {
      to,
      pieces: null,
      job: {
        first: true,
        run: (budget) => {
          if (w.straight !== straight) return true;
          const late = (units = 1) => {
            budget.charge(units);
            return budget.spent;
          };
          if (!check.run(late)) return false;
          straight.pieces = check.open || check.stopped || !check.route ? null : check.route.pieces;
          if (straight.pieces) publish(w);
          return true;
        },
      },
    };
    w.straight = straight;
    work.run(straight.job);
  };

  /**
   * Where the preview stands for the drag's answer now. A drop with no
   * route, or with one it would not take, goes as the straight leg, and the
   * picture ends where that leg lands: held at the last clear spot before
   * the wall, squeezed, or snapped, the line and the label with it.
   */
  const follow = (view: RoomState, w: Walk | null, node: DragNode, token: DropToken, target: Point) => {
    const answer: RouteAnswer = w ? w.drag.answer : { kind: "open" };
    const holdAt = (at: Pose | null, walkers: WalkersCut | null = null) => {
      if (!w || (samePose(w.held, at) && w.walkers?.at.x === walkers?.at.x && w.walkers?.at.y === walkers?.at.y && w.walkers?.pieces === walkers?.pieces)) return;
      w.held = at;
      w.walkers = walkers;
      publish(w);
    };
    const mode = dropMode(role, view.scenes[token.sceneId]);
    if (!raw || raw.tokenId !== token.id || !goesStraight(view, token, target, answer, view.meta.settings.feetPerCell)) {
      // The walk itself is clear: the preview, its line and its label stop where a creature it drags would meet a wall.
      const cut = raw?.tokenId === token.id && mode === "walk" && answer.kind !== "searching" ? walkersHold(view, token, target, answer.kind === "route" ? answer.route : null) : null;
      if (cut) node.position(cut.at);
      holdAt(null, cut);
      setHold(cut ? { tokenId: token.id, at: cut.at, blocker: cut.blocker } : null);
      if (w) goStraight(w, null);
      return;
    }
    // The picture ends where planOne lands, not at the spot under the pointer (review MV-O-24).
    const qx = Math.floor(raw.x * 4);
    const qy = Math.floor(raw.y * 4);
    if (!memo || memo.view !== view || memo.token !== token || memo.qx !== qx || memo.qy !== qy || memo.mode !== mode) {
      const plan = planOne(view, token, raw, mode);
      memo = { view, token, qx, qy, mode, stop: plan.stop, lands: planLands(plan, token) };
    }
    // Held at its own wall, the walk there may still be cut shorter by a creature it drags.
    const own = memo.stop;
    const stop: Hold | null = (own && mode === "walk" ? walkersHold(view, token, own.at, null) : null) ?? own;
    if (stop) node.position(stop.at);
    if (w) goStraight(w, memo.lands);
    holdAt(stop && stop !== own ? stop.at : memo.lands);
    setHold(stop ? { tokenId: token.id, at: stop.at, blocker: stop.blocker } : null);
  };

  /** The drag's search for this token, begun on its first frame and told when the room changes under it. */
  const walkFor = (view: RoomState, dropToken: DropToken): Walk | null => {
    const token = view.tokens[dropToken.id];
    if (!token) return null;
    const basis = basisOf(view, token.sceneId);
    if (!walk || walk.tokenId !== token.id) {
      walk?.drag.cancel();
      const w: Walk = { tokenId: token.id, drag: null as unknown as RouteDrag, world: null, basis, token, target: null, held: null, walkers: null, waiting: false, node: null, drawn: null, straight: null };
      w.drag = new RouteDrag(
        () => {
          w.world = worldFor(store.getState().view ?? view, w.token, role);
          return w.world.input;
        },
        work,
        () => {
          // An answer that came in a later frame holds the preview at the wall as one that came at once does.
          const now = store.getState().view;
          if (walk === w && !w.waiting && now && w.node && w.drawn && w.target) follow(now, w, w.node, w.drawn, w.target);
          publish(w);
        },
      );
      walk = w;
    } else if (!sameBasis(walk.basis, basis)) {
      walk.basis = basis;
      walk.token = token;
      goStraight(walk, null);
      walk.drag.rebuild();
    }
    return walk;
  };

  const send = (plan: DropPlan, onAnswer?: (op: ClientOp, answer: OpAnswer) => void): number[] =>
    sendPlan(plan, {
      dispatch: (op, opts) => actions.dispatch(op, onAnswer ? { ...opts, onAnswer: (answer) => onAnswer(op, answer) } : opts),
      newId: () => actions.newId(),
      note: (note) => notes.setState({ note, busy: false }),
      notify: (text) => ui.notify(text),
      showActions: (open) => ui.showActions(open),
    });

  return {
    start(tokenId) {
      reset(true);
      const s = notes.getState();
      if (s.note?.tokenId === tokenId && !s.busy) notes.setState({ note: null });
    },
    frame(node, token) {
      // The preview always follows the finger, its time counted against the frame's budget all the same.
      work.within(() => {
        raw = { tokenId: token.id, x: node.x(), y: node.y() };
        const view = store.getState().view;
        if (!view) {
          setHold(null);
          return;
        }
        const w = walkFor(view, token);
        const target = routeTarget(view, token, raw);
        if (w) {
          const moved = !w.target || w.target.x !== target.x || w.target.y !== target.y;
          w.target = target;
          w.node = node;
          w.drawn = token;
          w.drag.aim(target);
          if (moved) publish(w);
        }
        follow(view, w, node, token, target);
      });
    },
    frameFields(tokenId) {
      const route = routes.getState().route;
      if (!route || route.tokenId !== tokenId) return {};
      return routeFrame(route);
    },
    press(node, drawn, drawnGroup) {
      const asked = raw?.tokenId === drawn.id ? { x: raw.x, y: raw.y } : { x: node.x(), y: node.y() };
      // A drop still waiting lands first, and the press steps on from where it put the token.
      reset(true);
      later((budget) => {
        const view = store.getState().view;
        if (view) send(pressPlan(view, drawn, asked, drawnGroup, role, budget));
      });
    },
    drop(node, token, group, land) {
      // A drop's work, its time counted against the frame's budget, and its landing queued as route work when the budget is spent.
      work.within(() => {
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
          land(group.length > 1 ? planGroup(view, group, at.x - token.x, at.y - token.y, mode, walkersOfGroup(view, group, role)) : planOne(view, token, at, mode));
          return;
        }
        const target = routeTarget(view, token, at);
        w.target = target;
        w.waiting = true;
        raw = null;
        memo = null;
        setHold(null);
        w.drag.drop(target, (answer) => {
          // The landing is route work too: a straight drop counts what its straight leg walks over (drop.ts planWalk).
          later((budget) => {
            const now = store.getState().view ?? view;
            goStraight(w, null);
            if (walk === w) walk = null;
            setRoute(null);
            const world = w.world;
            const account = world
              ? (to: Point) => {
                  const own = new WalkWorld(world.input);
                  budget.charge(worldUnits(own));
                  return keyStep(own, to, (units) => budget.charge(units));
                }
              : undefined;
            const nowMode = dropMode(role, now.scenes[token.sceneId]);
            land(cutForWalkers(now, token, planWalk(now, token, at, nowMode, found(answer), now.meta.settings.feetPerCell, account), walkersFor(now, token.id, role), nowMode));
          });
        });
        // Still searching: the drop waits at the ghost, which says so.
        if (walk === w) publish(w);
      });
    },
    send,
    end: () => reset(),
  };
}
