import { computerSweepTest, sweepFile } from "./bardockRoom.ts";

/**
 * The docked token action bar, case 19: the computer's reach sweep at
 * 1280 x 800 and 1920 x 1080, in a file of its own so the CI shards can run it
 * beside the other half and the rest (bardock.e2e.ts). It builds its own
 * room, then checks case 20 for what it ran.
 */
sweepFile("the computer's sweep at 1280 x 800 and 1920 x 1080", () =>
  computerSweepTest([
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
  ]),
);
