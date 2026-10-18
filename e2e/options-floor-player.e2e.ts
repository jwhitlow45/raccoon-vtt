import { floorTest, sweepFile } from "./optionsRoom.ts";

/**
 * Tool options in one row, case 2: the sweep at the floor over the player's rooms
 * (docs/design-v1-tool-options.md section 14), in a file of its own so
 * the CI shards can run it beside the others (options.e2e.ts has the rest).
 * It builds its own room, then checks 2b and 9 for what it ran.
 */
sweepFile("the player's rooms at the floor", () => floorTest("player"));
