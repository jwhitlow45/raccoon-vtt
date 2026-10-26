import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { footprintSize } from "#shared/rules/footprint.ts";
import { findRoute, WorkBudget, type WalkInput } from "#shared/rules/walk.ts";
import { snapPosition } from "../../lib/scene.ts";
import type { DragRead } from "../measure/movement.ts";
import { RoomScope } from "../../state/scope.ts";
import { dropGrid, dropView, routeTarget, type DropPlan, type Point, type Role } from "./drop.ts";
import { worldFor } from "./press.ts";
import { groupReading } from "./preview.ts";
import { RouteDrag, type RouteAnswer, type Settled } from "./routeDrag.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps, type DragStops } from "./stageHooks.ts";
import { holdSlot, routeSlot, type DragRoute, type Hold } from "./store.ts";

/**
 * A lone drag as the board takes it, for tests: the board's own drag
 * stops (stageHooks.ts dragStops) on one viewer's copy, the finger held at
 * `raw` frame after frame until the search and the straight leg's own check
 * settle. It gives the picture the board draws there, the fields its frames
 * send others, and the plan the drop lands and the op it sends. `answer` is
 * what the search finds, searched again apart only when a test reads it.
 * `slow` gives each frame that budget instead, so the straight leg's own
 * check settles frames after the hold first stands, as on a busy device.
 * Never imported by production code.
 */
export type Drag = {
  readonly answer: Exclude<RouteAnswer, { kind: "searching" }>;
  preview: DragRoute;
  /** Where the board held the preview before the drop, and what it said there. */
  hold: Hold | null;
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

/** The board's drag stops on one viewer's copy, with frames by hand and the ops they send kept. */
function board(copy: RoomState, role: Role, budget = 1e9) {
  const frames = new Hand();
  const work = new RouteWork(frames, () => new WorkBudget({ limit: budget }));
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
  return { frames, work, sent, scope, stops };
}

export function dragOf(copy: RoomState, role: Role, tokenId: string, raw: Point, slow?: { budget: number; frames: number }): Drag {
  const { frames, work, sent, scope, stops } = board(copy, role, slow?.budget);
  const token = copy.tokens[tokenId]!;
  const finger = { x: () => raw.x, y: () => raw.y, position: () => {} };
  frames.frame();
  stops.start(tokenId);
  let preview: DragRoute | null = null;
  const most = slow?.frames ?? FRAMES;
  for (let k = 0; k < most; k++) {
    stops.frame(finger, token);
    frames.frame();
    preview = scope.get(routeSlot).getState().route;
    if (preview && !preview.searching && !work.waiting) break;
  }
  if (!preview || preview.searching) throw new Error(`the drag of ${tokenId} never settled`);
  const frame = stops.frameFields(tokenId);
  const hold = scope.get(holdSlot).getState().hold;
  let plan: DropPlan | null = null;
  stops.drop(finger, token, [token], (landed) => (plan = landed));
  for (let k = 0; k < most && !plan; k++) frames.frame();
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
    hold,
    frame,
    plan,
    op: sent[0] ?? null,
  };
}

/** What a drag's search settles on for a spot, its drop's work run to the end at once: the way it shows, and the note when there is none. */
export function settledAt(input: WalkInput, to: Point): Settled {
  const drag = new RouteDrag(() => input, new RouteWork(new Hand(), () => new WorkBudget({ limit: 1e9 })));
  let answer: Settled | null = null;
  drag.drop(to, (landed) => (answer = landed));
  drag.flush();
  if (!answer) throw new Error("the drag's search never settled");
  return answer;
}

/**
 * A group drag as the board takes it, for tests: the lead dropped at `raw`,
 * the others by the same offset, the lead's label as the board's ruler
 * reads it there (RulerLayer.tsx DragMeasure), the fields its frames send,
 * and what the drop sends.
 */
export type GroupDrag = { label: DragRead; frame: ReturnType<DragStops["groupFields"]>; plan: DropPlan; op: ClientOp | null };

export function groupDragOf(copy: RoomState, role: Role, tokenIds: readonly string[], raw: Point): GroupDrag {
  const { frames, sent, stops } = board(copy, role);
  const group = tokenIds.map((id) => copy.tokens[id]!);
  const finger = { x: () => raw.x, y: () => raw.y, position: () => {} };
  const lead = group[0]!;
  const label = groupReading(dropView(copy, role), lead, snapPosition(dropGrid(copy, lead), raw.x, raw.y, footprintSize(lead)), role);
  const frame = stops.groupFields(lead, raw);
  frames.frame();
  stops.start(lead.id);
  let plan: DropPlan | null = null;
  stops.drop(finger, group[0]!, group, (landed) => (plan = landed));
  for (let k = 0; k < FRAMES && !plan; k++) frames.frame();
  if (!plan) throw new Error("the group's drop never landed");
  stops.send(plan);
  stops.end();
  return { label, frame, plan, op: sent[0] ?? null };
}
