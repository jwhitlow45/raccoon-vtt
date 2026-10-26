import { alignmentFile, fu30Tests, fu32Tests, iconPassTests, noErrorsTest, roomTest } from "./alignmentRoom.ts";

/**
 * The alignment sweep's second icon pass, follow-up batch 30's roots,
 * whose round header steps run in the icon pass's fight, the app icon's
 * places and follow-up batch 32's roots (e2e/alignmentRoom.ts says what
 * they measure), in a file of its own so the CI shards can run it beside
 * alignment.e2e.ts. It builds its own room.
 */
alignmentFile("the second icon pass, follow-up batches 30 and 32 and the app icon", () => {
  roomTest();
  iconPassTests();
  noErrorsTest();
  fu30Tests();
  fu32Tests();
});
