import { computerSweepTest, sweepFile } from "./bardockRoom.ts";

/**
 * The docked token action bar, case 19: the computer's reach sweep at
 * 1024 x 768 and 900 x 600, in a file of its own so the CI shards can run it
 * beside the other half and the rest (bardock.e2e.ts). It builds its own
 * room, then checks case 20 for what it ran.
 */
sweepFile("the computer's sweep at 1024 x 768 and 900 x 600", () =>
  computerSweepTest([
  { width: 1024, height: 768 },
  { width: 900, height: 600 },
  ]),
);
