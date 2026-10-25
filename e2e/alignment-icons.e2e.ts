import { alignmentFile, fu30Tests, iconPassTests, noErrorsTest, roomTest } from "./alignmentRoom.ts";

/**
 * The alignment sweep's second icon pass, follow-up batch 30's roots,
 * whose round header steps run in the icon pass's fight, and the app
 * icon's places (e2e/alignmentRoom.ts says what they measure), in a file
 * of its own so the CI shards can run it beside alignment.e2e.ts. It
 * builds its own room.
 */
alignmentFile("the second icon pass, follow-up batch 30 and the app icon", () => {
  roomTest();
  iconPassTests();
  noErrorsTest();
  fu30Tests();
});
