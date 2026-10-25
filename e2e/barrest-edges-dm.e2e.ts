import { edgeSweepTest, frameSteps, restFile } from "./barrestRoom.ts";

/**
 * The resting token bar, br-f-5's pass for the DM: every edge and corner
 * token panned in above the strip and tapped at the four phones, in a file
 * of its own so the CI shards can run it beside barrest.e2e.ts and the
 * other passes. It builds its own room.
 */
restFile("br-f-5 for the DM", () => frameSteps(() => edgeSweepTest("DM")));
