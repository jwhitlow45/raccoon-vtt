import { sweepFile, sweepTest } from "./optionsRoom.ts";

/**
 * Tool options in one row, case 2: the player's reach sweeps at 100% and 130%
 * (docs/design-v1-tool-options.md section 14), in a file of its own so
 * the CI shards can run it beside the others (options.e2e.ts has the rest).
 * It builds its own room, then checks 2b and 9 for what it ran.
 */
sweepFile("the player's sweeps", () => {
  sweepTest("player", 1);
  sweepTest("player", 1.3);
});
