import { playerRollTest, playerSweepFile } from "./reachRoom.ts";

/**
 * Short-screen reach, case 2: the player's roll at 130%, at every size,
 * fight, notice and tool, in a file of its own so the CI shards can run it
 * beside the others (reach.e2e.ts has the rest and says what each step
 * checks). It builds its own room, then checks case 5 for what it ran.
 */
playerSweepFile("the player's roll at 130%", () => playerRollTest(1.3));
