import type { RoomState, Viewer } from "#shared/model.ts";
import { dropView } from "../movement/drop.ts";
import { dragLeaves } from "../movement/preview.ts";
import type { TurnLeaves } from "../movement/store.ts";
import { LegJobs } from "./opportunity.ts";

/*
 * The phone benchmark's page code (e2e/opportunity-bench.e2e.ts): the drag's
 * scan and the leg jobs' slices as the app runs them, bundled for a page
 * that runs nothing else, timed in the page under CPU throttling. The rooms
 * come from the test, built in Node. The app never imports it.
 */

const SETTLE_TASKS = 100_000;

/** The turn's jobs run to their end, each slice timed: what a stored leg's job costs a frame. */
export function sliceTimes(room: RoomState, viewer: Viewer): { slices: number[]; leaves: TurnLeaves } {
  const queue: (() => void)[] = [];
  const slices: number[] = [];
  const jobs = new LegJobs({ later: (run) => (queue.push(run), () => {}), load: { rolls: () => Promise.reject(new Error("none")), monsters: () => Promise.reject(new Error("none")) }, storage: null });
  jobs.sync({ key: "bench", view: room, viewer, on: true });
  for (let i = 0; i < SETTLE_TASKS && queue.length > 0; i++) {
    const run = queue.shift()!;
    const start = performance.now();
    run();
    slices.push(performance.now() - start);
  }
  return { slices, leaves: jobs.leaves.getState() };
}

/** A drag answer's scan to each target, from where the mover stands, with the turn's earlier legs settled: what a drag frame costs. */
export function dragTimes(room: RoomState, viewer: Viewer, moverId: string, targets: readonly { x: number; y: number }[]): { ms: number[]; said: string[] } {
  const { leaves } = sliceTimes(room, viewer);
  const view = dropView(room, viewer.role);
  const token = view.tokens[moverId]!;
  const ms: number[] = [];
  const said: string[] = [];
  for (const to of targets) {
    const start = performance.now();
    const out = dragLeaves({ view, token, landed: { ...token, x: to.x, y: to.y }, corners: [], reach: { viewer, shown: true, turn: leaves }, labels: new Map(), role: viewer.role });
    ms.push(performance.now() - start);
    said.push(out === null ? "none" : out.leaves === "over" ? "over" : `${out.ids.length}`);
  }
  return { ms, said };
}

