import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { findRoute, WorkBudget } from "#shared/rules/walk.ts";
import { RoomScope } from "../../state/scope.ts";
import { dropView, routeTarget, type DropPlan, type Point, type Role } from "./drop.ts";
import { worldFor } from "./press.ts";
import type { RouteAnswer } from "./routeDrag.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps, type DragStops } from "./stageHooks.ts";
import { routeSlot, type DragRoute } from "./store.ts";

/**
 * A lone drag as the board takes it, for tests: the board's own drag
 * stops (stageHooks.ts dragStops) on one viewer's copy, the finger held at
 * `raw` frame after frame until the search and the straight leg's own check
 * settle. It gives the picture the board draws there, the fields its frames
 * send others, and the plan the drop lands and the op it sends. `answer` is
 * what the search finds, searched again apart only when a test reads it.
 * Never imported by production code.
 */
export type Drag = {
  readonly answer: Exclude<RouteAnswer, { kind: "searching" }>;
  preview: DragRoute;
  frame: ReturnType<DragStops["frameFields"]>;
  plan: DropPlan;
  op: ClientOp | null;
};

/** Frames by hand: each runs what waited for it. */
class Hand implements Frames {
  queue: (() => void)[] = [];
  now(): number {
    return 0;
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  frame(): void {
    for (const run of this.queue.splice(0)) run();
  }
}

/** Frames enough for any search here to settle: each frame's budget is far past what one drag's search spends. */
const FRAMES = 200;

export function dragOf(copy: RoomState, role: Role, tokenId: string, raw: Point): Drag {
  const frames = new Hand();
  const work = new RouteWork(frames, () => new WorkBudget({ limit: 1e9 }));
  const sent: ClientOp[] = [];
  const scope = new RoomScope();
  const stops = dragStops({
    store: { getState: () => ({ view: copy }) } as unknown as DragDeps["store"],
    actions: { dispatch: (op: ClientOp) => sent.push(op), newId: () => `drag-${sent.length}` } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope,
    role,
    work,
  });
  const token = copy.tokens[tokenId]!;
  const finger = { x: () => raw.x, y: () => raw.y, position: () => {} };
  frames.frame();
  stops.start(tokenId);
  let preview: DragRoute | null = null;
  for (let k = 0; k < FRAMES; k++) {
    stops.frame(finger, token);
    frames.frame();
    preview = scope.get(routeSlot).getState().route;
    if (preview && !preview.searching && !work.waiting) break;
  }
  if (!preview || preview.searching) throw new Error(`the drag of ${tokenId} never settled`);
  const frame = stops.frameFields(tokenId);
  let plan: DropPlan | null = null;
  stops.drop(finger, token, [token], (landed) => (plan = landed));
  for (let k = 0; k < FRAMES && !plan; k++) frames.frame();
  if (!plan) throw new Error(`the drop of ${tokenId} never landed`);
  stops.send(plan);
  stops.end();
  let answer: Drag["answer"] | null = null;
  return {
    get answer() {
      if (answer) return answer;
      const view = dropView(copy, role);
      const found = findRoute(worldFor(view, view.tokens[tokenId]!, role).input, routeTarget(view, token, raw));
      return (answer = found === null ? { kind: "open" } : found === "none" ? { kind: "none", capped: false } : { kind: "route", route: found });
    },
    preview,
    frame,
    plan,
    op: sent[0] ?? null,
  };
}
